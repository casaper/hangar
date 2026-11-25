import { sharedEnvValue, type ForgeResult } from './bitbucket.ts';
import type { CiConfig } from './config/schema.ts';
import type { Hangar } from './hangar.ts';
import { tildify } from './user-paths.ts';

/**
 * Jenkins, read only: the client `hangar ci` reads build state, logs and test reports through.
 *
 * **Every request is a GET, and nothing here can be extended into a write by a flag.** A clone
 * session runs `hangar ci` unprompted, so a rebuild, replay or abort reachable from it would be
 * an agent acting on shared CI with nobody asked.
 *
 * **Credentials go only to URLs under `ci.baseUrl`.** A build URL arrives from a forge status,
 * which anyone who can post a status writes, or from an argument an agent typed. `isUnderBase`
 * refuses anything else before a request is built, so a status linking to some other host is
 * shown and never fetched with the user's token.
 *
 * Every parser is PURE and exported, for the same reason as every builder in this CLI: Jenkins'
 * JSON can be asserted against without a Jenkins, which this suite does not have.
 */

/** A connect that has not answered in this long is a VPN that is off, not a slow server. */
const CONNECT_TIMEOUT_MS = 10_000;
/** A whole console log can be tens of megabytes on a slow link. */
const TEXT_TIMEOUT_MS = 60_000;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Whether `url` lies on the configured server: same origin, and under its path. PURE. */
export const isUnderBase = (url: string, baseUrl: string): boolean => {
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(baseUrl);
  } catch {
    return false;
  }
  if (u.origin !== b.origin) return false;
  const basePath = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`;
  return `${u.pathname}/`.startsWith(basePath);
};

/**
 * The build's own root, `<…>/job/<job>/job/<branch>/<number>/`, from whatever page a status or a
 * person pointed at. PURE; `undefined` when the URL names no build.
 *
 * The Bitbucket integration links `<build>/display/redirect`, and a person pastes `console`,
 * `consoleFull` or a stage view. Each of those is the same build. Blue Ocean's
 * `/blue/organizations/jenkins/<job>/detail/<branch>/<n>/…` is mapped to the classic path, where
 * the JSON APIs live: the job segment there is URL-encoded once with `%2F` between folders, and
 * the branch is encoded once where the classic path encodes it twice (`feature%252Fx`).
 */
export const buildRoot = (url: string): string | undefined => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const blue = /^(.*?)\/blue\/organizations\/jenkins\/([^/]+)\/detail\/([^/]+)\/(\d+)(?:\/|$)/.exec(
    u.pathname,
  );
  if (blue) {
    const [, prefix = '', job = '', branch = '', number = ''] = blue;
    const jobPath = decodeURIComponent(job)
      .split('/')
      .map((segment) => `job/${encodeURIComponent(segment)}`)
      .join('/');
    const branchSegment = encodeURIComponent(decodeURIComponent(branch));
    return `${u.origin}${prefix}/${jobPath}/job/${encodeURIComponent(branchSegment)}/${number}/`;
  }
  const classic = /^(.*\/job\/[^/]+\/(?:\d+|last[A-Za-z]*Build))(?:\/|$)/.exec(u.pathname);
  return classic?.[1] === undefined ? undefined : `${u.origin}${classic[1]}/`;
};

/**
 * The job (or multibranch branch) a build root belongs to, for display. PURE.
 * `…/job/app/job/feature%252Fx/12/` reads as `app » feature/x #12`.
 */
export const buildLabel = (root: string): string => {
  const path = (() => {
    try {
      return new URL(root).pathname;
    } catch {
      return root;
    }
  })();
  const names = [...path.matchAll(/\/job\/([^/]+)/g)].map((m) => {
    let name = m[1] ?? '';
    // Decoded until stable: a multibranch branch is encoded twice in the classic path.
    for (let i = 0; i < 3 && /%[0-9A-Fa-f]{2}/.test(name); i += 1) {
      try {
        name = decodeURIComponent(name);
      } catch {
        break;
      }
    }
    return name;
  });
  const number = /\/(\d+|last[A-Za-z]*Build)\/?$/.exec(path)?.[1];
  return `${names.join(' » ')}${number === undefined ? '' : /^\d+$/.test(number) ? ` #${number}` : ` ${number}`}`;
};

/** A stage of a pipeline run, as Stage View's `wfapi/describe` reports it. */
export type Stage = { readonly id: string; readonly name: string; readonly status: string };

