import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { openPullRequests, repoRef } from '../bitbucket.ts';
import { tryDefaultBranch } from '../config/default-branch.ts';
import { CliError } from '../exec.ts';
import type { Clone } from '../fleet.ts';
import {
  conflictedFiles,
  currentBranch,
  DETACHED,
  fetchArgs,
  git,
  gitTry,
  inProgressOperation,
  refExists,
  settleResolved,
  stashList,
  SYNC_STASH_LABEL,
  syncState,
} from '../git.ts';
import type { Hangar } from '../hangar.ts';
import {
  cwdsOf,
  isAlive,
  processTable,
  sessionsBesidesCaller,
  type ClaudeSession,
  type ProcessRow,
} from '../procs.ts';
import { hasConflictMarkers } from '../resolve-conflicts.ts';
import { fail, heading, note, ok, step, warn } from '../ui.ts';
import { forgeClone } from './pr.ts';
import {
  chooseStrategy,
  describeTarget,
  fetchRemotesFor,
  notifySessions,
  resolveTarget,
  siblingNamesOf,
} from './sync.ts';

/**
 * `hangar catch-up` -- bring the branch a clone session is working on up to date with what it
 * will be merged into, from INSIDE that session, without losing its uncommitted diff.
 *
 * It is `sync`'s mechanics with three differences, each the reason it is a command of its own:
 *
 * 1. It always REBASES. It is for a working branch nobody else has seen, which is also why it
 *    refuses a branch that is already on origin (exit 3): rewriting a published branch is a
 *    decision for the person, taken through `hangar pr rebranch`, not a default.
 * 2. Every conflict, from the rebase or from re-applying the stash, goes back to the CALLER
 *    (exit 4), never to a headless resolver. The caller is a clone session with the repo's own
 *    skills, agents and tooling -- a regenerated lockfile, a test suite only its specialist may
 *    touch -- and none of that reaches a `claude -p` with four read-only git tools. It resolves
 *    the files and runs `--continue`, which also keeps every invocation to seconds rather than
 *    minutes, inside a tool call's time limit.
 * 3. It never asks. It is run by an agent through a tool with no terminal, where `confirm()`
 *    would decline every time; everything that would be a question is an exit code instead.
 *
 * What survives between invocations is the LEDGER, under the clone's git directory: never
 * stashed, never tracked, and written only from here. Everything else is read back off git.
 */
export type CatchUpOptions = {
  continue?: boolean | undefined;
  abort?: boolean | undefined;
  onto?: string | undefined;
  dryRun?: boolean | undefined;
};

/** The exit codes the calling skill branches on. Anything else non-zero is an error. */
export const CATCH_UP_EXIT = { done: 0, published: 3, conflicts: 4, busy: 5 } as const;
export type CatchUpExit = (typeof CATCH_UP_EXIT)[keyof typeof CATCH_UP_EXIT] | 1;

/**
 * Under `hangar-sync` on purpose: `syncStashes` then finds a catch-up stash nobody gave back,
 * so `hangar status` reports it exactly as it reports one of sync's.
 */
export const CATCH_UP_STASH_LABEL = `${SYNC_STASH_LABEL} (catch-up)`;

type Phase = 'rebase' | 'stash';

export type Ledger = {
  readonly version: 1;
  phase: Phase;
  readonly branch: string;
  readonly targetRef: string;
  /** HEAD before the rebase -- the stash's own base, and where `--abort` puts the branch back. */
  readonly oldHead: string;
  /** Undefined when there was nothing to stash. */
  readonly stashLabel: string | undefined;
  /** False while the stash has not been applied yet (a retry is pending). */
  applied: boolean;
  conflicted: string[];
  readonly paused: readonly { readonly pid: number; readonly tty: string | undefined }[];
  readonly startedAt: string;
};

// ---------------------------------------------------------------------------------------------
// Pure: what is said, and what is decided

