import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseBuildStatuses, type BuildStatus } from '../src/bitbucket.ts';
import { ciSection, claudeLocalMdContent, hangarReportAllows } from '../src/clone-config.ts';
import {
  ciBuilds,
  ciStatusRows,
  failedTestLines,
  jenkinsStateAsForge,
  jobLines,
  selectBuild,
} from '../src/commands/ci.ts';
import { cloneAt } from '../src/fleet.ts';
import {
  badStages,
  buildLabel,
  buildRoot,
  consoleHtmlToText,
  describeFailure,
  isUnderBase,
  parseFailedTests,
  parseJobs,
  parseNodeLog,
  parseRun,
  parseStageNodes,
  trimLog,
} from '../src/jenkins.ts';
import { fixtureConfigText, syntheticHangar } from './fixture.ts';

/**
 * `hangar ci`'s pure half. The I/O is a GET per call and there is no Jenkins in this suite, so
 * everything a request's answer is turned into is asserted here against the shapes Jenkins and
 * Bitbucket document, and the requests themselves are the user's to smoke-test.
 */

const BASE = 'https://ci.example.invalid/jenkins';
const CI = { kind: 'jenkins', baseUrl: BASE, userEnvKey: 'U', tokenEnvKey: 'T' } as const;

test('credentials go only under ci.baseUrl: same origin, under its path, nothing lookalike', () => {
  assert.ok(isUnderBase(`${BASE}/job/app/job/main/3/`, BASE));
  assert.ok(isUnderBase(`${BASE}/`, `${BASE}/`));
  assert.ok(!isUnderBase('https://ci.example.invalid/other/job/x/1/', BASE));
  assert.ok(!isUnderBase('https://ci.example.invalid/jenkinsevil/job/x/1/', BASE));
  assert.ok(!isUnderBase('https://ci.example.invalid.evil.test/jenkins/job/x/1/', BASE));
  assert.ok(!isUnderBase('http://ci.example.invalid/jenkins/job/x/1/', BASE));
  assert.ok(!isUnderBase('not a url', BASE));
});

test('every page of a build reduces to its root, and a multibranch branch stays encoded twice', () => {
  const root = `${BASE}/job/app/job/feature%252FABC-1323/12/`;
  for (const page of [
    `${BASE}/job/app/job/feature%252FABC-1323/12/display/redirect`,
    `${BASE}/job/app/job/feature%252FABC-1323/12/console`,
    `${BASE}/job/app/job/feature%252FABC-1323/12/`,
    `${BASE}/job/app/job/feature%252FABC-1323/12`,
    `${BASE}/job/app/job/feature%252FABC-1323/12/execution/node/7/wfapi/log?x=1#y`,
    `${BASE}/blue/organizations/jenkins/app/detail/feature%2FABC-1323/12/pipeline`,
  ]) {
    assert.equal(buildRoot(page), root, page);
  }
  // A folder in Blue Ocean's single job segment becomes two classic `job/` segments.
  assert.equal(
    buildRoot(`${BASE}/blue/organizations/jenkins/team%2Fapp/detail/main/4/`),
    `${BASE}/job/team/job/app/job/main/4/`,
  );
  assert.equal(buildRoot(`${BASE}/job/app/`), undefined);
  assert.equal(
    buildRoot(`${BASE}/job/app/job/main/lastBuild/`),
    `${BASE}/job/app/job/main/lastBuild/`,
  );
  assert.equal(buildLabel(root), 'app » feature/ABC-1323 #12');
});

