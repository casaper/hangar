import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { usesBitbucket, type PrState } from '../bitbucket.ts';
import { transcriptDirsForClone } from '../claude-sessions.ts';
import { requireDefaultBranch } from '../config/default-branch.ts';
import { CliError, run } from '../exec.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import {
  currentBranch,
  headReflog,
  inProgressOperation,
  isHangarReflogEntry,
  syncState,
  unpushedCommits,
  type ReflogEntry,
} from '../git.ts';
import type { Hangar } from '../hangar.ts';
import {
  prCacheIsStale,
  prCacheTtlSeconds,
  readCachedPr,
  refreshPullRequest,
  takePrRefreshLock,
} from '../pr-cache.ts';
import { claudeSessionsIn } from '../procs.ts';
import { tmuxServer, tmuxSessionName, type TmuxPane, type TmuxServer } from '../tmux.ts';
import { cloneLabel, confirm, heading, note, ok, step } from '../ui.ts';
import { landOnBranch } from './checkout-default.ts';
import { CLAUDE_ROLE, claudeWithPrompt, openOne, prepareOpen } from './open.ts';
import { closeClaudePane, collectEndedSessions, isIdleShell } from './reload.ts';

/**
 * `hangar jira-plan <KEY>` -- start a ticket in a free clone, in one command.
 *
 * Finds a clone nobody needs, puts it on an up-to-date default branch, arms the commit gate for
 * the ticket, and starts Claude Code there with `tracker.planPrompt` as its first prompt -- the
 * repo's own planning skill, which cuts the ticket's branch some minutes later and finds the gate
 * waiting for it.
 *
 * ## A fresh `claude` with a first prompt, not a line typed into a running one
 *
 * Hangar CAN submit a prompt to a live session -- `sync`'s `SYNC PAUSE` is two `send-keys`, the
 * text and then `Enter` -- but a planning run wants a clean context, and Claude Code names a
 * session's plan file after its first prompt. So whatever ran in the clone's Claude Code window is
 * ended (`reload --close-claude`'s step), and `claude '<prompt>'` is typed into the shell left
 * behind. A clone that is not open gets the same command as its Claude Code window's own.
 *
 * ## Which clone is free is a pure function of facts
 *
 * `judgeClone` decides and `pickFreeClone` ranks, so `-n` prints every clone's reason and the
 * suite pins the rules without a fleet. The rules refuse before they pick: a clone with ANY
 * uncommitted file, a half-applied rebase, a commit no remote has, or a Claude Code session this
 * command cannot reach is never free, whatever else is true of it -- each of those would either
 * lose somebody's work or stall the new agent on its first guard.
 */
export type JiraPlanOptions = {
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long a clone must sit untouched, weekends cut out, before it counts as free. */
export const STALE_AFTER_MS = 3 * DAY_MS;

/**
 * The milliseconds in `[fromMs, toMs)` that fall Monday 00:00 to Friday 24:00, local time. Pure.
 *
 * The weekend -- Saturday 00:00 to Sunday 24:00 -- is the only time cut out. There is no notion of
 * working hours: a weekday night counts in full, because a rule that knew office hours would be a
 * rule about one person's calendar, and wrong for everybody else's.
 *
 * Walked a local day at a time so a DST change shortens or lengthens the day it falls in, rather
 * than shifting every midnight after it.
 */
export const weekdayMsBetween = (fromMs: number, toMs: number): number => {
  let total = 0;
  let cursor = fromMs;
  while (cursor < toMs) {
    const day = new Date(cursor);
    const nextMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const end = Math.min(nextMidnight, toMs);
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) total += end - cursor;
    cursor = end;
  }
  return total;
};

/**
 * When somebody last touched the clone, in epoch ms, or undefined when nothing says.
 *
 * The newest of two traces: a Claude Code transcript written in it, and a HEAD reflog entry --
 * every checkout, commit, reset or rebase made there -- that this CLI did not write. `sync --all`
 * rebases every idle clone, and counting that would make the whole fleet look worked on that day;
 * `isHangarReflogEntry` is how it is told apart. Pure.
 */