/** The line typed into every OTHER live session in the clone before anything moves. */
export const catchUpPauseMessage = (targetRef: string): string =>
  'SYNC PAUSE — STOP what you are doing and do not edit, stage or commit any file. ' +
  `\`hangar catch-up\` is about to rebase this clone onto ${targetRef} and put the uncommitted ` +
  'changes back on top. Another session in this clone started it and will resolve any ' +
  'conflicts itself — do not touch them. Exactly one line beginning SYNC FINISHED or SYNC ' +
  'ABORTED will follow this one; nothing else will. Reply that you have paused, then wait for it.';

/** The one closing line every paused session gets. */
export const catchUpClosingMessage = (
  kind: 'finished' | 'aborted',
  targetRef: string,
  treeAsBefore: boolean,
): string =>
  kind === 'finished'
    ? `SYNC FINISHED — this clone was rebased onto ${targetRef} and the uncommitted changes are ` +
      'back in the working tree. You can resume, but re-read any file you had in flight first.'
    : treeAsBefore
      ? `SYNC ABORTED — the rebase onto ${targetRef} was abandoned and the working tree is as it ` +
        'was. You can resume.'
      : `SYNC ABORTED — the rebase onto ${targetRef} was abandoned, and the working tree is NOT ` +
        'back as it was. Do not edit, stage or commit anything; tell the user, and wait.';

export const publishedMessage = (
  branch: string,
  onOrigin: boolean,
  pr: { id: number; url: string } | undefined,
): string =>
  [
    `${branch} is already published —`,
    [
      onOrigin ? 'it is on origin' : undefined,
      pr === undefined ? undefined : `pull request #${String(pr.id)} is open (${pr.url})`,
    ]
      .filter((part) => part !== undefined)
      .join(', and '),
    '— so rebasing it would rewrite history others can see. Nothing was changed.',
    'Rebasing anyway means `hangar pr rebranch` first; that is the user’s decision.',
  ].join(' ');

export const conflictsMessage = (
  phase: Phase,
  files: readonly string[],
  replaying: string | undefined,
): string =>
  [
    phase === 'rebase'
      ? `the rebase stopped on conflicts${replaying === undefined ? '' : ` while replaying ${replaying}`}`
      : 're-applying the uncommitted changes on top of the rebased branch conflicted',
    ...files.map((file) => `  ${file}`),
    'Resolve every conflict marker in those files, without staging, committing or running git ' +
      'yourself, then run `hangar catch-up --continue`. `hangar catch-up --abort` puts ' +
      'everything back as it was before the catch-up.',
  ].join('\n');

export const applyFailedMessage = (stashRef: string, reason: string): string =>
  `re-applying the uncommitted changes failed before any conflict: ${reason}\n` +
  `They are safe in ${stashRef}. Fix what git names (an untracked file in the way, usually), ` +
  'then `hangar catch-up --continue` retries the apply.';

export type Staging = 'kept' | 'partial' | 'none' | 'nothing-stashed';

export const doneMessage = (targetRef: string, rebased: boolean, staging: Staging): string => {
  const moved = rebased
    ? `rebased onto ${targetRef}`
    : `already contained ${targetRef}, so nothing was rebased`;
  const back: Record<Staging, string> = {
    kept: 'the uncommitted changes are back, staged exactly as before',
    partial:
      'the uncommitted changes are back; what was staged is staged again wherever the update ' +
      'left that file alone, and unstaged everywhere else',
    none: 'the uncommitted changes are back, unstaged',
    'nothing-stashed': 'there were no uncommitted changes to put back',
  };
  return `${moved}; ${back[staging]}.`;
};

/**
 * What a path's index entry becomes after a plain (non-`--index`) apply. PURE.
 *
 * A plain apply loses the developer's staging, and a CONFLICTED one does worse: every path it
 * merged cleanly comes back fully staged, including the half nobody staged (measured on git
 * 2.56). So every path is set deliberately. The staged version in the stash's index commit is
 * only valid where HEAD's copy of the file is still the one it was staged against; anywhere the
 * update touched the file it describes a base that is gone, and unstaged is the honest answer.
 */
export const restageDecision = (path: {
  readonly conflicted: boolean;
  readonly stagedBefore: boolean;
  readonly unchangedByUpdate: boolean;
  readonly inHead: boolean;
}): 'from-stash-index' | 'unstage' | 'leave' => {
  if (path.conflicted) return 'leave';
  if (path.stagedBefore && path.unchangedByUpdate) return 'from-stash-index';
  return path.inHead ? 'unstage' : 'leave';
};

