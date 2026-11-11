import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseConfigText } from '../src/config/load.ts';
import { CliError } from '../src/exec.ts';
import { runnerAction, runnerLine, runnerRole, type RunnerEntry } from '../src/runner.ts';
import { fixtureConfigText } from './fixture.ts';

/**
 * `C-b C-n`'s decision table, read off the pure function: every row is what one press does given
 * the windows that are open, with no tmux server anywhere.
 */

const server: RunnerEntry = { name: 'serve', role: 'api' };
const tests: Extract<RunnerEntry, { command: string }> = {
  name: 'test',
  command: 'make test',
  dir: 'app',
  window: 'new',
  closeOnSuccess: false,
  pick: { glob: '**/*.spec.ts', arg: '--include={file}' },
};
const format: Extract<RunnerEntry, { command: string }> = {
  name: 'format',
  command: 'make fmt',
  dir: '',
  window: 'reuse',
  closeOnSuccess: false,
};
const build: Extract<RunnerEntry, { command: string }> = {
  ...format,
  name: 'build',
  closeOnSuccess: true,
};

const busy = { paneId: '%1', windowId: '@1', idle: false };
const idle = { paneId: '%2', windowId: '@2', idle: true };

test('a server row starts, stops, and never starts a second one', () => {
  assert.deepEqual(runnerAction(server, [], undefined, []), { do: 'start-server', role: 'api' });
  // Compiling and not yet listening is still running: a port-only check would start another.
  assert.deepEqual(runnerAction(server, [busy], undefined, []), {
    do: 'stop-server',
    paneId: '%1',
    windowId: '@1',
  });
  // An idle role window is closed first, because `servers start` refuses while one exists.
  assert.equal(runnerAction(server, [idle], undefined, []).do, 'replace-idle-window');
  // A port held from somewhere the key cannot stop is named, not fought over.
  const elsewhere = runnerAction(server, [], 3001, []);
  assert.ok(elsewhere.do === 'refuse');
  assert.match(elsewhere.why, /3001.*servers kill/);
});

test('a command row is ignored while it runs, and otherwise opens or reuses its window', () => {
  assert.equal(runnerAction(tests, [busy], undefined, []).do, 'refuse');
  assert.equal(runnerAction(format, [busy], undefined, []).do, 'refuse');
  // `new` opens another window beside a finished one; `reuse` types into the finished one.
  assert.equal(runnerAction(tests, [idle], undefined, []).do, 'new-window');
  assert.deepEqual(runnerAction(format, [idle], undefined, []), {
    do: 'type-in',
    paneId: '%2',
    line: 'make fmt',
  });
  assert.equal(runnerAction(format, [], undefined, []).do, 'new-window');
});

test('picked files become one argument each, quoted, and success can close the window', () => {
  assert.equal(
    runnerLine(tests, ['src/a b.spec.ts', 'src/c.spec.ts']),
    "make test '--include=src/a b.spec.ts' --include=src/c.spec.ts",
  );
  assert.equal(runnerLine(tests, []), 'make test', 'no pick means the script runs everything');
  assert.equal(runnerLine(build, []), 'make fmt && exit');
  assert.equal(runnerRole('test'), 'run:test');
});

test('the config refuses a runner row whose server nothing can start, and a repeated name', () => {
  const withRunner = (rows: string): string => `${fixtureConfigText()}\nrunner:\n${rows}`;
  // The loader's message names the file; the reason is in the hint.
  const because =
    (pattern: RegExp) =>
    (error: unknown): boolean =>
      error instanceof CliError && pattern.test(error.hint ?? '');
  // `api` has a `start` in the fixture; `db` does not.
  assert.ok(parseConfigText(withRunner('  - name: serve\n    role: api\n'), 'test').runner.length);
  assert.throws(
    () => parseConfigText(withRunner('  - name: db\n    role: db\n'), 'test'),
    because(/has no `start`/),
  );
  assert.throws(
    () => parseConfigText(withRunner('  - name: x\n    role: nope\n'), 'test'),
    because(/no port role "nope"/),
  );
  assert.throws(
    () =>
      parseConfigText(
        withRunner('  - name: a\n    command: x\n  - name: a\n    command: y\n'),
        'test',
      ),
    because(/duplicate runner name/),
  );
});