test('the failed stage is the one that FAILED, not the ones its failure aborted', () => {
  const run = parseRun({
    status: 'FAILED',
    stages: [
      { id: '6', name: 'Build', status: 'SUCCESS' },
      { id: 17, name: 'Test', status: 'FAILED' },
      { id: '30', name: 'Deploy', status: 'ABORTED' },
      { name: 'no id' },
    ],
  });
  assert.equal(run.stages.length, 3);
  assert.deepEqual(
    badStages(run.stages).map((s) => s.id),
    ['17'],
  );
  // With nothing FAILED, UNSTABLE and ABORTED are what there is to read.
  assert.deepEqual(
    badStages([
      { id: '1', name: 'a', status: 'SUCCESS' },
      { id: '2', name: 'e2e', status: 'UNSTABLE' },
    ]).map((s) => s.name),
    ['e2e'],
  );
  assert.deepEqual(badStages([{ id: '1', name: 'a', status: 'SUCCESS' }]), []);
  assert.deepEqual(parseRun(null), { status: '', stages: [] });
});

test('a stage log is console HTML, read back to text', () => {
  const nodes = parseStageNodes({
    stageFlowNodes: [
      { id: '21', name: 'Shell Script', status: 'FAILED', parameterDescription: 'pnpm test' },
    ],
  });
  assert.deepEqual(nodes, [
    { id: '21', name: 'Shell Script', status: 'FAILED', detail: 'pnpm test' },
  ]);
  assert.equal(
    consoleHtmlToText(
      '<span class="timestamp"><b>10:01</b> </span>a &lt;b&gt; &amp;&amp; &quot;c&quot; &#39;d&#x27;',
    ),
    `10:01 a <b> && "c" 'd'`,
  );
  // `&amp;lt;` is a literal `&lt;` in the log, and must not decode twice.
  assert.equal(consoleHtmlToText('&amp;lt;'), '&lt;');
  assert.deepEqual(parseNodeLog({ text: 'x', hasMore: true }), { text: 'x', truncated: true });
});