export const lastActivityMs = (
  reflog: readonly ReflogEntry[],
  transcriptMs: number | undefined,
): number | undefined => {
  const own = reflog.find((entry) => !isHangarReflogEntry(entry.subject));
  const times = [own?.atMs, transcriptMs].filter((t): t is number => t !== undefined);
  return times.length === 0 ? undefined : Math.max(...times);
};

/** An armed-but-not-yet-locked commit gate, as `bin/hangar-commit-gate arm` writes it. */
export type ArmedGate = { readonly ticket: string; readonly atMs: number };

/** Everything `judgeClone` reads. */
export type CloneFacts = {
  readonly clone: Clone;
  readonly branch: string;
  readonly defaultBranch: string;
  /** Tracked modifications, and untracked files -- both stall the planning skill's own guard. */
  readonly dirty: number;
  readonly untracked: number;
  readonly pending: 'rebase' | 'merge' | undefined;
  /** Commits reachable from HEAD that no remote has. */
  readonly unpushed: number;
  /** The checked-out branch's pull request; undefined when there is none or nobody could say. */
  readonly prState: PrState | undefined;
  readonly lastActivityMs: number | undefined;
  /** Live Claude Code processes working in the clone. */
  readonly liveClaude: number;
  /** Whether every one of them runs in the clone's Claude Code window, where it can be ended. */
  readonly claudeReachable: boolean;
  /** Whether that window runs anything at all -- a session, or whatever else is in it. */
  readonly claudeWindowBusy: boolean;
  readonly armed: ArmedGate | undefined;
  /** This command is running inside the clone -- its tmux session, or its directory. */
  readonly isHere: boolean;
};

export type FreeKind = 'default-branch' | 'merged' | 'stale';

export type CloneVerdict =
  | { readonly clone: Clone; readonly free: false; readonly reason: string }
  | {
      readonly clone: Clone;
      readonly free: true;
      readonly kind: FreeKind;
      readonly reason: string;
      /** Taking it ends what is running in its Claude Code window. */
      readonly endsSession: boolean;
    };

const weekdays = (ms: number): string => (ms / DAY_MS).toFixed(1);

/**
 * Whether one clone is free for a new ticket, and why. Pure, exported, and the whole rule.
 *
 * The refusals come first and win over every reason to be free, because each one is somebody's
 * work or the new agent's first stop: the planning skill runs `git status --short` and asks
 * before branching off a tree with anything in it, untracked files included.
 */
export const judgeClone = (facts: CloneFacts, nowMs: number): CloneVerdict => {
  const { clone } = facts;
  const no = (reason: string): CloneVerdict => ({ clone, free: false, reason });

  if (facts.isHere) return no('this command is running in it');
  if (facts.pending !== undefined) return no(`a ${facts.pending} is in progress`);
  if (facts.dirty > 0 || facts.untracked > 0)
    return no(`${String(facts.dirty)} modified and ${String(facts.untracked)} untracked file(s)`);
  if (facts.unpushed > 0) return no(`${String(facts.unpushed)} commit(s) that no remote has`);
  if (facts.liveClaude > 0 && !facts.claudeReachable)
    return no('a live Claude Code session outside its Claude Code window, which this cannot end');
  if (facts.armed !== undefined && weekdayMsBetween(facts.armed.atMs, nowMs) < STALE_AFTER_MS)
    return no(`its commit gate is armed for ${facts.armed.ticket}, and that agent is not done`);

  const free = (kind: FreeKind, reason: string): CloneVerdict => ({
    clone,
    free: true,
    kind,
    reason,
    endsSession: facts.claudeWindowBusy,
  });
  if (facts.branch === facts.defaultBranch) return free('default-branch', `on ${facts.branch}`);
  if (facts.prState === 'merged') return free('merged', `${facts.branch}'s pull request is merged`);
  const idle =
    facts.lastActivityMs === undefined
      ? Number.POSITIVE_INFINITY
      : weekdayMsBetween(facts.lastActivityMs, nowMs);
  if (idle >= STALE_AFTER_MS)
    return free(
      'stale',
      facts.lastActivityMs === undefined
        ? `on ${facts.branch}, with no recorded activity`
        : `on ${facts.branch}, untouched for ${weekdays(idle)} weekdays`,
    );
  return no(
    `on ${facts.branch}${facts.prState === undefined ? '' : `, pull request ${facts.prState}`}, active ${weekdays(idle)} weekdays ago`,
  );
};

