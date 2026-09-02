import { existsSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { freshnessOf } from '../dedupe.ts';
import { run } from '../exec.ts';
import { cloneForCwd, type Clone } from '../fleet.ts';
import {
  assetRefsIn,
  blockEntries,
  frontmatterOf,
  hasTopLevelKey,
  linkToStore,
  storeRecordPath,
} from '../jira-records.ts';

/**
 * `orch-util jira hook` -- a `PreToolUse` hook that serves a cached ticket instead of fetching it.
 *
 * `jira-ticket-sync` re-fetches a ticket and its whole neighbourhood on every run, and the
 * record store already holds all of it as one file per ticket. This reads the Bash command
 * Claude Code is about to run; when the store can satisfy it in full, it hard-links every file
 * that run would have produced and DENIES the command, telling the agent what it got instead.
 *
 * It lives here rather than in a clone for the reason the fleet exists: a clone's `.claude/` is
 * shared with every other contributor and must work without this parent, so the hook is wired
 * from each clone's untracked `.claude/settings.local.json` by absolute path -- exactly like the
 * `SessionEnd` plan collector. A clone whose branch has no `jira-ticket-sync` skill never
 * matches, so the hook is a silent no-op there instead of misfiring.
 *
 * Three properties it must have, in order of how badly the alternative bites:
 *
 * - **It fails OPEN.** Every uncertainty -- a flag it does not know, a frontmatter shape it
 *   cannot read, a store record with no parsable timestamp, an unexpected shell construct --
 *   exits silently and lets the fetch happen. A hook that wrongly denies leaves an agent unable
 *   to read a ticket, and the reason it cannot is invisible from inside the clone.
 * - **All or nothing.** A run produces the trunk AND its parent, sub-tasks and relations. If any
 *   one of those is missing or stale in the store, nothing is short-circuited: half-populating
 *   the directory and reporting success is worse than the re-fetch it saved.
 * - **It never reimplements the naming.** Where each file belongs is `jira-scope/paths.mjs`'s
 *   business -- tracked, branch-versioned, and self-described as the single owner of every
 *   filename in that directory -- so the destinations come from that clone's own
 *   `jira-cache.mjs name`, one subprocess per file. An untracked copy of `stemFor` would drift
 *   the first time a branch changed a relation slug, and the damage would be a file under the
 *   wrong name, which nothing checks.
 *
 * The one cost that cannot be engineered away: whether Jira has changed since the fetch is
 * unknowable without asking Jira, so the TTL is the whole of the freshness guarantee.
 */

/** What Claude Code sends a `PreToolUse` hook. Only the fields this needs are typed. */
type HookPayload = {
  readonly tool_name?: string;
  readonly hook_event_name?: string;
  readonly cwd?: string;
  readonly tool_input?: { readonly command?: string };
};

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** The skill's own accepted flags. Anything else and `sync.mjs` would refuse the run itself. */
const KNOWN_FLAGS = ['--no-relations', '--no-assets', '--quiet', '--json'];

/** The escape hatch, and the reason it is an env var: `sync.mjs` dies on an unknown flag. */
const BYPASS = 'JIRA_SYNC_NO_CACHE';

const SYNC_SCRIPT = 'jira-ticket-sync/sync.mjs';

/** Anything that makes the tail of the command more than a plain argument list. */
const SHELL_META = /[|&;<>(){}$`\n]/;

export type Invocation = {
  readonly keys: readonly string[];
  readonly relations: boolean;
  readonly assets: boolean;
};

/**
 * The keys and flags of a `sync.mjs` call, or undefined when this is not one to touch.
 *
 * Parsed from the text AFTER the script path, so a `cd … &&` prefix is fine while a pipeline or
 * a second command in the tail is not -- the agent is then doing something with the output that
 * a denial would not give it.
 */
export const parseSyncCommand = (command: string): Invocation | undefined => {
  if (command.includes(BYPASS)) return undefined;
  const parts = command.split(SYNC_SCRIPT);
  if (parts.length !== 2) return undefined;
  const tail = parts[1] ?? '';
  if (SHELL_META.test(tail)) return undefined;

  const tokens = tail
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  const flags = tokens.filter((token) => token.startsWith('-'));
  if (flags.some((flag) => !KNOWN_FLAGS.includes(flag))) return undefined;
  const keys = tokens.filter((token) => KEY_RE.test(token));
  if (keys.length === 0 || keys.length !== tokens.length - flags.length) return undefined;

  return {
    keys,
    relations: !flags.includes('--no-relations'),
    assets: !flags.includes('--no-assets'),
  };
};

/** A store record that exists, has a frontmatter timestamp, and is inside the TTL. */
type FreshRecord = { readonly key: string; readonly content: string; readonly at: number };

const freshRecord = (key: string, ttlMs: number): FreshRecord | undefined => {
  const path = storeRecordPath(key);
  if (!existsSync(path)) return undefined;
  const { at, source } = freshnessOf(path);
  // `mtime` means no `fetched_at:` this could read. The file's own timestamp is the fallback
  // that both this store and the skill's contract call untrustworthy, and it is not a basis
  // for skipping a fetch.
  if (source === 'mtime' || Date.now() - at > ttlMs) return undefined;
  try {
    return { key, content: readFileSync(path, 'utf8'), at };
  } catch {
    return undefined;
  }
};

/** One file the run would have produced: which ticket's record, under which name. */
type Wanted = { readonly key: string; readonly relation?: string };

/**
 * Every file a `sync.mjs <TRUNK>` run would write, read out of the CACHED trunk record.
 *
 * The neighbourhood is in the trunk's own frontmatter -- `parent:`, `subtasks:`, `relations:` --
 * which is the whole reason this is possible without calling Jira. Undefined when it cannot be
 * established, and the floor matters: an OLD-format record (`key:`/`fetched:`) has those keys
 * ABSENT, not empty, and reading absent as "no neighbours" would turn a full sync into one
 * linked file. So a record that does not carry the keys at all is declined.
 */
export const wantedFiles = (trunk: FreshRecord, relations: boolean): Wanted[] | undefined => {
  const wanted: Wanted[] = [{ key: trunk.key }];
  if (!relations) return wanted;

  const frontmatter = frontmatterOf(trunk.content);
  if (frontmatter === undefined) return undefined;
  if (!hasTopLevelKey(frontmatter, 'relations') || !hasTopLevelKey(frontmatter, 'parent')) {
    return undefined;
  }

  for (const entry of blockEntries(frontmatter, 'parent')) {
    if (entry['id'] === undefined) return undefined;
    wanted.push({ key: entry['id'], relation: 'parent' });
  }
  for (const entry of blockEntries(frontmatter, 'subtasks')) {
    if (entry['id'] === undefined) return undefined;
    wanted.push({ key: entry['id'], relation: 'subtask' });
  }
  for (const entry of blockEntries(frontmatter, 'relations')) {
    // The label is what the filename's relation segment is slugged from, so a relation entry
    // without one cannot be placed at all.
    if (entry['id'] === undefined || entry['relation'] === undefined) return undefined;
    wanted.push({ key: entry['id'], relation: entry['relation'] });
  }
  return wanted;
};

/**
 * Where that file belongs, asked of the clone's own path owner rather than reconstructed.
 *
 * `jira-cache.mjs name` CREATES `tmp/<TRUNK>/` as a side effect -- `dirFor` does, and every
 * command in that CLI goes through it. Harmless when the hook goes on to link something in,
 * but a decline after this point (a failed attachment check, a later key that is not in the
 * store) would otherwise leave an empty ticket directory in the clone, which the next
 * `tmp merge` adopts into the store and symlinks into every clone -- a cached ticket with
 * nothing in it. So a directory this created is remembered in `created` and removed again if
 * the hook ends up declining.
 */
const destinationOf = (
  clone: Clone,
  trunk: string,
  wanted: Wanted,
  created: string[],
): string | undefined => {
  const dir = join(clone.path, 'tmp', trunk);
  const existed = existsSync(dir);
  const args =
    wanted.relation === undefined ? ['name', trunk] : ['name', trunk, wanted.relation, wanted.key];
  const res = run('node', ['.claude/skills/jira-scope/jira-cache.mjs', ...args], {
    cwd: clone.path,
    timeoutMs: 20_000,
  });
  if (!existed && existsSync(dir)) created.push(dir);
  const printed = res.stdout.trim();
  if (!res.ok || printed === '') return undefined;
  return isAbsolute(printed) ? printed : join(clone.path, printed);
};

/** Remove the ticket directories this run created and did not fill. Never a non-empty one. */
const removeEmpty = (dirs: readonly string[]): void => {
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty, or already gone -- either way it is not this run's to remove.
    }
  }
};

const inodeOf = (path: string): number | undefined => {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
};

type Plan = { readonly record: FreshRecord; readonly destination: string };

/**
 * Why nothing was short-circuited, for `--explain`.
 *
 * A hook that fails open is silent by design, which also makes it undebuggable: the fetch
 * simply happens and nothing says the store was consulted at all. Every decline carries its
 * reason so `--explain` can print it, and the reasons are the whole specification of when this
 * does and does not act.
 */
type Decline = { readonly reason: string };

const decline = (reason: string): Decline => ({ reason });

/**
 * The whole set of links to make, or undefined if any part of it cannot be satisfied.
 *
 * Attachments are the subtle half. A record's asset references are TRUNK-SPECIFIC -- ABC-1191
 * reached from ABC-1323 names `ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png` -- so a record
 * whose references do not resolve beside the destination would be linked in with image links
 * to files that are not there. Requiring every referenced file to exist declines exactly that
 * case, and passes the common one where the ticket has no attachments at all.
 */
export const planLinks = (
  clone: Clone,
  invocation: Invocation,
  ttlMs: number,
  created: string[] = [],
): Plan[] | Decline => {
  const plans: Plan[] = [];
  for (const trunkKey of invocation.keys) {
    const trunk = freshRecord(trunkKey, ttlMs);
    if (trunk === undefined)
      return decline(`${trunkKey} is not in the store, or is older than the TTL`);
    const wanted = wantedFiles(trunk, invocation.relations);
    if (wanted === undefined) {
      return decline(
        `${trunkKey}'s record does not state its neighbourhood (no \`relations:\`/\`parent:\` ` +
          'keys, or an entry without an id) — only the newer sync contract does',
      );
    }

    for (const item of wanted) {
      const record = item.key === trunk.key ? trunk : freshRecord(item.key, ttlMs);
      if (record === undefined) {
        return decline(
          `${trunkKey} needs ${item.key} (${item.relation ?? 'the trunk'}), which is not in the ` +
            'store or is older than the TTL',
        );
      }
      const destination = destinationOf(clone, trunkKey, item, created);
      if (destination === undefined) {
        return decline(`${clone.name} could not name the file for ${item.key} under ${trunkKey}`);
      }
      if (invocation.assets) {
        const dir = dirname(destination);
        for (const ref of assetRefsIn(record.content)) {
          if (!existsSync(join(dir, ref))) {
            return decline(
              `${item.key}'s record references ${ref}, which is not beside ${destination} — ` +
                'attachment names are trunk-specific, so this record belongs to another trunk',
            );
          }
        }
      }
      plans.push({ record, destination });
    }
  }
  return plans;
};