/** The run's overall status and every stage, out of `wfapi/describe`. PURE. */
export const parseRun = (body: unknown): { status: string; stages: Stage[] } => {
  const run = asRecord(body);
  const stages = Array.isArray(run?.['stages']) ? (run['stages'] as unknown[]) : [];
  return {
    status: str(run?.['status']),
    stages: stages.flatMap((value) => {
      const s = asRecord(value);
      const id = s?.['id'];
      if (typeof id !== 'string' && typeof id !== 'number') return [];
      return [{ id: String(id), name: str(s?.['name']), status: str(s?.['status']) }];
    }),
  };
};

const BAD_STATUSES = new Set(['FAILED', 'UNSTABLE', 'ABORTED']);

/**
 * The stages worth reading, in run order. PURE.
 *
 * `FAILED` first, because one failed stage usually aborts the rest and they then report
 * `ABORTED` or `NOT_EXECUTED` -- those are a consequence, and reading them first wastes the
 * reader's attention on a stage that did nothing wrong. Only when nothing FAILED do `UNSTABLE`
 * (a test stage that recorded failures) and `ABORTED` count.
 */
export const badStages = (stages: readonly Stage[]): Stage[] => {
  const failed = stages.filter((s) => s.status === 'FAILED');
  return failed.length > 0 ? failed : stages.filter((s) => BAD_STATUSES.has(s.status));
};

/** One step of a stage, from `execution/node/<stage>/wfapi/describe`. */
export type FlowNode = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  /** What the step was given -- for `sh`, the script's first line. */
  readonly detail: string;
};

/** The steps of one stage. PURE. */
export const parseStageNodes = (body: unknown): FlowNode[] => {
  const nodes = asRecord(body)?.['stageFlowNodes'];
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((value: unknown) => {
    const n = asRecord(value);
    const id = n?.['id'];
    if (typeof id !== 'string' && typeof id !== 'number') return [];
    return [
      {
        id: String(id),
        name: str(n?.['name']),
        status: str(n?.['status']),
        detail: str(n?.['parameterDescription']),
      },
    ];
  });
};

/**
 * Text out of the HTML Jenkins wraps a node log in. PURE.
 *
 * `wfapi/log` answers JSON whose `text` is console HTML: `<span>`s for timestamps and colour,
 * `<a>`s for links, and the five entities. Only those are undone -- this is not an HTML parser
 * and is not used on anything but a console fragment.
 */
export const consoleHtmlToText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** A node's log out of `wfapi/log`, and whether Jenkins cut it short. PURE. */
export const parseNodeLog = (body: unknown): { text: string; truncated: boolean } => {
  const log = asRecord(body);
  return { text: consoleHtmlToText(str(log?.['text'])), truncated: log?.['hasMore'] === true };
};

/** One failed test case. */
export type FailedTest = {
  readonly suite: string;
  readonly name: string;
  readonly className: string;
  readonly error: string;
  readonly stack: string;
};

/** `FAILED` is a case failing for the second build running, `REGRESSION` for the first. */
const FAILING_CASES = new Set(['FAILED', 'REGRESSION']);

/** The failed cases out of `testReport/api/json`. PURE. */
export const parseFailedTests = (body: unknown): FailedTest[] => {
  const suites = asRecord(body)?.['suites'];
  if (!Array.isArray(suites)) return [];
  return suites.flatMap((suiteValue: unknown) => {
    const suite = asRecord(suiteValue);
    const cases = suite?.['cases'];
    if (!Array.isArray(cases)) return [];
    return cases.flatMap((caseValue: unknown) => {
      const c = asRecord(caseValue);
      if (!FAILING_CASES.has(str(c?.['status']))) return [];
      return [
        {
          suite: str(suite?.['name']),
          name: str(c?.['name']),
          className: str(c?.['className']),
          error: str(c?.['errorDetails']),
          stack: str(c?.['errorStackTrace']),
        },
      ];
    });
  });
};

/** One job, or one branch of a multibranch job. */
export type JenkinsJob = {
  readonly name: string;
  readonly url: string;
  /** Jenkins' ball colour: `blue`, `red`, `yellow`, `notbuilt`, `disabled`, `aborted`, `*_anime`. */
  readonly color: string;
  readonly children: readonly JenkinsJob[];
};

/** `api/json?tree=jobs[name,url,color,jobs[name,url,color]]`. PURE. */
export const parseJobs = (body: unknown): JenkinsJob[] => {
  const jobs = asRecord(body)?.['jobs'];
  if (!Array.isArray(jobs)) return [];
  return jobs.flatMap((value: unknown) => {
    const j = asRecord(value);
    const name = str(j?.['name']);
    if (name === '') return [];
    return [{ name, url: str(j?.['url']), color: str(j?.['color']), children: parseJobs(j) }];
  });
};

/**
 * The lines of a log worth printing. PURE.
 *
 * `grep` keeps matching lines with `context` lines either side, then `tail` keeps the last N of
 * what is left. A failure is almost always at the end, and an agent reading 40k lines of
 * `npm ci` to find it spends its context on the wrong thing.
 */