const KIND_RANK: Record<FreeKind, number> = { 'default-branch': 0, merged: 1, stale: 2 };

/**
 * The clone to take, or undefined. Pure.
 *
 * A clone whose Claude Code window is idle outranks every clone whose window would be ended, so
 * nobody's session is closed while another choice exists; then the default branch before a merged
 * pull request before a stale clone; then the lowest index.
 */
export const pickFreeClone = (verdicts: readonly CloneVerdict[]): FreeVerdict | undefined =>
  verdicts
    .filter((v): v is FreeVerdict => v.free)
    .sort(
      (a, b) =>
        Number(a.endsSession) - Number(b.endsSession) ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.clone.index - b.clone.index,
    )[0];

export type FreeVerdict = Extract<CloneVerdict, { readonly free: true }>;

/**
 * The ticket key, or a refusal. Pure.
 *
 * `tracker.keyPrefixes` is a whitelist when present; absent, the key only has to have the shape
 * the commit gate's `arm` accepts, which is the one consumer that cannot take anything else.
 */
export const ticketKeyProblem = (
  key: string,
  prefixes: readonly string[] | undefined,
): string | undefined => {
  const match = /^([A-Z][A-Z0-9]+)-\d+$/.exec(key);
  if (match === null) return `${key} is not a ticket key — expected something like ABC-123`;
  if (prefixes !== undefined && prefixes.length > 0 && !prefixes.includes(match[1] ?? ''))
    return `${key} is not one of this hangar's tickets — tracker.keyPrefixes is ${prefixes.join(', ')}`;
  return undefined;
};

/** `tracker.planPrompt` with the key in place. Pure. */
export const planPromptFor = (template: string, key: string): string =>
  template.replaceAll('{key}', key);

// --- reading the fleet --------------------------------------------------------------------------

const newestTranscriptMs = (clone: Clone): number | undefined => {
  let newest: number | undefined;
  for (const dir of transcriptDirsForClone(clone)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const mtime = statSync(join(dir, name)).mtimeMs;
        if (newest === undefined || mtime > newest) newest = mtime;
      } catch {
        // Gone between the listing and the stat: not activity.
      }
    }
  }
  return newest;
};

/** The gate state file, read as data. The script is its only writer. */
const readArmedGate = (hangar: Hangar, clone: Clone): ArmedGate | undefined => {
  const path = join(hangar.root, '.hangar', 'commit-gate', `${basename(clone.path)}.json`);
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      armed?: unknown;
      locked?: unknown;
      ticket?: unknown;
      armed_at?: unknown;
    };
    if (state.armed !== true || state.locked === true || typeof state.ticket !== 'string')
      return undefined;
    const atMs = typeof state.armed_at === 'string' ? Date.parse(state.armed_at) : Number.NaN;
    return { ticket: state.ticket, atMs: Number.isNaN(atMs) ? 0 : atMs };
  } catch {
    return undefined;
  }
};