const minutesAgo = (at: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return minutes < 1 ? 'just now' : `${String(minutes)} min ago`;
};

const deny = (reason: string): void => {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
};

export type JiraHookOptions = {
  ttl?: string | undefined;
  dryRun?: boolean | undefined;
  explain?: boolean | undefined;
};

/**
 * Read the hook payload on stdin and decide. Silence means "go ahead and fetch".
 *
 * Never throws and never exits non-zero: a hook that errors is a hook that has to be
 * diagnosed from inside a clone that cannot fetch a ticket.
 */
export const jiraHook = (opts: JiraHookOptions): void => {
  const say = (reason: string): void => {
    if (opts.explain === true) process.stderr.write(`jira hook: ${reason}\n`);
  };

  let payload: HookPayload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8')) as HookPayload;
  } catch {
    say('the payload on stdin is not JSON');
    return;
  }
  if (payload.tool_name !== 'Bash') {
    say(`not a Bash call (${payload.tool_name ?? 'no tool_name'})`);
    return;
  }

  const command = payload.tool_input?.command;
  if (command === undefined) {
    say('the payload carries no command');
    return;
  }
  const invocation = parseSyncCommand(command);
  if (invocation === undefined) {
    say(`not a plain \`${SYNC_SCRIPT}\` call, or ${BYPASS} is set`);
    return;
  }

  const clone = cloneForCwd(payload.cwd ?? process.cwd());
  if (clone === undefined) {
    say(`${payload.cwd ?? process.cwd()} is not inside a clone`);
    return;
  }

  const minutes = Number.parseInt(opts.ttl ?? '60', 10);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    say(`--ttl ${opts.ttl ?? '(unset)'} is not a positive number of minutes`);
    return;
  }

  // Directories `jira-cache.mjs name` created while resolving destinations, so a decline
  // leaves the clone exactly as it found it.
  const created: string[] = [];
  let outcome: Plan[] | Decline;
  try {
    outcome = planLinks(clone, invocation, minutes * 60_000, created);
  } catch (error) {
    removeEmpty(created);
    say(`could not decide — ${(error as Error).message}`);
    return;
  }
  if (!Array.isArray(outcome)) {
    removeEmpty(created);
    say(outcome.reason);
    return;
  }
  const plans = outcome;

  const linked: string[] = [];
  for (const plan of plans) {
    try {
      if (inodeOf(plan.destination) === inodeOf(storeRecordPath(plan.record.key))) {
        linked.push(plan.destination);
        continue;
      }
      if (opts.dryRun !== true) linkToStore(plan.record.key, plan.destination);
      linked.push(plan.destination);
    } catch (error) {
      // A link that could not be made means the directory is not in the shape the run would
      // have left it in, so the run is what should happen.
      removeEmpty(created);
      say(`${plan.destination}: could not link — ${(error as Error).message}`);
      return;
    }
  }
  // A dry run linked nothing, so every directory it created is still empty and still its own.
  if (opts.dryRun === true) removeEmpty(created);

  const files = plans
    .map(
      (plan) =>
        `  ${plan.destination.slice(clone.path.length + 1)}  ${plan.record.key}  fetched ${minutesAgo(plan.record.at)}`,
    )
    .join('\n');
  deny(
    `Not fetched: every file this run would have written is already in the fleet's ticket ` +
      `record store and was fetched within ${String(minutes)} min. ` +
      `${String(linked.length)} file(s) ${opts.dryRun === true ? 'would be' : 'are now'} ` +
      `hard-linked in place — read them:\n${files}\n` +
      `Whether Jira changed since cannot be known without asking it. To fetch anyway, re-run ` +
      `the same command with ${BYPASS}=1 in front of it.`,
  );
};
