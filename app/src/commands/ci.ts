import pc from 'picocolors';

import {
  buildStatuses,
  openPullRequests,
  repoRef,
  type BuildStatus,
  type ForgeResult,
} from '../bitbucket.ts';
import type { CiConfig } from '../config/schema.ts';
import { CliError } from '../exec.ts';
import { cloneForCwd, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { currentBranch, DETACHED, gitTry } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import {
  badStages,
  buildLabel,
  buildRoot,
  isUnderBase,
  jenkinsGet,
  parseFailedTests,
  parseJobs,
  parseNodeLog,
  parseRun,
  parseStageNodes,
  requireCi,
  trimLog,
  type FailedTest,
  type JenkinsJob,
  type Stage,
} from '../jenkins.ts';
import { heading, note, raw, step, table, warn } from '../ui.ts';

/**
 * `hangar ci` -- what CI says about a branch, read from Jenkins without a browser.
 *
 * **Read only, and safe for a clone session to run unprompted.** Every request is a GET, so it
 * sits beside `list` and `status` in what a clone may run: the clone's generated settings allow
 * `hangar ci` whole, and the MCP tools are reports.
 *
 * **The way in is the forge's build statuses, never a guessed job path.** Every Jenkins job posts
 * one per commit with a link to its build, so branch → pull request → statuses names the exact
 * builds of the exact commit under review. A multibranch path built from a branch name would
 * name the latest build of a branch, which after a push is a build of some other commit.
 */

/** A build that a status links to, and whether that link may be fetched. */
export type CiBuild = {
  readonly status: BuildStatus;
  /** The build root, when the link names one under `ci.baseUrl`. */
  readonly root: string | undefined;
};

/** Pairs each status with the build it names. PURE. */
export const ciBuilds = (statuses: readonly BuildStatus[], baseUrl: string): CiBuild[] =>
  statuses.map((status) => {
    const root = buildRoot(status.url);
    return { status, root: root !== undefined && isUnderBase(root, baseUrl) ? root : undefined };
  });

/**
 * A Jenkins build's `result` and `building`, in the forge's status vocabulary, so a build named by
 * URL renders and is picked exactly as one found through a status. PURE.
 */
export const jenkinsStateAsForge = (body: unknown): string => {
  const run = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (run['building'] === true) return 'INPROGRESS';
  switch (run['result']) {
    case 'SUCCESS':
      return 'SUCCESSFUL';
    case 'FAILURE':
    case 'UNSTABLE':
      return 'FAILED';
    case 'ABORTED':
      return 'STOPPED';
    default:
      return '';
  }
};

const isFailed = (state: string): boolean => state === 'FAILED' || state === 'STOPPED';

/**
 * Which build `log` and `tests` read. PURE.
 *
 * `--job` matches a status's name or key, or the job path, case-insensitively and as a
 * substring, among ALL of them -- so a green job's log can be read too. Without it, only the
 * failed ones are candidates, and more than one is a question for the caller rather than a pick:
 * reading the wrong job's log looks exactly like reading the right one.
 */
export const selectBuild = (
  builds: readonly CiBuild[],
  job: string | undefined,
  named: boolean,
):
  | { readonly kind: 'one'; readonly build: CiBuild }
  | { readonly kind: 'none'; readonly why: string }
  | { readonly kind: 'many'; readonly builds: readonly CiBuild[] } => {
  const only = builds[0];
  if (named && builds.length === 1 && only !== undefined) return { kind: 'one', build: only };
  const needle = job?.toLowerCase();
  const candidates =
    needle === undefined
      ? builds.filter((b) => isFailed(b.status.state))
      : builds.filter((b) =>
          [b.status.name, b.status.key, b.root === undefined ? '' : buildLabel(b.root)].some((s) =>
            s.toLowerCase().includes(needle),
          ),
        );
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return { kind: 'one', build: candidates[0] };
  }
  if (candidates.length > 1) return { kind: 'many', builds: candidates };
  return {
    kind: 'none',
    why:
      needle === undefined
        ? builds.length === 0
          ? 'no build status on it at all'
          : 'no failed build — pass --job to read a passing or running one'
        : `no build matches --job ${job ?? ''}`,
  };
};

const STATE_MARK: Readonly<Record<string, string>> = {
  SUCCESSFUL: 'pass',
  FAILED: 'FAIL',
  STOPPED: 'stopped',
  INPROGRESS: 'running',
};

/**
 * `ci status`'s rows: state, job, failing stages, build. PURE. Failures first, because that is
 * the row the reader came for; then the forge's own order.
 */
