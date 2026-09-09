import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Clone } from './fleet.ts';
import type { Hangar } from './hangar.ts';

/**
 * Which pull request a branch has, remembered on disk -- one file per clone.
 *
 * The clone bar names the pull request, and the bar is re-rendered every ten seconds per
 * attached client. Asking Bitbucket costs a token, a network round trip and up to eight seconds
 * (`bitbucket.ts`'s `openPullRequests`), so that question cannot be in the refresh loop at all.
 * It is answered by the commands that were going to ask anyway -- `sync` resolves a PR's target
 * branch on every run -- and by `hangar browse pr`, which is a human asking once.
 *
 * ## Keyed on the BRANCH, which is the correctness property rather than a detail
 *
 * A pull request's id never changes for a branch, so there is no freshness question to get
 * wrong: a cache line whose branch is not the branch checked out right now is simply not this
 * branch's pull request, and the reader ignores it. That is what makes a cache with no TTL safe
 * here, and it is the specific failure it rules out -- a clone showing the number of the PR it
 * was on last week, which is exactly the shape of wrong that gets believed.
 *
 * What it does NOT rule out is a PR closed and reopened as a new one on the same branch. The
 * next `sync` corrects it, and `fetchedAt` is recorded so a reader that wants to care can.
 *
 * ## One line, space-separated, and no JSON
 *
 * The only reader that matters is generated shell (`generate/tmux-status-sh.ts`), which reads
 * this with one `read -r` and no `jq`. A JSON parser in that script would be a dependency on a
 * status bar, and the failure mode of a missing one is a bar that has quietly stopped saying
 * anything. Neither a branch name nor a URL may contain a space, so a space is a separator no
 * value can forge -- which is what makes the shell side one line long and total.
 */
export type CachedPullRequest = {
  readonly branch: string;
  readonly id: number;
  readonly url: string;
  /** Unix seconds. Recorded rather than enforced -- see the header. */
  readonly fetchedAt: number;
};

export const prCachePath = (hangar: Hangar, clone: Clone): string =>
  join(hangar.paths.prCache, clone.name);

/** The whole file, newline included: `read` returns non-zero at an EOF with no newline. */
export const prCacheLine = (pr: CachedPullRequest): string =>
  `${pr.branch} ${String(pr.id)} ${pr.url} ${String(pr.fetchedAt)}\n`;

/**
 * The inverse, and undefined for anything that is not exactly four fields with a numeric id.
 *
 * Total rather than throwing, because both readers are on paths where "no answer" is normal:
 * the bar prints nothing, and `browse` asks Bitbucket instead.
 */
export const parsePrCacheLine = (line: string): CachedPullRequest | undefined => {
  const [branch, id, url, fetchedAt, ...rest] = line.trim().split(' ');
  if (branch === undefined || id === undefined || url === undefined || rest.length > 0) {
    return undefined;
  }
  if (!/^\d+$/.test(id)) return undefined;
  return {
    branch,
    id: Number(id),
    url,
    fetchedAt: fetchedAt !== undefined && /^\d+$/.test(fetchedAt) ? Number(fetchedAt) : 0,
  };
};

/** The cached pull request for `branch`, or undefined -- including for a line naming another. */
export const readCachedPr = (
  hangar: Hangar,
  clone: Clone,
  branch: string,
): CachedPullRequest | undefined => {
  let line: string;
  try {
    line = readFileSync(prCachePath(hangar, clone), 'utf8');
  } catch {
    return undefined;
  }
  const cached = parsePrCacheLine(line);
  return cached?.branch === branch ? cached : undefined;
};

/** Never throws: a cache that cannot be written is a bar with less on it, not a failed command. */
export const writeCachedPr = (hangar: Hangar, clone: Clone, pr: CachedPullRequest): void => {
  const path = prCachePath(hangar, clone);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, prCacheLine(pr), 'utf8');
  } catch {
    /* see above */
  }
};

/**
 * Forget the line if it names `branch` -- for a branch that turned out to have no pull request.
 *
 * The branch check is what stops this from being destructive: another branch's line is somebody
 * else's answer to a question this call did not ask.
 */
export const forgetCachedPr = (hangar: Hangar, clone: Clone, branch: string): void => {
  if (readCachedPr(hangar, clone, branch) === undefined) return;
  try {
    rmSync(prCachePath(hangar, clone));
  } catch {
    /* see writeCachedPr */
  }
};
