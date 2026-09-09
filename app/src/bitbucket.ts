import { readFileSync } from 'node:fs';

import { gitTry } from './git.ts';
import { tildify } from './user-paths.ts';
import type { Hangar } from './hangar.ts';

/**
 * Bitbucket: links that need no auth, and the one lookup that does.
 *
 * A pull request is LINKED by a search URL keyed on the branch -- no credential, no request,
 * and an empty result list is itself a readable answer. That is all `status` needs.
 *
 * Resolving a pull request's TARGET branch is different: nothing local knows it. A branch
 * forked from `master` can perfectly well have a PR onto `release9` or onto another branch in
 * this fleet, and `sync` rebasing it onto `master` would then integrate the wrong base and
 * resolve conflicts against it. So that one question goes to the REST API, authenticated with
 * `BITBUCKET_TOKEN` from `.env.shared` -- an Atlassian API token, which Bitbucket Cloud accepts
 * as a bearer token. Every failure is a soft one: `sync` falls back to the default branch and
 * says the target is a guess.
 */
export type RepoRef = { readonly workspace: string; readonly repo: string };

const parseRemote = (url: string): RepoRef | undefined => {
  const ssh = /^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh?.[1] && ssh[2]) return { workspace: ssh[1], repo: ssh[2] };
  const https = /^https:\/\/[^@]*bitbucket\.org\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (https?.[1] && https[2]) return { workspace: https[1], repo: https[2] };
  return undefined;
};

/**
 * The workspace and repo this clone's origin names, or the hangar's configured origin.
 *
 * `undefined` when neither is a Bitbucket URL, which is the honest answer for a hangar on any
 * other forge: no PR link rather than a link into somebody else's workspace. The fallback used
 * to be two module constants naming THIS repo, so a foreign hangar whose clone had no origin
 * remote got a `status` row linking to the maintainer's own repository's pull requests.
 */
export const repoRef = (hangar: Hangar, clonePath: string): RepoRef | undefined => {
  const url = gitTry(clonePath, ['remote', 'get-url', 'origin']);
  return (
    (url === undefined ? undefined : parseRemote(url)) ?? parseRemote(hangar.config.forge.originUrl)
  );
};

/**
 * Does this hangar talk to Bitbucket at all -- the ONE question three callers were each
 * answering their own way.
 *
 * `forge.kind` is optional in the schema and `repoRef` never reads it: what actually decides is
 * whether the configured origin PARSES as a Bitbucket URL. Meanwhile `setup` keyed its secrets
 * scaffold off `originUrl.includes('bitbucket.org')`, which is a substring test that a host
 * like `notbitbucket.org.example.com` satisfies. Three conditions agreeing by coincidence is how
 * a token gets written under one name and looked for under another.
 *
 * An explicit `kind: none` is honoured as the opt-out it reads as, even for a Bitbucket URL.
 */
export const usesBitbucket = (forge: {
  readonly kind?: 'bitbucketCloud' | 'none' | undefined;
  readonly originUrl: string;
}): boolean => forge.kind !== 'none' && parseRemote(forge.originUrl) !== undefined;

export const repoUrl = (ref: RepoRef): string =>
  `https://bitbucket.org/${ref.workspace}/${ref.repo}`;

/**
 * A pull-request search scoped to the branch. Bitbucket's PR list accepts `query`, so this
 * shows the open PR for the branch if there is one.
 */
export const prSearchUrl = (ref: RepoRef | undefined, branch: string): string | undefined =>
  ref === undefined
    ? undefined
    : `${repoUrl(ref)}/pull-requests/?query=${encodeURIComponent(branch)}`;

/** Where a pull request is in its life. `open` covers a draft; `draft` is a separate axis. */
export type PrState = 'open' | 'merged' | 'declined';

/**
 * What the reviewers have said, collapsed to one answer.
 *
 * Three values and not four: the user-facing "declined" is a property of the PULL REQUEST
 * (`PrState`), not of a review, and folding it in here would make one field mean two things.
 */
export type ReviewState = 'approved' | 'changes' | 'none';

/** What CI has said about the head commit. `none` is "no build reported", not "no news". */
export type CiState = 'pass' | 'fail' | 'running' | 'none';

export type PullRequest = {
  readonly id: number;
  readonly title: string;
  /** The branch the PR merges INTO, bare -- no `origin/` prefix. */
  readonly destination: string;
  readonly url: string;
  readonly state: PrState;
  readonly draft: boolean;
  /** The source commit CI reports against. `''` when the API did not say. */
  readonly headCommit: string;
  readonly review: ReviewState;
};