export const ciStatusRows = (
  builds: readonly CiBuild[],
  stages: ReadonlyMap<string, readonly Stage[]>,
): string[][] =>
  [...builds]
    .sort((a, b) => Number(isFailed(b.status.state)) - Number(isFailed(a.status.state)))
    .map((b) => {
      const bad = b.root === undefined ? undefined : stages.get(b.root);
      return [
        STATE_MARK[b.status.state] ?? b.status.state.toLowerCase(),
        b.status.name || b.status.key,
        bad === undefined || bad.length === 0 ? '' : `stage: ${bad.map((s) => s.name).join(', ')}`,
        b.root ?? `${b.status.url} (not under ci.baseUrl)`,
      ];
    });

/** One failed test, as the lines `ci tests` prints. PURE. */
export const failedTestLines = (t: FailedTest, stackLines: number): string[] => {
  const head = `${t.className === '' || t.name.startsWith(t.className) ? '' : `${t.className} › `}${t.name}`;
  const error = t.error.trim().split('\n').slice(0, 6);
  const stack = t.stack.trim() === '' ? [] : t.stack.trim().split('\n').slice(0, stackLines);
  return [head, ...error.map((l) => `    ${l}`), ...stack.map((l) => `      ${l}`)];
};

/** A multibranch branch's job name, `feature%2Fx`, as the branch it is. */
const decoded = (name: string): string => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

/** `ci jobs`' lines, children indented under their multibranch job. PURE. */
export const jobLines = (jobs: readonly JenkinsJob[], filter: string | undefined): string[] => {
  const needle = filter?.toLowerCase();
  const hit = (j: JenkinsJob): boolean =>
    needle === undefined || j.name.toLowerCase().includes(needle);
  return jobs.flatMap((job) => {
    const children = job.children.filter(hit);
    if (!hit(job) && children.length === 0) return [];
    const shown = hit(job) ? job.children : children;
    const colour = (j: JenkinsJob): string => (j.color === '' ? '' : `  [${j.color}]`);
    return [
      `${job.name}${colour(job)}  ${job.url}`,
      ...shown.map((c) => `    ${decoded(c.name)}${colour(c)}  ${c.url}`),
    ];
  });
};

// ---- I/O -------------------------------------------------------------------------------------

const unwrap = <T>(result: ForgeResult<T>): T => {
  if (!result.ok) throw new CliError(result.reason);
  return result.value;
};

export type CiTargetOptions = {
  branch?: string | undefined;
};

type Subject = {
  readonly what: string;
  readonly builds: readonly CiBuild[];
  /** The build was NAMED, by URL: `log` and `tests` read it whatever its state. */
  readonly named: boolean;
};

/** The clone named, or the one the command runs in. Read only, so any clone may be named. */
const targetClone = (hangar: Hangar, ref: string | undefined): Clone => {
  if (ref !== undefined) return requireClone(hangar, ref);
  const here = cloneForCwd(hangar);
  if (here === undefined) {
    throw new CliError(
      'hangar ci needs a clone or a build URL when it is not run from inside a clone',
      knownClonesHint(hangar),
    );
  }
  return here;
};

/**
 * The builds of a clone's branch: its open pull request's statuses, or -- with no pull request
 * -- those on the commit origin has for the branch, else the local HEAD.
 */
const subjectOf = async (
  hangar: Hangar,
  ci: CiConfig,
  target: string | undefined,
  opts: CiTargetOptions,
): Promise<Subject> => {
  if (target !== undefined && /^https?:\/\//.test(target)) {
    const root = buildRoot(target);
    if (root === undefined) throw new CliError(`${target} names no Jenkins build`);
    if (!isUnderBase(root, ci.baseUrl)) {
      throw new CliError(`${target} is not under ci.baseUrl (${ci.baseUrl}) — not fetched`);
    }
    const run = await jenkinsGet(hangar, ci, `${root}api/json?tree=result,building`, 'json');
    const state = run.ok ? jenkinsStateAsForge(run.value) : '';
    return {
      what: buildLabel(root),
      builds: [{ status: { key: '', name: buildLabel(root), state, url: root }, root }],
      named: true,
    };
  }
  const clone = targetClone(hangar, target);
  const current = currentBranch(clone.path);
  const branch = opts.branch ?? (current === DETACHED ? undefined : current);
  const ref = repoRef(hangar, clone.path);
  if (branch !== undefined) {
    const prs = await openPullRequests(hangar, ref, branch);
    const pr = prs.ok ? prs.pullRequests[0] : undefined;
    if (pr !== undefined) {
      const statuses = unwrap(await buildStatuses(hangar, ref, { prId: pr.id }));
      return {
        what: `${clone.name}: ${branch}, pull request #${String(pr.id)}`,
        builds: ciBuilds(statuses, ci.baseUrl),
        named: false,
      };
    }
  }
  const commit =
    (branch === undefined ? undefined : gitTry(clone.path, ['rev-parse', `origin/${branch}`])) ??
    (opts.branch === undefined ? gitTry(clone.path, ['rev-parse', 'HEAD']) : undefined);
  if (commit === undefined) {
    throw new CliError(
      `${clone.name}: ${branch ?? 'HEAD'} has no pull request and origin has no such branch`,
    );
  }
  const statuses = unwrap(await buildStatuses(hangar, ref, { commit }));
  return {
    what: `${clone.name}: ${branch ?? 'detached HEAD'} at ${commit.slice(0, 10)} (no open pull request)`,
    builds: ciBuilds(statuses, ci.baseUrl),
    named: false,
  };
};

