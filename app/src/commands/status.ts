import pc from 'picocolors';

import { prSearchUrl, repoRef } from '../bitbucket.ts';
import { tryDefaultBranch } from '../config/default-branch.ts';
import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import {
  currentBranch,
  git,
  inProgressOperation,
  syncStashes,
  syncState,
  type StashEntry,
} from '../git.ts';
import { inferTicket, issueUrl, type TicketGuess } from '../jira.ts';
import { claudeSessionsIn, runningServersIn } from '../procs.ts';
import { cloneLabel, fail, heading, note, ok, table, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';
import { portSummary } from '../ports.ts';

/**
 * `hangar status` -- everything you need to know about a clone before touching it.
 *
 * The sync line is deliberately explicit about freshness. Without `--fetch` it compares
 * against whatever remote-tracking refs happen to be on disk and SAYS SO, rather than
 * reporting "up to date" from a ref that is three days stale.
 *
 * Two rows appear only when there is something to say -- a half-applied rebase or merge, and a
 * stash `hangar sync` never gave back. Both are states a human has to clear, and neither is
 * visible any other way: the stash is one line in a list hundreds of entries long. A row that
 * reads "none" on every healthy clone is a row nobody reads, which is the same reason `doctor`
 * has no check for how much of the shared cache a clone links.
 */
export type StatusOptions = {
  all?: boolean | undefined;
  fetch?: boolean | undefined;
};

const syncLine = (clone: Clone, fetched: boolean): string => {
  const state = syncState(clone.path);
  if (state.upstream === undefined) {
    return `${pc.yellow('no upstream')} — this branch has never been pushed`;
  }
  const freshness = fetched ? '' : pc.dim(' (not fetched — may be stale)');
  const parts: string[] = [];
  if (state.behind > 0) parts.push(pc.yellow(`${state.behind} behind`));
  if (state.ahead > 0) parts.push(pc.cyan(`${state.ahead} ahead`));
  const position = parts.length === 0 ? pc.green('in sync') : parts.join(', ');
  return `${position} with ${state.upstream}${freshness}`;
};

const dirtyLine = (clone: Clone): string => {
  const state = syncState(clone.path);
  if (state.dirty === 0 && state.untracked === 0) return pc.green('clean');
  const bits: string[] = [];
  if (state.dirty > 0) bits.push(`${state.dirty} modified`);
  if (state.untracked > 0) bits.push(`${state.untracked} untracked`);
  return pc.yellow(bits.join(', '));
};

/**
 * The half-applied-operation row, or nothing at all.
 *
 * Its own function for the same reason `syncLine` and `dirtyLine` are: a cell built inline
 * inside the table literal cannot be read, and this one has to be, because it is the row that
 * explains why `sync` is refusing to run.
 */
export const pendingRow = (pending: 'rebase' | 'merge' | undefined): string[][] =>
  pending === undefined
    ? []
    : [
        [
          'pending',
          pc.red(
            `a ${pending} is half-applied — \`--continue\` or \`--abort\` it; sync will refuse to start`,
          ),
        ],
      ];

/**
 * The unreturned-sync-stash row, or nothing at all.
 *
 * Deliberately unfiltered by age or branch, with a known consequence: a stash the user never
 * gets round to dropping keeps this row red on every `status` of that clone from then on --
 * the cry-wolf case this file's header warns about. It is left broad because a stranded stash
 * IS uncommitted work that nothing else surfaces, and the cure is dropping it. The closing
 * message a paused session gets is not broad: it matches the full label, ISO timestamp
 * included, so it can only ever report the stash THIS run pushed.
 */
export const strandedStashRow = (entries: readonly StashEntry[]): string[][] =>
  entries.length === 0
    ? []
    : [
        [
          'sync stash',
          pc.yellow(
            `${entries.map((entry) => `${entry.ref} (${entry.age})`).join(', ')} — uncommitted work \`hangar sync\` did not give back`,
          ),
        ],
      ];

/**
 * The tracker row: a link, why there is no link, or that no key was inferred.
 *
 * Its own PURE builder for the reason the other two rows are, and because there are now three
 * outcomes rather than two. `issueUrl` returns undefined for a hangar with `tracker.kind: none`,
 * and the row has to say WHICH of the two silences it is -- "no key in this branch" and "this
 * hangar has no tracker" call for completely different actions, and printing the same dim line
 * for both is how a missing config reads as a branch naming convention.
 */
export const issueRow = (clone: Clone, ticket: TicketGuess | undefined): string => {
  if (ticket === undefined) {
    return pc.dim("none inferred (no issue key in the branch name or in this branch's commits)");
  }
  const url = issueUrl(clone.hangar, ticket.key);
  if (url === undefined) {
    return `${ticket.key} ${pc.dim('(no link — this hangar has no tracker.baseUrl)')}`;
  }
  const from =
    ticket.source === 'commit'
      ? pc.dim('  (from a commit on this branch, not from the branch name)')
      : '';
  return `${url}${from}`;
};

export const statusOf = (clone: Clone, fetched: boolean): void => {
  const branch = currentBranch(clone.path);
  const ticket = inferTicket(clone, branch);
  const ref = repoRef(clone.hangar, clone.path);
  const sessions = claudeSessionsIn(clone.path);
  const scan = runningServersIn(clone);
  const pending = inProgressOperation(clone.path);
  const strandedStashes = syncStashes(clone.path);

  heading(cloneLabel(clone));

  const rows: string[][] = [
    ['dir', clone.path],
    ['colour', `${clone.colour.name} ${pc.dim(clone.colour.main)}`],
    ['branch', branch],
    ['sync', syncLine(clone, fetched)],
    ['worktree', dirtyLine(clone)],
    ...pendingRow(pending),
    ...strandedStashRow(strandedStashes),
    ['issue', issueRow(clone, ticket)],
    [
      'pull request',
      prSearchUrl(ref, branch) ?? pc.dim('no link — forge.originUrl is not a Bitbucket repository'),
    ],
    ['ports', portSummary(clone.ports)],
    [
      'servers',
      scan.servers.length === 0
        ? // Not "none running" when the port half could not be asked: an absent `lsof` means
          // nobody looked, and this row is read as an answer.
          pc.dim(scan.portsChecked ? 'none running' : 'no pid file — ports not checked (no lsof)')
        : scan.servers
            .map(
              (s) =>
                `${s.name} (pid ${s.pid}${s.how === 'port' ? `, listening on ${String(s.port ?? 0)}` : ''})`,
            )
            .join(', '),
    ],
    [
      'claude',
      sessions.length === 0
        ? pc.dim('no live session')
        : sessions
            .map(
              (s) =>
                `pid ${s.pid} ${s.tty === undefined ? pc.dim('(no tty — IDE session)') : `on ${s.tty}`}`,
            )
            .join(', '),
    ],
  ];
  table(rows.map(([label, value]) => [pc.dim(label ?? ''), value ?? '']));
};

export const status = (hangar: Hangar, ref: string | undefined, opts: StatusOptions): void => {
  const clones = opts.all === true ? discoverClones(hangar) : resolveOne(hangar, ref);

  if (opts.fetch === true) {
    for (const clone of clones) {
      const res = git(clone.path, ['fetch', '--all', '--prune', '--quiet']);
      if (res.ok) ok(`fetched ${clone.name}`);
      else fail(`fetch failed in ${clone.name}: ${res.stderr.trim()}`);
    }
  }

  for (const clone of clones) statusOf(clone, opts.fetch === true);

  if (opts.fetch !== true) {
    console.log('');
    note('Remote state was not refreshed. Add --fetch for an authoritative sync answer.');
  }
  warnOnDuplicateBranches(hangar, clones);
};

const resolveOne = (hangar: Hangar, ref: string | undefined): Clone[] => {
  if (ref === undefined) {
    throw new CliError('status needs a clone name, or --all', knownClonesHint(hangar));
  }
  return [requireClone(hangar, ref)];
};

/** Two clones on one branch is legal but almost always a mistake worth surfacing. */
const warnOnDuplicateBranches = (hangar: Hangar, clones: readonly Clone[]): void => {
  if (clones.length < 2) return;
  // Two clones on the DEFAULT branch is the normal resting state, so it is the one pair not
  // worth a warning. This used to be the literal `master`, which made the exemption wrong in
  // every hangar but this one.
  const defaultBranch = tryDefaultBranch(hangar);
  const byBranch = new Map<string, string[]>();
  for (const clone of clones) {
    const branch = currentBranch(clone.path);
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), clone.name]);
  }
  for (const [branch, names] of byBranch) {
    if (names.length > 1 && branch !== defaultBranch) {
      warn(`${names.join(' and ')} are both on ${branch}`);
    }
  }
};