test('trimLog keeps the tail, and grep keeps matches with context before the tail applies', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`).join('\n') + '\n';
  assert.deepEqual(trimLog(text, { tail: 3, grep: undefined, context: 0 }), {
    lines: ['line 7', 'line 8', 'line 9'],
    omitted: 7,
  });
  assert.deepEqual(trimLog(text, { tail: undefined, grep: /line 4/, context: 1 }).lines, [
    'line 3',
    'line 4',
    'line 5',
  ]);
  assert.equal(trimLog('a\r\nb', { tail: undefined, grep: undefined, context: 0 }).lines.length, 2);
});

test('only failing cases come out of a test report', () => {
  const failed = parseFailedTests({
    suites: [
      {
        name: 'grid',
        cases: [
          { className: 'grid.spec', name: 'sorts', status: 'PASSED' },
          {
            className: 'grid.spec',
            name: 'filters',
            status: 'REGRESSION',
            errorDetails: 'expected 2',
            errorStackTrace: 'at a\nat b',
          },
          { className: 'grid.spec', name: 'pages', status: 'FAILED', errorDetails: null },
          { className: 'grid.spec', name: 'skipped', status: 'SKIPPED' },
        ],
      },
    ],
  });
  assert.deepEqual(
    failed.map((t) => t.name),
    ['filters', 'pages'],
  );
  const lines = failedTestLines(failed[0] ?? assert.fail('no case'), 1);
  assert.deepEqual(lines, ['grid.spec › filters', '    expected 2', '      at a']);
});

test('jobs list multibranch children, and a filter keeps the parent of a matching branch', () => {
  const jobs = parseJobs({
    jobs: [
      {
        name: 'app',
        url: `${BASE}/job/app/`,
        jobs: [
          { name: 'feature%2Fx', url: 'u1', color: 'red' },
          { name: 'main', url: 'u2', color: 'blue' },
        ],
      },
      { name: 'docs', url: `${BASE}/job/docs/`, color: 'blue' },
    ],
  });
  assert.equal(jobs.length, 2);
  const lines = jobLines(jobs, 'feature');
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? '', /feature\/x {2}\[red\]/);
  assert.deepEqual(jobLines(jobs, 'nothing'), []);
});

const status = (over: Partial<BuildStatus>): BuildStatus => ({
  key: 'k',
  name: 'n',
  state: 'SUCCESSFUL',
  url: `${BASE}/job/app/job/main/1/display/redirect`,
  ...over,
});

test('a build linking elsewhere is shown, never fetched', () => {
  const builds = ciBuilds(
    [status({}), status({ url: 'https://elsewhere.invalid/job/app/job/main/1/' })],
    BASE,
  );
  assert.equal(builds[0]?.root, `${BASE}/job/app/job/main/1/`);
  assert.equal(builds[1]?.root, undefined);
  assert.match(ciStatusRows(builds, new Map())[1]?.[3] ?? '', /not under ci\.baseUrl/);
  assert.equal(
    parseBuildStatuses({ values: [{ key: 'a', state: 'FAILED', url: 'u' }, { key: 'no state' }] })
      .length,
    1,
  );
});

test('log and tests read one failed build, and ask rather than pick among several', () => {
  const unit = status({ name: 'unit', state: 'FAILED' });
  const e2e = status({ name: 'e2e', state: 'STOPPED', url: `${BASE}/job/e2e/job/main/9/` });
  const lint = status({ name: 'lint' });
  const builds = ciBuilds([lint, unit, e2e], BASE);

  assert.equal(selectBuild(builds, undefined, false).kind, 'many');
  const one = selectBuild(builds, 'E2E', false);
  assert.equal(one.kind === 'one' ? one.build.status.name : '', 'e2e');
  // --job reaches a passing build too.
  assert.equal(selectBuild(builds, 'lint', false).kind, 'one');
  assert.equal(selectBuild(ciBuilds([lint], BASE), undefined, false).kind, 'none');
  // A build named by URL is read whatever its state: the user pointed at it.
  assert.equal(selectBuild(ciBuilds([lint], BASE), undefined, true).kind, 'one');
  // Failures sort first in the status table.
  assert.deepEqual(
    ciStatusRows(builds, new Map()).map((r) => r[1]),
    ['unit', 'e2e', 'lint'],
  );
});

test('an unreachable server is a VPN question, and a refusal names the keys, never the values', () => {
  assert.match(describeFailure(CI, { kind: 'unreachable', detail: 'ETIMEDOUT' }), /VPN/);
  const refused = describeFailure(CI, { kind: 'http', status: 401, url: BASE });
  assert.match(refused, /\bU\b.*\bT\b/);
});

test('the identity file has a CI section iff the hangar has a ci block, built from it', () => {
  const withCi = syntheticHangar();
  const text = claudeLocalMdContent(cloneAt(withCi, 1));
  const ci = withCi.config.ci ?? assert.fail('the fixture carries a ci block');
  for (const want of [ci.baseUrl, ci.userEnvKey, ci.tokenEnvKey, 'hangar ci status', 'VPN']) {
    assert.ok(text.includes(want), `missing ${want}`);
  }
  // The credential is referred to, never spelled out as a curl argument.
  assert.doesNotMatch(text, /-u ["']?\$/);
  assert.deepEqual(hangarReportAllows(withCi), ['Bash(hangar ci:*)']);

  const without = syntheticHangar({
    configText: fixtureConfigText().replace(/^ci:\n(?: {2}.*\n)+/m, ''),
  });
  assert.equal(without.config.ci, undefined);
  assert.deepEqual(ciSection(without), []);
  assert.doesNotMatch(claudeLocalMdContent(cloneAt(without, 1)), /hangar ci/);
  assert.deepEqual(hangarReportAllows(without), []);
});

test('a build named by URL takes the forge vocabulary from its own result', () => {
  assert.equal(jenkinsStateAsForge({ result: 'FAILURE', building: false }), 'FAILED');
  assert.equal(jenkinsStateAsForge({ result: 'UNSTABLE' }), 'FAILED');
  assert.equal(jenkinsStateAsForge({ result: 'ABORTED' }), 'STOPPED');
  assert.equal(jenkinsStateAsForge({ result: 'SUCCESS' }), 'SUCCESSFUL');
  assert.equal(jenkinsStateAsForge({ result: null, building: true }), 'INPROGRESS');
  assert.equal(jenkinsStateAsForge(undefined), '');
});
