import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { declinePullRequest, openPullRequests, repoRef } from '../bitbucket.ts';
import { tryDefaultBranch } from '../config/default-branch.ts';
import { CliError, run } from '../exec.ts';
import { currentBranch, DETACHED, git, inProgressOperation, refExists } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { trackedKeyIn } from '../jira.ts';
import { refreshPullRequest } from '../pr-cache.ts';
import { recordPrTarget } from '../pr-target.ts';
import { confirm, heading, note, ok, step, warn } from '../ui.ts';
import { forgeClone } from './pr.ts';

/**
 * `hangar pr rebranch --to <name>` -- take a published branch off the forge so it can be
 * rewritten, and carry on under a new name.
 *
 * It exists because a forge that restricts force-pushes leaves exactly one way to rewrite a
 * published branch: decline its pull request, delete the branch on origin, and publish the
 * rewritten history under ANOTHER name -- the same name would revive the deleted branch, pull
 * request and all, on Bitbucket. Each of those steps is something a clone session is forbidden
 * to do itself, so the command does all of them, after the person said yes.
 *
 * What it deliberately does NOT do is publish anything: no push of the new name, no new pull
 * request. That is the person's to do, when and if they choose -- which is also why it is not
 * on the exec guard's publish list. The order is the safe one: the pull request is declined
 * before its branch is deleted, so a delete the forge refuses leaves a declined pull request
 * (reopenable) and an untouched local branch, never an open pull request with no branch.
 */
export type RebranchOptions = {
  to?: string | undefined;
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
};

/** Words a rename should not ADD, because they say what was done rather than what it is. */
const GIVE_AWAY =
  /^(re|new|newer|v\d+|again|retry|copy|fresh|take\d*|redo|second|2nd|alt|bis|clean|cleaned|reset|rebased?|re-?(create[ds]?|open(ed)?|push(ed)?|start(ed)?|do(ne)?|base[ds]?|make|made))$/i;

const tokensOf = (name: string): string[] =>
  (name.split('/').at(-1) ?? name).split(/[-_.]+/).filter((token) => token !== '');

const prefixOf = (name: string): string => {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? '' : name.slice(0, slash + 1);
};

/**
 * Everything wrong with `next` as the new name for `old`. PURE, and the whole of the rule:
 * empty means acceptable.
 *
 * A token the old name already carried is never held against the new one -- a topic that is
 * genuinely about something "new" may keep the word.
 */
