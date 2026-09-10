import { readFileSync } from 'node:fs';

import { gitTry } from './git.ts';
import { tildify } from './user-paths.ts';
import type { Hangar } from './hangar.ts';

/**
 * Bitbucket: links that need no auth, the lookups that do, and the two writes.
 *
 * A pull request is LINKED by a search URL keyed on the branch -- no credential, no request,
 * and an empty result list is itself a readable answer. That is all `status` needs.
 *
 * **Everything that reads here soft-fails and everything that WRITES does not**, and that
 * inversion is the rule to keep in mind before adding to this file. A failed read means a
 * `status` row with less on it or a `sync` that says its target is a guess; a failed write is a
 * pull request that may or may not now exist on somebody else's screen, so `createPullRequest`
 * and `setPullRequest` return a reason their caller aborts on rather than a soft `undefined`.
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

/**
 * Where a pull request is in its life. `open` covers a draft; `draft` is a separate axis.
 *
 * Four values, because the published API schema says four (`OPEN`, `MERGED`, `DECLINED`,
 * `SUPERSEDED`). `superseded` was missing here and fell through to `open`, which is the wrong
 * default in both directions: the bar drew a dead pull request as live, and `pr update` -- which
 * the API allows on OPEN ones only -- would try to rewrite it and hand back Bitbucket's refusal
 * instead of its own.
 */
export type PrState = 'open' | 'merged' | 'declined' | 'superseded';

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
  /**
   * The author's account uuid, bare. `''` when the API did not say.
   *
   * Read for one purpose: `pr update` rewrites only pull requests the token owner authored. The
   * API itself permits rewriting anybody's, so that restriction has to be enforced by comparing
   * this against `tokenOwner` -- there is no permission to delegate it to.
   */
  readonly author: string;
  /** The author's display name, for a refusal a human can act on. `''` when unsaid. */
  readonly authorName: string;
};

/**
 * Bitbucket wraps account uuids in braces (`{9d0c...}`) in some payloads and not in others.
 *
 * So both sides of the ownership comparison go through this. Comparing the raw strings would make
 * the check answer "not yours" for your own pull request whenever the two payloads disagreed about
 * the braces -- which fails in the safe direction and would therefore never be investigated.
 */
export const bareUuid = (raw: string): string => raw.replace(/^\{/, '').replace(/\}$/, '');

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

/**
 * Bitbucket's `state` strings, mapped to ours. Anything unrecognised reads as still open.
 *
 * The four cases are the enum in the published schema, checked against it rather than collected
 * from what this fleet happened to return. The `open` fallback stays for a fifth value nobody has
 * seen yet: a pull request whose state we cannot name is more usefully treated as live than as
 * settled, because that is the reading under which somebody looks at it.
 */
const prStateOf = (raw: unknown): PrState =>
  raw === 'MERGED'
    ? 'merged'
    : raw === 'DECLINED'
      ? 'declined'
      : raw === 'SUPERSEDED'
        ? 'superseded'
        : 'open';

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

/**
 * One pull request out of whatever shape it arrived in, or nothing.
 *
 * The single parser, because there are now three payloads carrying a pull request -- the list, the
 * `POST` response and the `PUT` response -- and the whole point of reading the write responses back
 * is that they are parsed exactly as a read is. A second parser for the write path would be free to
 * disagree with this one about a field, which is the one thing the read-back cannot afford.
 */
const parseOnePullRequest = (value: unknown, ref: RepoRef): PullRequest | undefined => {
  const pr = asRecord(value);
  const id = pr?.['id'];
  const destination = asRecord(asRecord(pr?.['destination'])?.['branch'])?.['name'];
  if (typeof id !== 'number' || typeof destination !== 'string' || destination === '') {
    return undefined;
  }
  const title = pr?.['title'];
  const href = asRecord(asRecord(pr?.['links'])?.['html'])?.['href'];
  const head = asRecord(asRecord(pr?.['source'])?.['commit'])?.['hash'];
  const author = asRecord(pr?.['author'])?.['uuid'];
  const authorName = asRecord(pr?.['author'])?.['display_name'];
  return {
    id,
    title: typeof title === 'string' ? title : '',
    destination,
    url: typeof href === 'string' ? href : `${repoUrl(ref)}/pull-requests/${String(id)}`,
    state: prStateOf(pr?.['state']),
    draft: pr?.['draft'] === true,
    headCommit: typeof head === 'string' ? head : '',
    review: parseParticipants(pr?.['participants']),
    author: typeof author === 'string' ? bareUuid(author) : '',
    authorName: typeof authorName === 'string' ? authorName : '',
  };
};