/**
 * Test runners whose cwd is inside the clone, and which write into it while they run. PURE.
 *
 * A long-lived server only names a runner: an editor's `playwright test-server`, the session's
 * own `@playwright/mcp` and the browsers under `ms-playwright/` never exit on their own, so
 * counting them refused nearly every catch-up until somebody killed them by hand.
 */
const RUNNER = /\b(playwright|vitest|jest|karma|cypress)\b/;
const NOT_A_RUN =
  /\b(show-report|show-trace|merge-reports|codegen|test-server|run-server|run-driver|launch-server)\b|--ui\b|@playwright\/mcp\/|ms-playwright\//;

const isRunnerCommand = (command: string): boolean =>
  RUNNER.test(command) && !NOT_A_RUN.test(command);

export const busyRunners = (
  rows: Iterable<ProcessRow>,
  cwds: ReadonlyMap<number, string>,
  clonePath: string,
): ProcessRow[] =>
  [...rows].filter((row) => {
    if (!isRunnerCommand(row.command)) return false;
    const cwd = cwds.get(row.pid);
    return cwd !== undefined && (cwd === clonePath || cwd.startsWith(`${clonePath}/`));
  });

// ---------------------------------------------------------------------------------------------
// The ledger

const ledgerPath = (repo: string): string => {
  const raw = gitTry(repo, ['rev-parse', '--git-path', 'hangar/catch-up.json']);
  if (raw === undefined) throw new CliError(`${repo} is not a git repository`);
  return isAbsolute(raw) ? raw : join(repo, raw);
};

const readLedger = (repo: string): Ledger | undefined => {
  const path = ledgerPath(repo);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Ledger;
};