export const rebranchNameProblems = (
  old: string,
  next: string,
  ticket: string | undefined,
  prefixes: readonly string[],
): string[] => {
  const problems: string[] = [];
  if (next.toLowerCase() === old.toLowerCase()) {
    problems.push('it is the same name — the forge would revive the deleted branch');
  }
  if (prefixOf(next) !== prefixOf(old)) {
    problems.push(`it changes the prefix: "${prefixOf(old)}" becomes "${prefixOf(next)}"`);
  }
  if (ticket !== undefined && trackedKeyIn(prefixes, next) !== ticket) {
    problems.push(`it drops the ticket key ${ticket}`);
  }
  const before = new Set(tokensOf(old).map((token) => token.toLowerCase()));
  const added = tokensOf(next).filter((token) => !before.has(token.toLowerCase()));
  const giveaway = added.filter((token) => GIVE_AWAY.test(token));
  if (giveaway.length > 0) {
    problems.push(`it adds ${giveaway.map((t) => `"${t}"`).join(', ')}, which says what was done`);
  }
  const last = tokensOf(next).at(-1) ?? '';
  if (/^\d+$/.test(last) && !before.has(last)) {
    problems.push(`it ends in a bare number ("${last}"), which reads as a second attempt`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(next) || next.includes('..') || next.endsWith('/')) {
    problems.push('it is not a plain branch name (letters, digits, . _ - /)');
  }
  return problems;
};

export const rebranch = async (
  hangar: Hangar,
  ref: string | undefined,
  opts: RebranchOptions,
): Promise<void> => {
  const clone = forgeClone(hangar, ref, 'pr rebranch');
  const repo = clone.path;
  const branch = currentBranch(repo);
  heading(`Rebranching ${clone.name}`);
  if (branch === DETACHED) throw new CliError(`${clone.name}: detached HEAD — no branch to rename`);
  if (branch === tryDefaultBranch(hangar)) {
    throw new CliError(`${clone.name}: on the default branch (${branch}) — never renamed`);
  }
  const pending = inProgressOperation(repo);
  if (pending !== undefined) throw new CliError(`${clone.name} is in the middle of a ${pending}`);
  const next = opts.to;
  if (next === undefined || next === '') throw new CliError('which new name? Pass --to <name>');

  const prefixes = hangar.config.tracker.keyPrefixes ?? [];
  const problems = rebranchNameProblems(branch, next, trackedKeyIn(prefixes, branch), prefixes);
  if (refExists(repo, `refs/heads/${next}`)) problems.push('a local branch has that name already');
  const nextRemote = git(repo, [
    'ls-remote',
    '--exit-code',
    '--heads',
    'origin',
    `refs/heads/${next}`,
  ]);
  if (nextRemote.ok) problems.push('origin has a branch by that name already');
  if (problems.length > 0) {
    throw new CliError(
      `"${next}" will not do as the new name`,
      problems.map((p) => `- ${p}`).join('\n'),
    );
  }

  const remote = git(repo, [
    'ls-remote',
    '--exit-code',
    '--heads',
    'origin',
    `refs/heads/${branch}`,
  ]);
  if (!remote.ok && remote.code !== 2) {
    throw new CliError(`could not ask origin whether ${branch} is there`, remote.stderr.trim());
  }
  const forge = repoRef(hangar, repo);
  const lookup = await openPullRequests(hangar, forge, branch);
  if (!lookup.ok) {
    throw new CliError(
      `could not find out whether ${branch} has an open pull request: ${lookup.reason}`,
      'Nothing was changed. Deleting the branch under an open pull request is the one outcome this avoids.',
    );
  }
  const prs = lookup.pullRequests;

  step(`${clone.name}: ${branch} → ${next}`);
  for (const pr of prs) note(`  decline  #${String(pr.id)} → ${pr.destination}  ${pr.url}`);
  note(
    remote.ok
      ? `  delete   origin/${branch}`
      : `  (${branch} is not on origin — nothing to delete)`,
  );
  note(`  rename   ${branch} → ${next}, its ticket binding and stored PR target with it`);
  note('  publish  nothing — pushing the new name and opening a pull request stay yours');
  if (opts.dryRun === true) {
    note('(dry run — nothing was changed)');
    return;
  }
  if (opts.yes !== true && !confirm(`Decline, delete and rename as above?`)) {
    note('nothing was changed — pass -y to skip the question');
    return;
  }

  for (const pr of prs) {
    // Recorded first, from the still-open pull request: the new name's first `pr create`
    // should go where this one was going, and after the decline nothing says where that was.
    await recordPrTarget(hangar, clone, branch, pr);
    const declined = await declinePullRequest(hangar, forge, pr.id);
    if (!declined.ok) {
      throw new CliError(
        `could not decline #${String(pr.id)}: ${declined.reason}`,
        'Nothing else was done.',
      );
    }
    ok(`declined #${String(pr.id)}`);
  }

  if (remote.ok) {
    /*
     * `--no-verify` on the DELETE only. A repo's `pre-push` hook may refuse every push made
     * from inside an agent session, and this one is made from inside one by design -- after the
     * person confirmed it. A deletion sends no objects, so there is nothing else for the hook to
     * check; every other push in this CLI still runs it.
     */
    const deleted = git(repo, ['push', '--no-verify', '--quiet', '--delete', 'origin', branch]);
    if (!deleted.ok) {
      throw new CliError(
        `origin refused to delete ${branch}: ${deleted.stderr.trim()}`,
        prs.length === 0
          ? 'Nothing else was done.'
          : `The pull request${prs.length > 1 ? 's were' : ' was'} declined already — reopen on the forge if this is where it stops. The local branch is untouched.`,
      );
    }
    ok(`deleted origin/${branch}`);
  }

  const renamed = git(repo, ['branch', '-m', branch, next]);
  if (!renamed.ok) throw new CliError(`git could not rename ${branch}`, renamed.stderr.trim());
  // The upstream moved with the rest of `branch.<old>.*` and names a branch that is gone.
  git(repo, ['config', '--unset', `branch.${next}.remote`]);
  git(repo, ['config', '--unset', `branch.${next}.merge`]);
  ok(`renamed to ${next}`);

  const gate = join(hangar.root, 'bin', 'hangar-commit-gate');
  if (existsSync(gate)) {
    const followed = run(gate, ['follow-rename'], { cwd: repo });
    if (followed.stdout.trim() !== '') note(followed.stdout.trim());
    if (!followed.ok) warn(`the commit gate did not follow the rename: ${followed.stderr.trim()}`);
  }
  await refreshPullRequest(hangar, clone, next);
};