const parsePullRequests = (body: unknown, ref: RepoRef): PullRequest[] => {
  const values = asRecord(body)?.['values'];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value: unknown) => parseOnePullRequest(value, ref) ?? []);
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
 * **The published schema is right about `state` and silent about the PRECEDENCE**, which is the
 * part that bites. `state` is a documented query parameter with a four-value enum and it works
 * exactly as written on its own -- measured, `state=OPEN` answers 4 and `state=MERGED` answers
 * 748 on this repo. What no published document says is that `q` REPLACES it: with a `q` present
 * the `state` parameter is ignored, measured on a branch carrying a single MERGED pull request
 * where `q=source.branch.name="x"` plus `state=OPEN` returned the merged one and
 * `q=source.branch.name="x" AND state="OPEN"` returned nothing.
 *
 * So an audit that reads the spec and "corrects" this to the documented parameter would be
 * following the documentation and would hand `sync` a base that was merged last spring. The
 * filter has to live inside `q` because `q` is what this call already uses to select the branch.
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
      'values.author.uuid,values.author.display_name,' +
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

/**
 * Either the answer, or one sentence saying why there is none.
 *
 * The write path's counterpart to `PullRequestLookup`, and deliberately NOT the same shape as a
 * soft failure: `openPullRequests` returning `ok: false` means "carry on without it", and every
 * caller does. A write returning `ok: false` means STOP, and its reason is what the command
 * prints before it does.
 */
export type ForgeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const apiUrl = (ref: RepoRef, path: string): URL =>
  new URL(`https://api.bitbucket.org/2.0/repositories/${ref.workspace}/${ref.repo}${path}`);

/**
 * Bitbucket's own error text, which is the half of a 400 worth reading.
 *
 * `POST /pullrequests` answers a missing source branch, a destination that does not exist and a
 * duplicate with three different messages under one status code, and the status alone would send
 * the operator to look at the wrong thing.
 */
const errorMessageIn = (body: unknown): string | undefined => {
  const message = asRecord(asRecord(body)?.['error'])?.['message'];
  return typeof message === 'string' && message !== '' ? message : undefined;
};

/**
 * One authenticated JSON request, and the one place a write's failure becomes a sentence.
 *
 * Every failure is caught: an unroutable host, a timeout, a 401, a 400 with Bitbucket's own
 * explanation, and a body that is not JSON at all. What it never does is throw -- a caller that
 * has just posted needs to report what happened, and an exception thrown past it would lose the
 * one thing it knows.
 */
const request = async (
  hangar: Hangar,
  url: URL,
  init: { readonly method: string; readonly body?: unknown } = { method: 'GET' },
): Promise<ForgeResult<unknown>> => {
  const token = bitbucketToken(hangar);
  if (token === undefined) {
    return {
      ok: false,
      reason: `no ${hangar.config.forge.tokenEnvKey ?? DEFAULT_BITBUCKET_TOKEN_ENV_KEY} in the environment or ${tildify(hangar.paths.envShared)}`,
    };
  }
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    /*
     * The body is read before the status is judged, because that is where the explanation is.
     * A `.json()` on an error response can itself fail (Bitbucket answers HTML for some
     * gateway errors), which is why it is inside the try and why the status is still reported
     * when it does.
     */
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const detail = errorMessageIn(body);
      return {
        ok: false,
        reason: `Bitbucket answered ${String(res.status)} ${res.statusText}${detail === undefined ? '' : ` — ${detail}`}`,
      };
    }
    return { ok: true, value: body };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Whose token this is, as a bare account uuid.
 *
 * The other half of `pr update`'s ownership rule, and it has to be able to FAIL: an access token
 * scoped to a repository rather than to a person is a perfectly valid credential for everything
 * else in this module and answers 401 here. That is not permission to skip the check -- a command
 * that cannot tell whose pull request it is looking at has no business rewriting it -- so this
 * returns a reason and the command stops on it.
 */