/**
 * The reviewers' verdict, and **`changes_requested` beats `approved`**.
 *
 * Not a tie-break detail: a pull request with one approval and one change request is BLOCKED,
 * and a bar that showed the approval would be reporting the good half of a mixed answer. Live
 * case measured while this was written -- one reviewer approved, another requested changes on
 * the same PR -- so this is the common shape rather than a corner.
 *
 * `PARTICIPANT` entries are ignored: Bitbucket adds one for anybody who so much as comments, and
 * their `state` is null. Only a `REVIEWER` has been asked for a verdict.
 */
export const reviewStateOf = (
  participants: readonly { readonly role?: string; readonly state?: string | null }[],
): ReviewState => {
  const reviewers = participants.filter((p) => p.role === 'REVIEWER');
  if (reviewers.some((p) => p.state === 'changes_requested')) return 'changes';
  if (reviewers.some((p) => p.state === 'approved')) return 'approved';
  return 'none';
};

/**
 * The build verdict across every status on the commit, **worst state wins**.
 *
 * A commit can carry several: this fleet's CI posts one per Jenkins job, and a green unit-test
 * build beside a red end-to-end one is a red commit. Ordering failure above in-progress is the
 * same argument -- a failure already known does not become provisional because something else
 * is still running.
 *
 * `STOPPED` counts as a failure: a cancelled build did not pass, and reporting it as "no build"
 * would render an identical bar to a commit CI never saw.
 */
export const ciStateOf = (states: readonly string[]): CiState => {
  if (states.some((s) => s === 'FAILED' || s === 'STOPPED')) return 'fail';
  if (states.some((s) => s === 'INPROGRESS')) return 'running';
  if (states.some((s) => s === 'SUCCESSFUL')) return 'pass';
  return 'none';
};