const bareTty = (tty: string | undefined): string | undefined => tty?.replace(/^\/dev\//, '');

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

type Gathered = { readonly facts: CloneFacts; readonly claudePane: TmuxPane | undefined };

const gather = (
  hangar: Hangar,
  clone: Clone,
  server: TmuxServer,
  defaultBranch: string,
): Gathered => {
  const state = syncState(clone.path);
  const sessions = claudeSessionsIn(clone.path);
  const panes = server.hasSession(clone) ? server.panes(clone) : [];
  const claudePane = panes.find((pane) => pane.role === CLAUDE_ROLE);
  const paneTty = bareTty(claudePane?.tty);
  return {
    claudePane,
    facts: {
      clone,
      branch: currentBranch(clone.path),
      defaultBranch,
      dirty: state.dirty,
      untracked: state.untracked,
      pending: inProgressOperation(clone.path),
      unpushed: unpushedCommits(clone.path),
      prState: undefined,
      lastActivityMs: lastActivityMs(headReflog(clone.path), newestTranscriptMs(clone)),
      liveClaude: sessions.length,
      claudeReachable: paneTty !== undefined && sessions.every((s) => bareTty(s.tty) === paneTty),
      claudeWindowBusy:
        sessions.length > 0 || (claudePane !== undefined && !isIdleShell(claudePane)),
      armed: readArmedGate(hangar, clone),
      isHere:
        server.currentSession() === tmuxSessionName(clone) || isInside(process.cwd(), clone.path),
    },
  };
};

/** How long the pull-request lookups may take, all clones together. */
const PR_DEADLINE_MS = 5000;

/**
 * The pull request of every clone that could only be free by it. A merged record is final, so a
 * cached one is trusted at any age; anything else past the TTL is asked again, under the bar's
 * own lock and through `refreshPullRequest`, the cache's one writer.
 */
const withPullRequests = async (
  hangar: Hangar,
  gathered: readonly Gathered[],
  dryRun: boolean,
): Promise<Gathered[]> => {
  if (!usesBitbucket(hangar.config.forge)) return [...gathered];
  const ttl = prCacheTtlSeconds(hangar);
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, PR_DEADLINE_MS);
  const result = await Promise.all(
    gathered.map(async (g): Promise<Gathered> => {
      const { facts } = g;
      if (facts.branch === facts.defaultBranch) return g;
      // Only a clone every refusal has passed is worth a network call: judged as if merged, a
      // clone that is still not free is refused by something no pull request can change.
      if (!judgeClone({ ...facts, prState: 'merged' }, Date.now()).free) return g;
      const cached = readCachedPr(hangar, facts.clone, facts.branch);
      if (cached !== undefined && (cached.state === 'merged' || !prCacheIsStale(cached, ttl)))
        return { ...g, facts: { ...facts, prState: cached.id === 0 ? undefined : cached.state } };
      const release = dryRun ? () => undefined : takePrRefreshLock(hangar, facts.clone);
      if (release === undefined) return g;
      try {
        const found = await refreshPullRequest(hangar, facts.clone, facts.branch, {
          signal: deadline.signal,
          write: !dryRun,
        });
        const record = found.record;
        return record === undefined || record.id === 0
          ? g
          : { ...g, facts: { ...facts, prState: record.state } };
      } finally {
        release();
      }
    }),
  );
  clearTimeout(timer);
  return result;
};

// --- acting -------------------------------------------------------------------------------------

const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Wait for every Claude Code process in the clone to exit. False when one is still there. */
const awaitNoClaude = (clone: Clone, timeoutMs: number): boolean => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (claudeSessionsIn(clone.path).length === 0) return true;
    if (Date.now() >= until) return false;
    sleepMs(200);
  }
};

const armGate = (hangar: Hangar, clone: Clone, key: string): void => {
  const res = run(process.execPath, [hangar.paths.commitGate, 'arm', '--ticket', key], {
    cwd: clone.path,
  });
  if (!res.ok) {
    throw new CliError(
      `${clone.name}: the commit gate could not be armed for ${key}`,
      (res.stderr || res.stdout).trim() || undefined,
    );
  }
  ok(`${clone.name}: commit gate armed for ${key} — it locks the ticket's branch once it is cut`);
};

