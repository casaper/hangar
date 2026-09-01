import pc from 'picocolors';

import { prSearchUrl, repoRef } from '../bitbucket.ts';
import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { currentBranch, git, syncState } from '../git.ts';
import { inferTicket, jiraUrl } from '../jira.ts';
import { claudeSessionsIn, runningServersIn } from '../procs.ts';
import { cloneLabel, fail, heading, note, ok, table, warn } from '../ui.ts';

/**
 * `orch-util status` -- everything you need to know about a clone before touching it.
 *
 * The sync line is deliberately explicit about freshness. Without `--fetch` it compares
 * against whatever remote-tracking refs happen to be on disk and SAYS SO, rather than
 * reporting "up to date" from a ref that is three days stale.
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

export const statusOf = (clone: Clone, fetched: boolean): void => {
  const branch = currentBranch(clone.path);
  const ticket = inferTicket(clone, branch);
  const ref = repoRef(clone.path);
  const sessions = claudeSessionsIn(clone.path);
  const servers = runningServersIn(clone.path);

  heading(cloneLabel(clone));

  const rows: string[][] = [
    ['dir', clone.path],
    ['colour', `${clone.colour.name} ${pc.dim(clone.colour.main)}`],
    ['branch', branch],
    ['sync', syncLine(clone, fetched)],
    ['worktree', dirtyLine(clone)],
    [
      'jira',
      ticket === undefined
        ? pc.dim("none inferred (no issue key in the branch name or in this branch's commits)")
        : `${jiraUrl(ticket.key)}${ticket.source === 'commit' ? pc.dim('  (from a commit on this branch, not from the branch name)') : ''}`,
    ],
    ['pull request', prSearchUrl(ref, branch)],
    [
      'ports',
      `ng ${clone.ports.ng} · storybook ${clone.ports.storybook} · playwright ${clone.ports.playwrightReport}`,
    ],
    [
      'servers',
      servers.length === 0
        ? pc.dim('none running')
        : servers.map((s) => `${s.name} (pid ${s.pid})`).join(', '),
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

export const status = (ref: string | undefined, opts: StatusOptions): void => {
  const clones = opts.all === true ? discoverClones() : resolveOne(ref);

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
  warnOnDuplicateBranches(clones);
};

const resolveOne = (ref: string | undefined): Clone[] => {
  if (ref === undefined) {
    throw new CliError('status needs a clone name, or --all', knownClonesHint());
  }
  return [requireClone(ref)];
};

/** Two clones on one branch is legal but almost always a mistake worth surfacing. */
const warnOnDuplicateBranches = (clones: readonly Clone[]): void => {
  if (clones.length < 2) return;
  const byBranch = new Map<string, string[]>();
  for (const clone of clones) {
    const branch = currentBranch(clone.path);
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), clone.name]);
  }
  for (const [branch, names] of byBranch) {
    if (names.length > 1 && branch !== 'master') {
      warn(`${names.join(' and ')} are both on ${branch}`);
    }
  }
};