const failingStagesOf = async (
  hangar: Hangar,
  ci: CiConfig,
  root: string,
): Promise<readonly Stage[] | undefined> => {
  const run = await jenkinsGet(hangar, ci, `${root}wfapi/describe`, 'json');
  return run.ok ? badStages(parseRun(run.value).stages) : undefined;
};

export type CiStatusOptions = CiTargetOptions & { json?: boolean | undefined };

/** `hangar ci status [clone|url]`. */
export const ciStatus = async (
  hangar: Hangar,
  target: string | undefined,
  opts: CiStatusOptions,
): Promise<void> => {
  const ci = unwrap(requireCi(hangar));
  const subject = await subjectOf(hangar, ci, target, opts);
  const stages = new Map<string, readonly Stage[]>();
  await Promise.all(
    subject.builds
      .filter((b) => b.root !== undefined && isFailed(b.status.state))
      .map(async (b) => {
        const root = b.root ?? '';
        const bad = await failingStagesOf(hangar, ci, root);
        if (bad !== undefined) stages.set(root, bad);
      }),
  );
  if (opts.json === true) {
    raw(
      JSON.stringify(
        {
          subject: subject.what,
          builds: subject.builds.map((b) => ({
            ...b.status,
            build: b.root ?? null,
            failingStages:
              (b.root === undefined ? undefined : stages.get(b.root))?.map((s) => s.name) ?? [],
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  heading(subject.what);
  if (subject.builds.length === 0) {
    note('no build status — CI has not reported on this commit yet');
    return;
  }
  table(ciStatusRows(subject.builds, stages));
  if (subject.builds.some((b) => isFailed(b.status.state))) {
    note('hangar ci log / hangar ci tests read the failed build; --job picks one of several');
  }
};

export type CiReadOptions = CiTargetOptions & {
  job?: string | undefined;
};

/** The one build `log` and `tests` read; `undefined` after printing why there is none. */
const pickBuild = async (
  hangar: Hangar,
  ci: CiConfig,
  target: string | undefined,
  opts: CiReadOptions,
): Promise<{ build: CiBuild; root: string } | { exitCode: number }> => {
  const subject = await subjectOf(hangar, ci, target, opts);
  const pick = selectBuild(subject.builds, opts.job, subject.named);
  if (pick.kind === 'none') {
    note(`${subject.what}: ${pick.why}`);
    return { exitCode: 0 };
  }
  if (pick.kind === 'many') {
    warn(`${subject.what}: ${String(pick.builds.length)} builds match — name one with --job`);
    table(ciStatusRows(pick.builds, new Map()));
    return { exitCode: 2 };
  }
  if (pick.build.root === undefined) {
    throw new CliError(
      `${pick.build.status.url} is not under ci.baseUrl (${ci.baseUrl}) — not fetched, so no credential is sent to it`,
    );
  }
  return { build: pick.build, root: pick.build.root };
};

export type CiLogOptions = CiReadOptions & {
  full?: boolean | undefined;
  tail?: string | undefined;
  grep?: string | undefined;
};

const DEFAULT_TAIL = 200;

const parseTail = (raw: string | undefined, full: boolean): number | undefined => {
  if (raw === undefined) return full ? undefined : DEFAULT_TAIL;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0)
    throw new CliError(`--tail takes a number of lines, not ${raw}`);
  return n === 0 ? undefined : n;
};

const printTrimmed = (text: string, tail: number | undefined, grep: RegExp | undefined): void => {
  const { lines, omitted } = trimLog(text, { tail, grep, context: 3 });
  if (omitted > 0) note(`(${String(omitted)} lines not shown — --tail 0 or --grep to see others)`);
  raw(lines.join('\n'));
};

/**
 * The failed steps' own logs, stage by stage, or `false` when Stage View cannot say which those
 * are (no `wfapi`, or no stage marked bad) and the caller falls back to the whole console.
 */
const printStageLogs = async (
  hangar: Hangar,
  ci: CiConfig,
  root: string,
  tail: number | undefined,
  grep: RegExp | undefined,
): Promise<boolean> => {
  const bad = await failingStagesOf(hangar, ci, root);
  if (bad === undefined || bad.length === 0) return false;
  let printed = false;
  for (const stage of bad) {
    const described = await jenkinsGet(
      hangar,
      ci,
      `${root}execution/node/${stage.id}/wfapi/describe`,
      'json',
    );
    if (!described.ok) continue;
    const nodes = parseStageNodes(described.value);
    const failed = nodes.filter((n) => n.status === 'FAILED');
    const chosen = failed.length > 0 ? failed : nodes.slice(-1);
    for (const node of chosen) {
      const log = await jenkinsGet(
        hangar,
        ci,
        `${root}execution/node/${node.id}/wfapi/log`,
        'json',
      );
      if (!log.ok) continue;
      const { text, truncated } = parseNodeLog(log.value);
      step(
        `stage ${stage.name} (${stage.status}) — ${node.name}${node.detail === '' ? '' : `: ${node.detail.split('\n')[0] ?? ''}`}`,
      );
      if (truncated) note('Jenkins cut this step log short — --full reads the whole console');
      printTrimmed(text, tail, grep);
      printed = true;
    }
  }
  return printed;
};

/** `hangar ci log [clone|url]`. Returns the exit code. */
export const ciLog = async (
  hangar: Hangar,
  target: string | undefined,
  opts: CiLogOptions,
): Promise<number> => {
  const ci = unwrap(requireCi(hangar));
  const full = opts.full === true;
  const tail = parseTail(opts.tail, full);
  let grep: RegExp | undefined;
  try {
    grep = opts.grep === undefined ? undefined : new RegExp(opts.grep, 'i');
  } catch (error) {
    throw new CliError(`--grep: ${error instanceof Error ? error.message : String(error)}`);
  }
  const picked = await pickBuild(hangar, ci, target, opts);
  if ('exitCode' in picked) return picked.exitCode;
  heading(`${buildLabel(picked.root)}  ${pc.dim(picked.root)}`);
  if (!full && (await printStageLogs(hangar, ci, picked.root, tail, grep))) return 0;
  if (!full) note('no failed stage to narrow to — reading the console log');
  const text = unwrap(await jenkinsGet(hangar, ci, `${picked.root}consoleText`, 'text'));
  printTrimmed(typeof text === 'string' ? text : '', tail, grep);
  return 0;
};

export type CiTestsOptions = CiReadOptions & {
  limit?: string | undefined;
  stack?: string | undefined;
};

const count = (raw: string | undefined, fallback: number, flag: string): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`${flag} takes a number, not ${raw}`);
  return n;
};

/** `hangar ci tests [clone|url]`. Returns the exit code. */
export const ciTests = async (
  hangar: Hangar,
  target: string | undefined,
  opts: CiTestsOptions,
): Promise<number> => {
  const ci = unwrap(requireCi(hangar));
  const limit = count(opts.limit, 30, '--limit');
  const stackLines = count(opts.stack, 8, '--stack');
  const picked = await pickBuild(hangar, ci, target, opts);
  if ('exitCode' in picked) return picked.exitCode;
  const report = await jenkinsGet(
    hangar,
    ci,
    `${picked.root}testReport/api/json?tree=suites[name,cases[className,name,status,errorDetails,errorStackTrace]]`,
    'json',
  );
  heading(`${buildLabel(picked.root)}  ${pc.dim(picked.root)}`);
  if (!report.ok) {
    note(`${report.reason} — this build published no test report; hangar ci log reads its console`);
    return 0;
  }
  const failed = parseFailedTests(report.value);
  if (failed.length === 0) {
    note('the test report has no failed case');
    return 0;
  }
  note(
    `${String(failed.length)} failed test(s)${failed.length > limit ? `, the first ${String(limit)} shown` : ''}`,
  );
  for (const t of failed.slice(0, limit)) raw(failedTestLines(t, stackLines).join('\n'));
  return 0;
};

/** `hangar ci jobs [filter]`. */
export const ciJobs = async (hangar: Hangar, filter: string | undefined): Promise<void> => {
  const ci = unwrap(requireCi(hangar));
  const base = ci.baseUrl.endsWith('/') ? ci.baseUrl : `${ci.baseUrl}/`;
  const body = unwrap(
    await jenkinsGet(
      hangar,
      ci,
      `${base}api/json?tree=jobs[name,url,color,jobs[name,url,color]]`,
      'json',
    ),
  );
  const lines = jobLines(parseJobs(body), filter);
  if (lines.length === 0) {
    note(filter === undefined ? 'Jenkins lists no job' : `no job or branch matches ${filter}`);
    return;
  }
  raw(lines.join('\n'));
};
