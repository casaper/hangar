import { openPullRequests, repoRef, type PullRequest } from './bitbucket.ts';
import { tryDefaultBranch } from './config/default-branch.ts';
import type { Clone } from './fleet.ts';
import { git, gitTry } from './git.ts';
import type { Hangar } from './hangar.ts';
import { pickPullRequest } from './pr-cache.ts';

/**
 * Where a branch's pull request goes, stored per branch in the clone's own git config:
 * `branch.<branch>.hangarPrTarget`, a bare branch name.
 *
 * **The one per-branch value hangar stores rather than derives.** The forge is the authority and
 * every refresh asks it, but `sync` and `pr create` need an answer before a pull request exists
 * (a stacked branch), offline, and after Bitbucket's own retarget has failed -- which it can,
 * silently. A constant, not a config key: the ticket binding's name is configurable because the
 * repo's own script writes it, and nothing but hangar writes this one.
 */
export const PR_TARGET_KEY = 'hangarPrTarget';

const keyFor = (branch: string): string => `branch.${branch}.${PR_TARGET_KEY}`;

export const readPrTarget = (repo: string, branch: string): string | undefined => {
  const value = gitTry(repo, ['config', '--get', keyFor(branch)]);
  return value === undefined || value === '' ? undefined : value;
};

/** Writes only a changed value, so a refresh every 90 seconds rewrites nothing. */
export const writePrTarget = (repo: string, branch: string, target: string): boolean => {
  if (readPrTarget(repo, branch) === target) return false;
  return git(repo, ['config', keyFor(branch), target]).ok;
};

export const clearPrTarget = (repo: string, branch: string): boolean =>
  git(repo, ['config', '--unset', keyFor(branch)]).ok;

/** What one hop needs to know about the branch a target names. `undefined`: could not ask. */
export type TargetAsk = {
  readonly pr: (branch: string) => Promise<PullRequest | undefined | 'unknown'>;
  readonly onOrigin: (branch: string) => Promise<boolean | 'unknown'>;
};

/** How far a stacked chain is followed. Five branches deep is already a stack nobody means. */
export const MAX_TARGET_HOPS = 5;

/**
 * Where a stored target leads once the branches it names have merged.
 *
 * A hop moves the target to the destination of the target branch's own pull request, and only
 * when that pull request is MERGED and the branch is GONE from origin -- which is when Bitbucket
 * offers to retarget the pull requests stacked on it. A long-lived branch that once had a merged
 * pull request still exists, so it is never hopped off; nor is the default branch, which is where
 * every chain ends. Anything the forge or origin cannot answer stops the walk where it stands.
 */
export const followTarget = async (
  start: string,
  defaultBranch: string | undefined,
  ask: TargetAsk,
): Promise<string> => {
  let target = start;
  const seen = new Set([start]);
  for (let hop = 0; hop < MAX_TARGET_HOPS; hop += 1) {
    if (target === defaultBranch) return target;
    const pr = await ask.pr(target);
    if (pr === 'unknown' || pr?.state !== 'merged' || pr.destination === '') return target;
    if ((await ask.onOrigin(target)) !== false) return target;
    if (seen.has(pr.destination)) return target;
    seen.add(pr.destination);
    target = pr.destination;
  }
  return target;
};

/** The ask, against Bitbucket and origin. */
const forgeAsk = (hangar: Hangar, clone: Clone): TargetAsk => {
  const ref = repoRef(hangar, clone.path);
  return {
    pr: async (branch) => {
      const lookup = await openPullRequests(hangar, ref, branch, { anyState: true });
      return lookup.ok ? pickPullRequest(lookup.pullRequests) : 'unknown';
    },
    onOrigin: (branch) => {
      // Exit 2 is "no such ref"; anything else failing is not an answer.
      const res = git(clone.path, [
        'ls-remote',
        '--exit-code',
        '--heads',
        'origin',
        `refs/heads/${branch}`,
      ]);
      return Promise.resolve(res.ok ? true : res.code === 2 ? false : 'unknown');
    },
  };
};

/**
 * Record where this branch's pull request goes, and return it.
 *
 * The branch's own OPEN pull request decides when there is one: its destination already carries
 * any retarget Bitbucket made. Without one, a stored target is followed through merged, deleted
 * branches (`followTarget`). With neither there is nothing to record.
 */
export const recordPrTarget = async (
  hangar: Hangar,
  clone: Clone,
  branch: string,
  own: PullRequest | undefined,
  opts: { readonly write?: boolean } = {},
): Promise<string | undefined> => {
  const target =
    own?.state === 'open' && own.destination !== ''
      ? own.destination
      : await (async () => {
          const stored = readPrTarget(clone.path, branch);
          return stored === undefined
            ? undefined
            : followTarget(stored, tryDefaultBranch(hangar), forgeAsk(hangar, clone));
        })();
  // `write: false` answers what a real run would record, so `sync -n` names the same target.
  if (target !== undefined && target !== branch && opts.write !== false) {
    writePrTarget(clone.path, branch, target);
  }
  return target;
};
