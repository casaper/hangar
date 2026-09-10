import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  openPullRequests,
  prSearchUrl,
  pullRequestCiState,
  repoRef,
  type CiState,
  type PrState,
  type PullRequest,
  type ReviewState,
} from './bitbucket.ts';
import type { Clone } from './fleet.ts';
import type { Hangar } from './hangar.ts';

/**
 * What a branch's pull request is doing, remembered on disk -- one file per clone.
 *
 * The clone bar names the pull request, and the bar is re-rendered every few seconds per attached
 * client per field. Asking Bitbucket costs a token, two network round trips and up to eight
 * seconds each, so that question cannot be in the refresh loop at all. It is answered off to one
 * side and the answer is left here; `generate/tmux-status-sh.ts` reads this file and nothing else.
 *
 * ## Keyed on the BRANCH, and now ALSO on time
 *
 * Branch-keying is still the correctness property: a cache line whose branch is not the branch
 * checked out right now is simply not this branch's pull request, and the reader ignores it. That
 * is what rules out the specific failure of a clone showing the number of the PR it was on last
 * week -- exactly the shape of wrong that gets believed.
 *
 * What branch-keying alone cannot cover is everything past the id. *A pull request's id never
 * changes for a branch*, which is why this file once needed no TTL at all -- but `state`, `draft`,
 * `ci` and `review` are the volatile fields, and CI in particular can turn over inside a minute.
 * So `fetchedAt` went from recorded-but-unenforced to load-bearing: the bar compares it against
 * `forge.prCacheTtlSeconds` and asks for a refresh in the background when it is old. Nothing
 * blocks on that; the stale value is drawn now and the fresh one arrives at the next redraw.
 *
 * ## `id` of 0 is "asked, and there is no pull request"
 *
 * The negative cache, and it is not an optimisation. Without it a branch that has no PR -- a
 * chore branch, anything before the PR is opened -- is indistinguishable from a branch nobody has
 * looked up yet, so every redraw re-asks, for ever, for every such clone. The `url` of a negative
 * record is the branch's PR SEARCH url, so clicking the field still does something true.
 *
 * ## One line, space-separated, and no JSON
 *
 * The only reader that matters is generated shell, which reads this with one `read -r` and no
 * `jq`. A JSON parser in that script would be a dependency on a status bar, and the failure mode
 * of a missing one is a bar that has quietly stopped saying anything. Neither a branch name nor a
 * URL may contain a space, so a space is a separator no value can forge -- which is what makes
 * the shell side one line long and total.
 *
 * **Fields are appended, never reordered**, the rule `clone-colours.sh` already lives by, and the
 * parser tolerates trailing fields it does not know so that a record written by a newer CLI reads
 * as valid rather than as corrupt. That tolerance is what makes appending actually safe.
 */
export type CachedPullRequest = {
  readonly branch: string;
  /** `0` means "asked, and there is none" -- see the header. */
  readonly id: number;
  readonly url: string;
  /** Unix seconds. Enforced against `forge.prCacheTtlSeconds` -- see the header. */
  readonly fetchedAt: number;
  readonly state: PrState;
  readonly draft: boolean;
  readonly ci: CiState;
  readonly review: ReviewState;
};

/** The default when `forge.prCacheTtlSeconds` says nothing. CI is what moves fastest. */
export const DEFAULT_PR_CACHE_TTL_SECONDS = 90;

export const prCacheTtlSeconds = (hangar: Hangar): number =>
  hangar.config.forge.prCacheTtlSeconds ?? DEFAULT_PR_CACHE_TTL_SECONDS;

export const prCachePath = (hangar: Hangar, clone: Clone): string =>
  join(hangar.paths.prCache, clone.name);

/** The whole file, newline included: `read` returns non-zero at an EOF with no newline. */
export const prCacheLine = (pr: CachedPullRequest): string =>
  [
    pr.branch,
    String(pr.id),
    pr.url,
    String(pr.fetchedAt),
    pr.state,
    pr.draft ? '1' : '0',
    pr.ci,
    pr.review,
  ].join(' ') + '\n';

const PR_STATES = new Set<string>(['open', 'merged', 'declined', 'superseded']);
const CI_STATES = new Set<string>(['pass', 'fail', 'running', 'none']);
const REVIEW_STATES = new Set<string>(['approved', 'changes', 'none']);

/**
 * The inverse, and undefined for anything without at least a branch and a numeric id.
 *
 * Total rather than throwing, because every reader is on a path where "no answer" is normal: the
 * bar prints nothing and `browse` asks Bitbucket instead.
 *
 * Trailing fields are IGNORED rather than rejected, and each known field falls back to a safe
 * value it cannot be confused with. A short line -- one written by an older CLI -- is therefore
 * still a valid record naming a real pull request, with the state fields reading as "nothing to
 * say". Rejecting it would blank the bar on the first run after an upgrade.
 */