export const tokenOwner = async (hangar: Hangar): Promise<ForgeResult<string>> => {
  const res = await request(hangar, new URL('https://api.bitbucket.org/2.0/user'));
  if (!res.ok) return res;
  const uuid = asRecord(res.value)?.['uuid'];
  if (typeof uuid !== 'string' || uuid === '') {
    return { ok: false, reason: 'Bitbucket did not say who this token belongs to' };
  }
  return { ok: true, value: bareUuid(uuid) };
};

/**
 * One pull request in full, including the fields a rewrite has to put back.
 *
 * Separate from `openPullRequests` rather than an option on it, because `description` is the
 * expensive field: the list is asked for by `sync` and by the bar's own refresh, and carrying
 * every pull request's whole body through those would be paid on a path that never reads it.
 */
export type PullRequestDetail = {
  readonly pr: PullRequest;
  readonly description: string;
  /** The source branch, bare. Read back so an edit cannot retarget a pull request by accident. */
  readonly source: string;
  readonly closeSourceBranch: boolean;
  readonly reviewerUuids: readonly string[];
};

/**
 * One pull request's full record out of any of the three payloads that carry one.
 *
 * The same parser for the read and for both writes, which is what makes the read-back mean
 * something: a second parser for the write responses would be free to disagree with this one
 * about a field, and disagreeing about a field is precisely what the read-back is looking for.
 */
const parseDetail = (value: unknown, ref: RepoRef): PullRequestDetail | undefined => {
  const pr = parseOnePullRequest(value, ref);
  if (pr === undefined) return undefined;
  const record = asRecord(value);
  /*
   * `summary.raw` FIRST, `description` second, and both are asked for.
   *
   * The body of a pull request is documented under two names and the published schema carries
   * only one of them: `description` is the field the create and update calls TAKE (documented in
   * the prose of `POST /pullrequests`, and absent from the `pullrequest` schema), while `summary`
   * -- a rendered-content object with `raw`, `markup` and `html` -- is what the schema declares on
   * the way out. The live API returns both, byte-identical: same sha256 over 3235 characters on
   * the pull request this was checked against, `markup: markdown`.
   *
   * So the documented read is preferred and the undocumented one is the fallback, which is the
   * right way round for a field this code sends straight back: `pr update` is a read-modify-write,
   * and a body that read as empty would REPLACE somebody's description with nothing.
   */
  const summaryRaw = asRecord(record?.['summary'])?.['raw'];
  const description = typeof summaryRaw === 'string' ? summaryRaw : record?.['description'];
  const source = asRecord(asRecord(record?.['source'])?.['branch'])?.['name'];
  const reviewers = record?.['reviewers'];
  return {
    pr,
    description: typeof description === 'string' ? description : '',
    source: typeof source === 'string' ? source : '',
    closeSourceBranch: record?.['close_source_branch'] === true,
    reviewerUuids: Array.isArray(reviewers)
      ? reviewers.flatMap((entry: unknown) => {
          const uuid = asRecord(entry)?.['uuid'];
          return typeof uuid === 'string' ? [uuid] : [];
        })
      : [],
  };
};

/** The fields a full record needs. One list, so a read and a write read back the same shape. */
const DETAIL_FIELDS =
  'id,title,description,summary.raw,state,draft,close_source_branch,destination.branch.name,' +
  'source.branch.name,source.commit.hash,links.html.href,author.uuid,author.display_name,' +
  'reviewers.uuid,participants.role,participants.state';

export const pullRequestDetail = async (
  hangar: Hangar,
  ref: RepoRef | undefined,
  id: number,
): Promise<ForgeResult<PullRequestDetail>> => {
  if (ref === undefined) {
    return { ok: false, reason: 'forge.originUrl is not a Bitbucket repository' };
  }
  const url = apiUrl(ref, `/pullrequests/${String(id)}`);
  url.searchParams.set('fields', DETAIL_FIELDS);
  const res = await request(hangar, url);
  if (!res.ok) return res;
  const detail = parseDetail(res.value, ref);
  return detail === undefined
    ? { ok: false, reason: `Bitbucket's answer for #${String(id)} named no destination branch` }
    : { ok: true, value: detail };
};

