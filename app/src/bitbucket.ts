import { readFileSync } from 'node:fs';

import { gitTry } from './git.ts';
import { bitbucketWorkspaceUrl, bitbucketRepo, envShared, tildify } from './paths.ts';

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

export const repoRef = (clonePath: string): RepoRef => {
  const url = gitTry(clonePath, ['remote', 'get-url', 'origin']);
  return (
    (url === undefined ? undefined : parseRemote(url)) ?? {
      workspace: bitbucketWorkspaceUrl.split('/').pop() ?? 'acme',
      repo: bitbucketRepo,
    }
  );
};

export const repoUrl = (ref: RepoRef): string =>
  `https://bitbucket.org/${ref.workspace}/${ref.repo}`;

/**
 * A pull-request search scoped to the branch. Bitbucket's PR list accepts `query`, so this
 * shows the open PR for the branch if there is one.
 */
export const prSearchUrl = (ref: RepoRef, branch: string): string =>
  `${repoUrl(ref)}/pull-requests/?query=${encodeURIComponent(branch)}`;

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
const sharedEnvValue = (key: string): string | undefined => {
  let text: string;
  try {
    text = readFileSync(envShared, 'utf8');
  } catch {
    return undefined;
  }
  const raw = new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim();
  return raw === undefined ? undefined : raw.replace(/^(['"])(.*)\1$/, '$2');
};

const bitbucketToken = (): string | undefined => {
  const fromEnv = process.env['BITBUCKET_TOKEN'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : sharedEnvValue('BITBUCKET_TOKEN');
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
  ref: RepoRef,
  branch: string,
): Promise<PullRequestLookup> => {
  const token = bitbucketToken();
  if (token === undefined) {
    return { ok: false, reason: `no BITBUCKET_TOKEN in the environment or ${tildify(envShared)}` };
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