export const parsePrCacheLine = (line: string): CachedPullRequest | undefined => {
  const [branch, id, url, fetchedAt, state, draft, ci, review] = line.trim().split(' ');
  if (branch === undefined || branch === '' || id === undefined || url === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(id)) return undefined;
  return {
    branch,
    id: Number(id),
    url,
    fetchedAt: fetchedAt !== undefined && /^\d+$/.test(fetchedAt) ? Number(fetchedAt) : 0,
    state: state !== undefined && PR_STATES.has(state) ? (state as PrState) : 'open',
    draft: draft === '1',
    ci: ci !== undefined && CI_STATES.has(ci) ? (ci as CiState) : 'none',
    review: review !== undefined && REVIEW_STATES.has(review) ? (review as ReviewState) : 'none',
  };
};

/** The cached record for `branch`, or undefined -- including for a line naming another. */
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

/** Older than the TTL, or absent. The one place the freshness rule is spelled out. */
export const prCacheIsStale = (
  cached: CachedPullRequest | undefined,
  ttlSeconds: number,
  now = Math.floor(Date.now() / 1000),
): boolean => cached === undefined || now - cached.fetchedAt >= ttlSeconds;

/**
 * OPEN wins, then whichever was touched last.
 *
 * A branch reused after its first PR merged has two, and the open one is the one being worked on.
 * Falling back to recency rather than to id keeps a reopened PR ahead of a newer declined one.
 */
export const pickPullRequest = (prs: readonly PullRequest[]): PullRequest | undefined =>
  prs.find((pr) => pr.state === 'open') ?? prs[prs.length - 1];

/**
 * What a refresh found: the record it wrote, the pull request behind it, or why neither.
 *
 * `record` present with `pr` absent is the negative case -- asked, none exists -- and is a
 * successful answer rather than a failure. `reason` present is the only failure, and it leaves
 * whatever was on disk alone: a stale value the reader can still draw beats a blank bar, and the
 * next redraw tries again because nothing restamped `fetchedAt`.
 */
export type PrRefresh = {
  readonly pr?: PullRequest | undefined;
  readonly record?: CachedPullRequest | undefined;
  readonly reason?: string | undefined;
};

/**
 * Ask Bitbucket what this branch's pull request is doing, and write the answer down.
 *
 * **The one writer of the cache record**, and that is a correctness property rather than tidiness.
 * `sync`, `browse` and `hangar pr refresh` all come through here, so no path can leave a record
 * that is half-filled but freshly stamped -- which would read as current to the bar and suppress
 * the refresh that would have completed it. It is also why the record is BUILT here and handed
 * back: a caller that assembled its own would be the second writer by another name.
 *
 * Two round trips, ~0.7s together, which is why no caller is on a redraw path. A branch with no
 * pull request costs one: there is no id to ask CI about.
 *
 * `write: false` does everything except touch the disk, so `-n` can report the URL it would have
 * opened. This CLI's `-n` output is its regression record, so a dry run that answered from a cold
 * cache with the search link while the real run answered with the pull request would make the two
 * disagree about the only thing the command prints.
 */
export const refreshPullRequest = async (
  hangar: Hangar,
  clone: Clone,
  branch: string,
  opts: { readonly write?: boolean } = {},
): Promise<PrRefresh> => {
  const ref = repoRef(hangar, clone.path);
  const lookup = await openPullRequests(hangar, ref, branch, { anyState: true });
  if (!lookup.ok) return { reason: lookup.reason };
  const pr = pickPullRequest(lookup.pullRequests);
  const now = Math.floor(Date.now() / 1000);
  /*
   * Only for a PR that is still open. A merged or declined one has a final build result nobody
   * is waiting on, and asking would spend the second round trip on it at every TTL for as long
   * as the branch stays checked out.
   */
  const ci = pr?.state === 'open' ? await pullRequestCiState(hangar, ref, pr.id) : 'none';
  const record: CachedPullRequest =
    pr === undefined
      ? {
          branch,
          id: 0,
          url: prSearchUrl(ref, branch) ?? '-',
          fetchedAt: now,
          state: 'open',
          draft: false,
          ci: 'none',
          review: 'none',
        }
      : {
          branch,
          id: pr.id,
          url: pr.url,
          fetchedAt: now,
          state: pr.state,
          draft: pr.draft,
          ci,
          review: pr.review,
        };
  if (opts.write !== false) writeCachedPr(hangar, clone, record);
  return { pr, record };
};