export type NewPullRequest = {
  readonly source: string;
  readonly destination: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
};

/**
 * Open one, and hand back what Bitbucket says it made.
 *
 * **The returned record is PARSED FROM THE RESPONSE, never assembled from the input**, and that is
 * the whole design of this function. Bitbucket silently accepts and drops fields it does not
 * recognise -- the reason the create form's `title=` parameter was documented as working for months
 * when it never was -- so a caller that reported its own inputs back would be unable to tell a
 * field that took from one that was thrown away. Handing back the parsed answer makes the
 * comparison the caller's, and it has the information to make it.
 */
export const createPullRequest = async (
  hangar: Hangar,
  ref: RepoRef | undefined,
  input: NewPullRequest,
): Promise<ForgeResult<PullRequestDetail>> => {
  if (ref === undefined) {
    return { ok: false, reason: 'forge.originUrl is not a Bitbucket repository' };
  }
  const url = apiUrl(ref, '/pullrequests');
  url.searchParams.set('fields', DETAIL_FIELDS);
  const res = await request(hangar, url, {
    method: 'POST',
    body: {
      title: input.title,
      description: input.body,
      source: { branch: { name: input.source } },
      destination: { branch: { name: input.destination } },
      draft: input.draft,
    },
  });
  if (!res.ok) return res;
  const detail = parseDetail(res.value, ref);
  return detail === undefined
    ? {
        ok: false,
        reason:
          'Bitbucket accepted the pull request but its answer could not be read — check the repository before retrying',
      }
    : { ok: true, value: detail };
};

/**
 * Every field a rewrite sends, named -- which is what makes read-modify-write checkable.
 *
 * The published documentation for the update call is three sentences long and says nothing about
 * what happens to a field the body omits -- so whether a partial `PUT` preserves or clears
 * `reviewers` is not something either spec answers, and finding out costs somebody's review
 * assignments. A description edit that silently un-assigned three reviewers is a change nobody
 * asked for and nobody would attribute to this command, so every field is sent every time: the
 * type has no optional members except the one that genuinely means "leave it alone", and a caller
 * builds it from `pullRequestDetail` with its own changes layered on top.
 */
export type PullRequestEdit = {
  readonly title: string;
  readonly description: string;
  readonly destination: string;
  readonly closeSourceBranch: boolean;
  readonly reviewerUuids: readonly string[];
  /**
   * Present only to CHANGE the draft state; absent leaves it as it is.
   *
   * Absent rather than carried, unlike everything else here, and the asymmetry is deliberate: an
   * update is about the title and the body, and a `draft` key on every rewrite would make this
   * command able to publish a draft as a side effect of fixing a typo in it. Absent is also the
   * safer bet against the API -- if `draft` turns out not to be writable through this endpoint at
   * all, an ordinary update never carries it and so never trips over that.
   */
  readonly draft?: boolean | undefined;
};

export const setPullRequest = async (
  hangar: Hangar,
  ref: RepoRef | undefined,
  id: number,
  edit: PullRequestEdit,
): Promise<ForgeResult<PullRequestDetail>> => {
  if (ref === undefined) {
    return { ok: false, reason: 'forge.originUrl is not a Bitbucket repository' };
  }
  const url = apiUrl(ref, `/pullrequests/${String(id)}`);
  url.searchParams.set('fields', DETAIL_FIELDS);
  const res = await request(hangar, url, {
    method: 'PUT',
    body: {
      title: edit.title,
      description: edit.description,
      destination: { branch: { name: edit.destination } },
      close_source_branch: edit.closeSourceBranch,
      reviewers: edit.reviewerUuids.map((uuid) => ({ uuid })),
      ...(edit.draft === undefined ? {} : { draft: edit.draft }),
    },
  });
  if (!res.ok) return res;
  const detail = parseDetail(res.value, ref);
  return detail === undefined
    ? { ok: false, reason: `Bitbucket's answer for #${String(id)} could not be read` }
    : { ok: true, value: detail };
};