export const jiraPlan = async (
  hangar: Hangar,
  key: string,
  opts: JiraPlanOptions,
): Promise<void> => {
  const dryRun = opts.dryRun === true;
  const tracker = hangar.config.tracker;
  const template = tracker.planPrompt;
  if (template === undefined) {
    throw new CliError(
      'tracker.planPrompt is not set, so there is nothing to start the agent with',
      'Set it in hangar.config.yaml to the repo’s own planning prompt, with {key} where the ticket goes — e.g. `planPrompt: /plan-ticket {key}`.',
    );
  }
  const problem = ticketKeyProblem(key, tracker.kind === 'none' ? undefined : tracker.keyPrefixes);
  if (problem !== undefined) throw new CliError(problem);
  const claudeTab = hangar.config.terminal.tabs.find(
    (tab) => tab.role === CLAUDE_ROLE && tab.command !== undefined,
  );
  if (claudeTab?.command === undefined) {
    throw new CliError(
      `terminal.tabs has no \`${CLAUDE_ROLE}\` window with a command, so there is nowhere to start the agent`,
    );
  }
  const prompt = planPromptFor(template, key);

  const context = dryRun ? undefined : prepareOpen(hangar, {});
  const server = context?.server ?? tmuxServer(hangar);
  const defaultBranch = requireDefaultBranch(hangar, { persist: !dryRun });

  heading(`A free clone for ${key}`);
  const gathered = await withPullRequests(
    hangar,
    discoverClones(hangar).map((clone) => gather(hangar, clone, server, defaultBranch)),
    dryRun,
  );
  const nowMs = Date.now();
  const verdicts = gathered.map((g) => judgeClone(g.facts, nowMs));
  for (const verdict of verdicts) {
    const mark = verdict.free ? 'free' : 'busy';
    note(`${cloneLabel(verdict.clone)}  ${mark}: ${verdict.reason}`);
  }
  const chosen = pickFreeClone(verdicts);
  if (chosen === undefined) {
    throw new CliError(
      `no clone is free for ${key}`,
      'Each clone’s reason is above. Free means on the default branch, a merged pull request, or untouched for 3 weekdays — and nothing uncommitted, nothing unpushed.',
    );
  }
  const { clone } = chosen;
  const found = gathered.find((g) => g.facts.clone.index === clone.index);
  const claudePane = found?.claudePane;
  const typed = claudeWithPrompt(claudeTab.command, prompt);

  heading(`${key} in ${cloneLabel(clone)}`);
  const plan = [
    ...(chosen.endsSession && claudePane !== undefined
      ? [`end what runs in ${clone.name}'s ${CLAUDE_ROLE} window, and leave a shell there`]
      : []),
    `put ${clone.name} on ${defaultBranch}, fetched and up to date`,
    `arm the commit gate for ${key}`,
    claudePane === undefined
      ? `open ${clone.name} with \`${typed}\` in its ${CLAUDE_ROLE} window`
      : `run \`${typed}\` in its ${CLAUDE_ROLE} window, and bring the clone forward`,
  ];
  for (const line of plan) step(dryRun ? `would ${line}` : line);
  if (dryRun || context === undefined) {
    note('(dry run — no session was ended, no branch moved, nothing armed or started)');
    return;
  }

  if (chosen.endsSession && opts.yes !== true) {
    const since =
      found?.facts.lastActivityMs === undefined
        ? ''
        : `, last active ${new Date(found.facts.lastActivityMs).toLocaleString()}`;
    if (
      !confirm(
        `End what runs in ${clone.name}'s ${CLAUDE_ROLE} window${since}, and start ${key} there?`,
      )
    ) {
      note('nothing was changed');
      return;
    }
  }

  if (chosen.endsSession && claudePane !== undefined) {
    if (!closeClaudePane(server, clone, claudePane.id))
      throw new CliError(`${clone.name}: could not end Claude Code in ${claudePane.id}`);
    if (!awaitNoClaude(clone, 5000)) {
      throw new CliError(
        `${clone.name}: Claude Code is still running after its window was respawned`,
        'Nothing else was changed. Close it yourself and run this again.',
      );
    }
    ok(`${clone.name}: Claude Code ended, a fresh shell in its ${CLAUDE_ROLE} window`);
    collectEndedSessions(hangar);
  }

  const landed = (() => {
    try {
      return landOnBranch(hangar, clone, {}, false);
    } catch (error) {
      if (chosen.endsSession)
        note(`${clone.name}'s Claude Code was already ended; its window is a shell.`);
      throw error;
    }
  })();
  if (landed !== 'done') {
    throw new CliError(
      `${clone.name} did not land on ${defaultBranch}, so ${key} was not started`,
      'Its state is above. Nothing was armed and no agent was started.',
    );
  }

  armGate(hangar, clone, key);

  if (claudePane !== undefined) {
    if (!server.typeInPane(claudePane.id, typed))
      throw new CliError(`${clone.name}: could not start Claude Code in ${claudePane.id}`);
    ok(`${clone.name}: started \`${typed}\``);
  }
  openOne(hangar, clone, { firstPrompt: prompt }, context);
};