export const trimLog = (
  text: string,
  opts: {
    readonly tail: number | undefined;
    readonly grep: RegExp | undefined;
    readonly context: number;
  },
): { lines: string[]; omitted: number } => {
  const all = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  let kept = all;
  if (opts.grep !== undefined) {
    const keep = new Set<number>();
    all.forEach((line, i) => {
      if (!opts.grep?.test(line)) return;
      for (
        let j = Math.max(0, i - opts.context);
        j <= Math.min(all.length - 1, i + opts.context);
        j += 1
      ) {
        keep.add(j);
      }
    });
    kept = all.filter((_, i) => keep.has(i));
  }
  if (opts.tail !== undefined && kept.length > opts.tail) {
    return { lines: kept.slice(kept.length - opts.tail), omitted: all.length - opts.tail };
  }
  return { lines: kept, omitted: all.length - kept.length };
};

/** The reason a request could not be made or answered, in one sentence. PURE. */
export const describeFailure = (
  ci: CiConfig,
  failure:
    | { readonly kind: 'unreachable'; readonly detail: string }
    | { readonly kind: 'http'; readonly status: number; readonly url: string }
    | { readonly kind: 'foreign'; readonly url: string },
): string => {
  const host = (() => {
    try {
      return new URL(ci.baseUrl).host;
    } catch {
      return ci.baseUrl;
    }
  })();
  switch (failure.kind) {
    case 'unreachable':
      return `Jenkins at ${host} is unreachable (${failure.detail}) — if it is behind a VPN, that is probably off; connect it rather than retrying`;
    case 'http':
      return failure.status === 401 || failure.status === 403
        ? `Jenkins refused the credentials (HTTP ${String(failure.status)}) — check ${ci.userEnvKey} and ${ci.tokenEnvKey}`
        : failure.status === 404
          ? `Jenkins has nothing at ${failure.url} (HTTP 404)`
          : `Jenkins answered HTTP ${String(failure.status)} for ${failure.url}`;
    case 'foreign':
      return `${failure.url} is not under ci.baseUrl (${ci.baseUrl}) — not fetched, so no credential is sent to it`;
  }
};

/** The connection error's own code, which is what tells a VPN that is off from a typo. */
const networkDetail = (error: unknown): string => {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'no answer in time';
  }
  const cause = error instanceof Error ? asRecord(error.cause) : undefined;
  const code = cause?.['code'];
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : String(error);
};

/** `ci`, or the refusal naming the key that is missing. */
export const requireCi = (hangar: Hangar): ForgeResult<CiConfig> =>
  hangar.config.ci === undefined
    ? {
        ok: false,
        reason: `no ci block in ${tildify(hangar.paths.configFile)} — hangar ci needs ci.kind, ci.baseUrl, ci.userEnvKey and ci.tokenEnvKey`,
      }
    : { ok: true, value: hangar.config.ci };

const credential = (hangar: Hangar, key: string): string | undefined => {
  const fromEnv = process.env[key];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : sharedEnvValue(hangar, key);
};

/**
 * One GET against the configured server, as JSON or as text.
 *
 * The basic-auth header is built here and nowhere else, after `isUnderBase` has passed -- the
 * only place a credential and a URL meet.
 */
export const jenkinsGet = async (
  hangar: Hangar,
  ci: CiConfig,
  url: string,
  as: 'json' | 'text',
): Promise<ForgeResult<unknown>> => {
  if (!isUnderBase(url, ci.baseUrl)) {
    return { ok: false, reason: describeFailure(ci, { kind: 'foreign', url }) };
  }
  const user = credential(hangar, ci.userEnvKey);
  const token = credential(hangar, ci.tokenEnvKey);
  const missing = [
    user === undefined ? ci.userEnvKey : '',
    token === undefined ? ci.tokenEnvKey : '',
  ]
    .filter((k) => k !== '')
    .join(' and ');
  if (user === undefined || token === undefined) {
    return {
      ok: false,
      reason: `no ${missing} in the environment or ${tildify(hangar.paths.envShared)}`,
    };
  }
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
        Accept: as === 'json' ? 'application/json' : 'text/plain',
      },
      signal: AbortSignal.timeout(as === 'json' ? CONNECT_TIMEOUT_MS : TEXT_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reason: describeFailure(ci, { kind: 'http', status: res.status, url }) };
    }
    return { ok: true, value: as === 'json' ? await res.json() : await res.text() };
  } catch (error) {
    return {
      ok: false,
      reason: describeFailure(ci, { kind: 'unreachable', detail: networkDetail(error) }),
    };
  }
};