const writeLedger = (repo: string, ledger: Ledger): void => {
  const path = ledgerPath(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
};

const dropLedger = (repo: string): void => {
  rmSync(ledgerPath(repo), { force: true });
};

// ---------------------------------------------------------------------------------------------
// Git, step by step

/** `stash@{N}` for this run's stash, found by its full label -- never by position. */
const stashRefFor = (repo: string, label: string | undefined): string | undefined =>
  label === undefined
    ? undefined
    : stashList(repo).find((entry) => entry.message.endsWith(label))?.ref;

const lines = (out: string | undefined): string[] =>
  out === undefined || out === '' ? [] : out.split('\n');

/** The commit a stopped rebase is replaying, as `abc1234 subject`, when git says. */
const replayingCommit = (repo: string): string | undefined =>
  gitTry(repo, ['log', '-1', '--format=%h %s', 'REBASE_HEAD']);

/**
 * Put every non-conflicted path's index entry where `restageDecision` says. Returns whether
 * anything staged was given back.
 */
const restage = (
  repo: string,
  stashRef: string,
  oldHead: string,
  conflicted: readonly string[],
): boolean => {
  const stagedBefore = new Set(
    lines(gitTry(repo, ['diff', '--name-only', `${stashRef}^1`, `${stashRef}^2`])),
  );
  const touched = new Set([
    ...stagedBefore,
    ...lines(gitTry(repo, ['diff', '--name-only', `${stashRef}^1`, stashRef])),
  ]);
  const fromIndex: string[] = [];
  const unstage: string[] = [];
  for (const path of touched) {
    const decision = restageDecision({
      conflicted: conflicted.includes(path),
      stagedBefore: stagedBefore.has(path),
      unchangedByUpdate: git(repo, ['diff', '--quiet', oldHead, 'HEAD', '--', path]).ok,
      inHead: git(repo, ['cat-file', '-e', `HEAD:${path}`]).ok,
    });
    if (decision === 'from-stash-index') fromIndex.push(path);
    else if (decision === 'unstage') unstage.push(path);
  }
  if (unstage.length > 0) git(repo, ['reset', '-q', '--', ...unstage]);
  if (fromIndex.length === 0) return false;
  // `--index-info` takes `ls-tree` lines verbatim; a path the stash's index DELETED has none,
  // and gets mode 0, which removes the entry -- a staged deletion, staged again.
  const listed = gitTry(repo, ['ls-tree', `${stashRef}^2`, '--', ...fromIndex]) ?? '';
  const present = new Set(lines(listed).map((line) => line.slice(line.indexOf('\t') + 1)));
  const removals = fromIndex
    .filter((path) => !present.has(path))
    .map((path) => `0 ${'0'.repeat(40)}\t${path}`);
  const input = [...lines(listed), ...removals].join('\n');
  return input === ''
    ? false
    : git(repo, ['update-index', '--index-info'], { input: `${input}\n` }).ok;
};

type Reapplied =
  | { kind: 'done'; staging: Staging }
  | { kind: 'conflicts'; files: string[] }
  | { kind: 'failed'; stashRef: string; reason: string };

/**
 * Put the stash back: `--index` first, which keeps the staging exactly; a plain apply when that
 * cannot work. Measured on git 2.56, the two ways `--index` fails are different states: a
 * conflict in the INDEX refuses with exit 128 and touches nothing, while a conflict only in the
 * work tree applies everything else, says "Index was not unstashed", and leaves exactly what a
 * conflicted plain apply would have.
 */
const reapply = (repo: string, ledger: Ledger): Reapplied => {
  const stashRef = stashRefFor(repo, ledger.stashLabel);
  if (ledger.stashLabel === undefined) return { kind: 'done', staging: 'nothing-stashed' };
  if (stashRef === undefined) {
    throw new CliError(
      `the catch-up stash ("${ledger.stashLabel}") is no longer in the stash list`,
      'Something dropped it. Check `git stash list` and `git fsck --unreachable | grep commit`.',
    );
  }
  const withIndex = git(repo, ['stash', 'apply', '--index', stashRef]);
  let conflicts = conflictedFiles(repo);
  if (withIndex.ok && conflicts.length === 0) {
    git(repo, ['stash', 'drop', stashRef]);
    return { kind: 'done', staging: 'kept' };
  }
  if (conflicts.length === 0) {
    const plain = git(repo, ['stash', 'apply', stashRef]);
    conflicts = conflictedFiles(repo);
    if (!plain.ok && conflicts.length === 0) {
      return { kind: 'failed', stashRef, reason: plain.stderr.trim() || withIndex.stderr.trim() };
    }
  }
  const restaged = restage(repo, stashRef, ledger.oldHead, conflicts);
  if (conflicts.length > 0) return { kind: 'conflicts', files: conflicts };
  git(repo, ['stash', 'drop', stashRef]);
  return { kind: 'done', staging: restaged ? 'partial' : 'none' };
};

// ---------------------------------------------------------------------------------------------
// The sessions paused for this run

const liveOf = (paused: Ledger['paused']): ClaudeSession[] =>
  paused
    .filter((s) => isAlive(s.pid))
    .map((s) => ({ pid: s.pid, tty: s.tty, cwd: '', startedAtMs: undefined }));

const closePaused = (
  hangar: Hangar,
  ledger: Pick<Ledger, 'paused' | 'targetRef'>,
  kind: 'finished' | 'aborted',
  treeAsBefore: boolean,
): void => {
  const live = liveOf(ledger.paused);
  if (live.length === 0) return;
  try {
    notifySessions(hangar, live, catchUpClosingMessage(kind, ledger.targetRef, treeAsBefore));
  } catch (error) {
    warn(`could not tell the paused session(s) how this ended: ${String(error)}`);
  }
};

// ---------------------------------------------------------------------------------------------
// The three entry points

const finishOrStop = (
  hangar: Hangar,
  clone: Clone,
  ledger: Ledger,
  rebased: boolean,
): CatchUpExit => {
  const back = reapply(clone.path, ledger);
  if (back.kind === 'conflicts') {
    writeLedger(clone.path, { ...ledger, phase: 'stash', applied: true, conflicted: back.files });
    fail(conflictsMessage('stash', back.files, undefined));
    return CATCH_UP_EXIT.conflicts;
  }
  if (back.kind === 'failed') {
    writeLedger(clone.path, { ...ledger, phase: 'stash', applied: false, conflicted: [] });
    fail(applyFailedMessage(back.stashRef, back.reason));
    return CATCH_UP_EXIT.conflicts;
  }
  dropLedger(clone.path);
  closePaused(hangar, ledger, 'finished', false);
  ok(doneMessage(ledger.targetRef, rebased, back.staging));
  return CATCH_UP_EXIT.done;
};

const start = async (hangar: Hangar, clone: Clone, opts: CatchUpOptions): Promise<CatchUpExit> => {
  const repo = clone.path;
  const branch = currentBranch(repo);
  if (branch === DETACHED)
    throw new CliError(`${clone.name}: detached HEAD — no branch to catch up`);
  if (branch === tryDefaultBranch(hangar)) {
    throw new CliError(
      `${clone.name}: on the default branch (${branch}) — catch-up is for a working branch`,
      '`hangar checkout-default` fast-forwards the default branch itself.',
    );
  }
  const pending = inProgressOperation(repo);
  if (pending !== undefined) {
    throw new CliError(
      `${clone.name} is in the middle of a ${pending}`,
      'Finish or abandon it first — catch-up would bury it under a stash.',
    );
  }
  if (readLedger(repo) !== undefined) {
    throw new CliError(
      `${clone.name}: a catch-up is already under way here`,
      'Run `hangar catch-up --continue` once its conflicts are resolved, or `--abort`.',
    );
  }
  const leftover = stashList(repo).find((entry) => entry.message.includes(CATCH_UP_STASH_LABEL));
  if (leftover !== undefined) {
    throw new CliError(
      `${clone.name}: ${leftover.ref} is a catch-up stash nobody gave back (${leftover.age})`,
      'Apply or drop it by hand first, so two runs’ changes never mix.',
    );
  }

  const table = processTable();
  // `lsof` only for what could be a runner: asking it about every pid on the machine is slow.
  const candidates = [...table.values()].filter((r) => isRunnerCommand(r.command));
  const runners = busyRunners(candidates, cwdsOf(candidates.map((r) => r.pid)), repo);
  if (runners.length > 0) {
    fail(
      `a test run is still writing into this clone, and stashing under it would lose its output:`,
    );
    for (const row of runners) note(`  pid ${String(row.pid)}  ${row.command.slice(0, 120)}`);
    note('Let it finish or stop it, then run `hangar catch-up` again.');
    return CATCH_UP_EXIT.busy;
  }

  // Published? Asked live -- a stale `origin/<branch>` ref answers both ways wrongly.
  const remote = git(repo, ['ls-remote', '--exit-code', '--heads', 'origin', branch]);
  if (!remote.ok && remote.code !== 2) {
    throw new CliError(`could not ask origin whether ${branch} is there`, remote.stderr.trim());
  }
  const lookup = await openPullRequests(hangar, repoRef(hangar, repo), branch);
  if (!lookup.ok) warn(`could not ask the forge about pull requests: ${lookup.reason}`);
  const pr = lookup.ok ? lookup.pullRequests[0] : undefined;
  if (remote.ok || pr !== undefined) {
    fail(publishedMessage(branch, remote.ok, pr));
    return CATCH_UP_EXIT.published;
  }

  const target = await resolveTarget(hangar, clone, branch, {
    onto: opts.onto,
    dryRun: opts.dryRun,
  });
  describeTarget(hangar, clone, target);
  const others = sessionsBesidesCaller(repo);
  const state = syncState(repo);

  if (opts.dryRun === true) {
    note(`branch:   ${branch} (not on origin, no pull request)`);
    note(`rebase:   onto ${target.ref}`);
    note(
      `worktree: ${state.dirty} modified, ${state.untracked} untracked — stashed and re-applied`,
    );
    note(
      `pause:    ${others.length === 0 ? 'no other session' : others.map((s) => `pid ${s.pid}`).join(', ')}`,
    );
    note('(dry run — nothing was changed)');
    return CATCH_UP_EXIT.done;
  }

  const paused =
    others.length === 0 ? [] : notifySessions(hangar, others, catchUpPauseMessage(target.ref));
  if (paused.length < others.length) {
    warn('some other session in this clone could not be told to pause — it was not asked about');
  }
  const ledger: Ledger = {
    version: 1,
    phase: 'rebase',
    branch,
    targetRef: target.ref,
    oldHead: gitTry(repo, ['rev-parse', 'HEAD']) ?? '',
    stashLabel: undefined,
    applied: false,
    conflicted: [],
    paused: paused.map((s) => ({ pid: s.pid, tty: s.tty })),
    startedAt: new Date().toISOString(),
  };

  let stashLabel: string | undefined;
  if (state.dirty > 0 || state.untracked > 0) {
    stashLabel = `${CATCH_UP_STASH_LABEL} ${ledger.startedAt}`;
    const res = git(repo, ['stash', 'push', '--include-untracked', '-m', stashLabel]);
    if (!res.ok) {
      closePaused(hangar, ledger, 'aborted', true);
      throw new CliError(`could not stash ${clone.name}`, res.stderr.trim());
    }
    ok(`stashed ${state.dirty + state.untracked} file(s)`);
  }
  const run: Ledger = { ...ledger, stashLabel };

  const restoreAndThrow = (error: CliError): never => {
    const ref = stashRefFor(repo, stashLabel);
    const back =
      ref === undefined ||
      git(repo, ['stash', 'pop', '--index', ref]).ok ||
      git(repo, ['stash', 'pop', ref]).ok;
    closePaused(hangar, run, 'aborted', back);
    throw error;
  };

  const fetchArgv = fetchArgs(fetchRemotesFor(target.ref, siblingNamesOf(hangar, clone)));
  step(`git ${fetchArgv.join(' ')}`);
  const fetched = git(repo, fetchArgv);
  if (!fetched.ok)
    restoreAndThrow(new CliError(`fetch failed in ${clone.name}`, fetched.stderr.trim()));
  if (!refExists(repo, target.ref)) {
    restoreAndThrow(new CliError(`${target.ref} does not exist, even after fetching`));
  }

  const rebased = chooseStrategy(clone, target).kind !== 'up-to-date';
  if (rebased) {
    step(`git rebase ${target.ref}`);
    const res = git(repo, ['rebase', target.ref]);
    if (!res.ok) {
      const files = conflictedFiles(repo);
      if (inProgressOperation(repo) === 'rebase' && files.length > 0) {
        writeLedger(repo, { ...run, conflicted: files });
        fail(conflictsMessage('rebase', files, replayingCommit(repo)));
        return CATCH_UP_EXIT.conflicts;
      }
      if (inProgressOperation(repo) === 'rebase') git(repo, ['rebase', '--abort']);
      restoreAndThrow(
        new CliError(
          `the rebase onto ${target.ref} did not start`,
          res.stderr.trim() || res.stdout.trim(),
        ),
      );
    }
    ok(`rebased onto ${target.ref}`);
  } else {
    ok(`already contains ${target.ref}`);
  }
  return finishOrStop(hangar, clone, { ...run, phase: 'stash' }, rebased);
};

const proceed = (hangar: Hangar, clone: Clone, ledger: Ledger): CatchUpExit => {
  const repo = clone.path;
  if (inProgressOperation(repo) === 'rebase') {
    const unmerged = conflictedFiles(repo);
    const marked = hasConflictMarkers(repo, unmerged.length > 0 ? unmerged : ledger.conflicted);
    if (marked.length > 0) {
      fail(`conflict markers remain in:\n${marked.map((f) => `  ${f}`).join('\n')}`);
      return CATCH_UP_EXIT.conflicts;
    }
    // `-u`, never `-A`: it stages every unmerged path (deletions included), and an untracked
    // scratch file the session left while resolving stays out of the commit being replayed.
    git(repo, ['add', '-u']);
    step('git rebase --continue');
    git(repo, ['rebase', '--continue']);
    if (inProgressOperation(repo) === 'rebase') {
      const files = conflictedFiles(repo);
      if (files.length === 0) {
        throw new CliError(
          'rebase --continue stopped with nothing conflicted',
          'Run `git status` to see why, or `hangar catch-up --abort`.',
        );
      }
      writeLedger(repo, { ...ledger, conflicted: files });
      fail(conflictsMessage('rebase', files, replayingCommit(repo)));
      return CATCH_UP_EXIT.conflicts;
    }
    ok(`rebased onto ${ledger.targetRef}`);
    return finishOrStop(hangar, clone, { ...ledger, phase: 'stash', conflicted: [] }, true);
  }
  if (ledger.phase === 'rebase' || !ledger.applied) {
    return finishOrStop(hangar, clone, { ...ledger, phase: 'stash', conflicted: [] }, true);
  }

  const marked = hasConflictMarkers(repo, ledger.conflicted);
  if (marked.length > 0) {
    fail(`conflict markers remain in:\n${marked.map((f) => `  ${f}`).join('\n')}`);
    return CATCH_UP_EXIT.conflicts;
  }
  if (!settleResolved(repo, ledger.conflicted) || conflictedFiles(repo).length > 0) {
    throw new CliError(
      'the resolved files could not be marked resolved',
      `Still unmerged: ${conflictedFiles(repo).join(', ')}`,
    );
  }
  const ref = stashRefFor(repo, ledger.stashLabel);
  if (ref !== undefined) git(repo, ['stash', 'drop', ref]);
  dropLedger(repo);
  closePaused(hangar, ledger, 'finished', false);
  ok(doneMessage(ledger.targetRef, true, 'partial'));
  return CATCH_UP_EXIT.done;
};

/**
 * Back to the moment before the catch-up: the branch where it was, the stash re-applied.
 *
 * Mid-rebase that is `rebase --abort`. Once the rebase is done the branch has to be MOVED back
 * (`reset --hard` to the recorded head), which discards whatever conflict resolution was done
 * -- the original changes are all in the stash, which is checked to exist before anything is
 * thrown away, and the untracked files the half-done apply restored are removed so the re-apply
 * does not trip over them.
 */
const abort = (hangar: Hangar, clone: Clone, ledger: Ledger): CatchUpExit => {
  const repo = clone.path;
  const ref = stashRefFor(repo, ledger.stashLabel);
  if (ledger.stashLabel !== undefined && ref === undefined) {
    throw new CliError(
      `the catch-up stash ("${ledger.stashLabel}") is gone, so aborting would lose the changes`,
      'Nothing was touched. Sort the tree out by hand, then delete the ledger: ' + ledgerPath(repo),
    );
  }
  if (inProgressOperation(repo) === 'rebase') {
    git(repo, ['rebase', '--abort']);
  } else {
    const untracked =
      ref === undefined ? [] : lines(gitTry(repo, ['ls-tree', '-r', '--name-only', `${ref}^3`]));
    git(repo, ['reset', '-q', '--hard', ledger.oldHead]);
    for (const path of untracked) rmSync(join(repo, path), { force: true });
  }
  let back = true;
  if (ref !== undefined) {
    back =
      git(repo, ['stash', 'apply', '--index', ref]).ok || git(repo, ['stash', 'apply', ref]).ok;
    if (back && conflictedFiles(repo).length === 0) git(repo, ['stash', 'drop', ref]);
    else back = false;
  }
  dropLedger(repo);
  closePaused(hangar, ledger, 'aborted', back);
  if (!back) {
    throw new CliError(
      'the branch is back where it was, but re-applying the changes did not complete',
      `They are still in ${ref ?? 'the stash'}.`,
    );
  }
  ok('back as it was before the catch-up');
  return CATCH_UP_EXIT.done;
};

export const catchUp = async (
  hangar: Hangar,
  ref: string | undefined,
  opts: CatchUpOptions,
): Promise<CatchUpExit> => {
  const clone = forgeClone(hangar, ref, 'catch-up');
  heading(`Catching up ${clone.name}`);
  if (opts.continue === true || opts.abort === true) {
    const ledger = readLedger(clone.path);
    if (ledger === undefined) {
      throw new CliError(
        `${clone.name}: no catch-up is under way here`,
        'Start one with `hangar catch-up`.',
      );
    }
    return opts.abort === true ? abort(hangar, clone, ledger) : proceed(hangar, clone, ledger);
  }
  return start(hangar, clone, opts);
};