/** Either the open PRs for a branch (possibly none), or why we could not find out. */
export type PullRequestLookup =
  | { readonly ok: true; readonly pullRequests: readonly PullRequest[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A value out of `.env.shared`, for a run that direnv has not set up.
 *
 * Inside a clone the shell already has these exported (`.envrc.private` loads the file), but
 * `hangar` is just as often run from the fleet root, whose `.envrc` only does `PATH_add`.
 * Commented-out lines cannot match: they start with `#`.
 */
const sharedEnvValue = (hangar: Hangar, key: string): string | undefined => {
  let text: string;
  try {
    text = readFileSync(hangar.paths.envShared, 'utf8');
  } catch {
    return undefined;
  }
  const raw = new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim();
  return raw === undefined ? undefined : raw.replace(/^(['"])(.*)\1$/, '$2');
};

/**
 * The variable this adapter reads when `forge.tokenEnvKey` says nothing.
 *
 * The ONE place that names it, on the `DEFAULT_EDITOR_KIND` precedent: `setup` writes it into
 * the config template and into the secrets scaffold, `secrets.ts` derives a `doctor` row from
 * it, and this module reads the value. Four literals would be four things to keep in agreement,
 * and the failure is silent -- a token under the wrong name is indistinguishable from no token.
 */
export const DEFAULT_BITBUCKET_TOKEN_ENV_KEY = 'BITBUCKET_TOKEN';

/**
 * `forge.tokenEnvKey`, honoured -- it was a config key nothing read.
 *
 * The schema has carried it since the config existed and this function ignored it, so a hangar
 * that named a different variable got a `sync` that looked for `BITBUCKET_TOKEN`, did not find
 * it, and reported the target branch as a guess. A soft failure with a correct-looking config
 * above it is the shape of wrong answer this CLI is built against.
 */
const bitbucketToken = (hangar: Hangar): string | undefined => {
  const key = hangar.config.forge.tokenEnvKey ?? DEFAULT_BITBUCKET_TOKEN_ENV_KEY;
  const fromEnv = process.env[key];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : sharedEnvValue(hangar, key);
};

/** Bitbucket's query language quotes string literals, so a branch name has to be escaped. */
const quoted = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** Bitbucket's `state` strings, mapped to ours. Anything unrecognised reads as still open. */
const prStateOf = (raw: unknown): PrState =>
  raw === 'MERGED' ? 'merged' : raw === 'DECLINED' ? 'declined' : 'open';

const parseParticipants = (raw: unknown): ReviewState => {
  if (!Array.isArray(raw)) return 'none';
  return reviewStateOf(
    raw.flatMap((value: unknown) => {
      const p = asRecord(value);
      if (p === undefined) return [];
      const role = p['role'];
      const state = p['state'];
      return [
        {
          ...(typeof role === 'string' ? { role } : {}),
          ...(typeof state === 'string' ? { state } : {}),
        },
      ];
    }),
  );
};

const parsePullRequests = (body: unknown, ref: RepoRef): PullRequest[] => {
  const values = asRecord(body)?.['values'];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value: unknown): PullRequest[] => {
    const pr = asRecord(value);
    const id = pr?.['id'];
    const destination = asRecord(asRecord(pr?.['destination'])?.['branch'])?.['name'];
    if (typeof id !== 'number' || typeof destination !== 'string' || destination === '') return [];
    const title = pr?.['title'];
    const href = asRecord(asRecord(pr?.['links'])?.['html'])?.['href'];
    const head = asRecord(asRecord(pr?.['source'])?.['commit'])?.['hash'];
    return [
      {
        id,
        title: typeof title === 'string' ? title : '',
        destination,
        url: typeof href === 'string' ? href : `${repoUrl(ref)}/pull-requests/${String(id)}`,
        state: prStateOf(pr?.['state']),
        draft: pr?.['draft'] === true,
        headCommit: typeof head === 'string' ? head : '',
        review: parseParticipants(pr?.['participants']),
      },
    ];
  });
};

/** Enough for one API call over a VPN, short enough that an offline `sync --all` still ends. */
const TIMEOUT_MS = 8000;

/**
 * The OPEN pull requests whose source is `branch`.
 *
 * `state` goes inside `q`, not beside it: as its own parameter it is silently ignored whenever
 * `q` is present, and a query for `master` then comes back full of PRs merged years ago --
 * which as a sync target would be catastrophic and would look deliberate.
 *
 * **`anyState` is opt-in for exactly that reason.** The bar wants to say "declined", which needs
 * the closed ones; `sync` picks `pullRequests[0]` as the branch to rebase ONTO, so handing it a
 * PR merged last spring would rebase onto a stale base and resolve conflicts against it. The
 * caller that can survive the extra rows asks for them, and the default stays the safe one.
 *
 * Never throws. Offline, tokenless, 401, malformed JSON: all one soft `ok: false`.
 */
export const openPullRequests = async (
  hangar: Hangar,
  ref: RepoRef | undefined,
  branch: string,
  opts: { readonly anyState?: boolean } = {},
): Promise<PullRequestLookup> => {
  /*
   * No recognisable Bitbucket repo is a SOFT failure, like every other one here.
   *
   * `repoRef` returns undefined when neither the clone's origin nor `forge.originUrl` parses as
   * a Bitbucket URL -- a hangar on any other forge. `sync` then falls back to the default branch
   * and says the target is a guess, which is what it already does without a token. Throwing
   * would make a foreign hangar unable to sync at all.
   */
  if (ref === undefined) {
    return { ok: false, reason: 'forge.originUrl is not a Bitbucket repository' };
  }
  const token = bitbucketToken(hangar);
  if (token === undefined) {
    return {
      ok: false,
      reason: `no ${hangar.config.forge.tokenEnvKey ?? DEFAULT_BITBUCKET_TOKEN_ENV_KEY} in the environment or ${tildify(hangar.paths.envShared)}`,
    };
  }
  const url = new URL(
    `https://api.bitbucket.org/2.0/repositories/${ref.workspace}/${ref.repo}/pullrequests`,
  );
  const source = `source.branch.name=${quoted(branch)}`;
  url.searchParams.set('q', opts.anyState === true ? source : `${source} AND state="OPEN"`);
  url.searchParams.set(
    'fields',
    'values.id,values.title,values.destination.branch.name,values.links.html.href,' +
      'values.state,values.draft,values.source.commit.hash,' +
      'values.participants.role,values.participants.state,values.updated_on',
  );
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `Bitbucket API answered ${String(res.status)} ${res.statusText}`,
      };
    }
    return { ok: true, pullRequests: parsePullRequests(await res.json(), ref) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * What CI says about a pull request's head commit.
 *
 * `/pullrequests/{id}/statuses` rather than `/commit/{sha}/statuses`: both answer, and the first
 * needs no commit hash, so a PR whose `source.commit.hash` the list call omitted is still
 * covered. This is the generic build-status API every CI integration writes into -- this fleet's
 * is Jenkins, and nothing here is specific to it.
 *
 * Soft-failing like everything else in this module, and `none` is the answer for a real failure
 * as well as for a commit with no builds. That collapse is deliberate: the bar has one character
 * to say this in, and "CI is quiet" and "we could not ask" render the same either way. The
 * commands that can afford a sentence report the reason instead.
 */
export const pullRequestCiState = async (
  hangar: Hangar,
  ref: RepoRef | undefined,
  id: number,
): Promise<CiState> => {
  const token = bitbucketToken(hangar);
  if (ref === undefined || token === undefined) return 'none';
  const url = new URL(
    `https://api.bitbucket.org/2.0/repositories/${ref.workspace}/${ref.repo}/pullrequests/${String(id)}/statuses`,
  );
  url.searchParams.set('fields', 'values.state');
  url.searchParams.set('pagelen', '50');
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return 'none';
    const values = asRecord(await res.json())?.['values'];
    if (!Array.isArray(values)) return 'none';
    return ciStateOf(
      values.flatMap((value: unknown) => {
        const state = asRecord(value)?.['state'];
        return typeof state === 'string' ? [state] : [];
      }),
    );
  } catch {
    return 'none';
  }
};
