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
 * remote got a `status` row linking to storefront_ui's pull requests.
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

export type PullRequest = {
  readonly id: number;
  readonly title: string;
  /** The branch the PR merges INTO, bare -- no `origin/` prefix. */
  readonly destination: string;
  readonly url: string;
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
    return [
      {
        id,
        title: typeof title === 'string' ? title : '',
        destination,
        url: typeof href === 'string' ? href : `${repoUrl(ref)}/pull-requests/${String(id)}`,
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
 * Never throws. Offline, tokenless, 401, malformed JSON: all one soft `ok: false`.
 */
export const openPullRequests = async (
  hangar: Hangar,
  ref: RepoRef | undefined,
  branch: string,
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
  url.searchParams.set('q', `source.branch.name=${quoted(branch)} AND state="OPEN"`);
  url.searchParams.set(
    'fields',
    'values.id,values.title,values.destination.branch.name,values.links.html.href',
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
