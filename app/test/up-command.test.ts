import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ClaudeTranscript } from '../src/claude-sessions.ts';
import {
  asTab,
  DEFAULT_TAB,
  describeTabResume,
  modeTabCommand,
  MODES,
  resolveClaudeBinary,
  restartChoice,
  restartTargets,
  shimPath,
  TAB_WINDOWS,
} from '../src/commands/up.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * `hangar up`'s pure half.
 *
 * **A golden capture cannot reach any of this**: the command's output is a live tmux server and
 * an attached terminal. What it gets right or wrong is which command a tab runs and which session
 * it resumes, and the failures are all "runs, and does the wrong thing quietly":
 *
 * - a tab running a bare `claude`, which a tmux server's inherited PATH can resolve to the real
 *   binary -- a session in no mode at all, under the tab's badge;
 * - a restarted tab resuming nothing, because the session it held was still live when asked;
 * - `resolveClaudeBinary` finding the shim and reporting Claude Code installed when it is not.
 *
 * The mode's own flags, and their order ahead of `--resume`, are the shim's and are held by
 * `claude-shim.test.ts`. Properties rather than snapshots, per this package's convention.
 */

const hangar = syntheticHangar();

const transcript = (over: Partial<ClaudeTranscript>): ClaudeTranscript => ({
  id: 'id',
  file: '/x.jsonl',
  cwd: hangar.root,
  branch: undefined,
  title: undefined,
  firstPrompt: undefined,
  lastPrompt: undefined,
  startedAt: undefined,
  modifiedAtMs: 0,
  lastActiveAtMs: 0,
  bytes: 0,
  live: false,
  ...over,
});

test('no two tabs claim the same window index', () => {
  // tmux refuses `new-window -t` on an occupied index, so a collision here is a command that
  // cannot rebuild its own workspace. The table is derived, which is what makes this a property.
  const indexes = Object.values(TAB_WINDOWS);
  assert.equal(new Set(indexes).size, indexes.length, `two tabs share an index: ${indexes.join()}`);
  assert.ok(indexes.length >= 3, 'the shell tab is missing from the table');
});

test('a fresh window lands on the shell tab, and --select names any of the three', () => {
  assert.equal(DEFAULT_TAB, 'shell');
  for (const tab of Object.keys(TAB_WINDOWS)) assert.equal(asTab(tab), tab);
  assert.throws(() => asTab('operator'), /unknown tab/);
  assert.throws(() => asTab(''), /unknown tab/);
});

test('--restart names modes, never the shell tab', () => {
  assert.deepEqual(restartTargets('all'), MODES);
  for (const mode of MODES) assert.deepEqual(restartTargets(mode), [mode]);
  // The shell tab runs no claude; restarting it would be killing somebody's shell.
  assert.throws(() => restartTargets('shell'), /cannot restart/);
  assert.throws(() => restartTargets('ops,dev'), /cannot restart/);
});

test('a mode tab runs the shim by absolute path, and --resume comes after it', () => {
  const fresh = modeTabCommand(hangar, undefined);
  assert.equal(fresh, shimPath(hangar));
  assert.ok(fresh.startsWith(`${hangar.root}/`), 'a tab must never run a bare claude');
  assert.equal(shimPath(hangar), join(hangar.root, '.local', 'bin', 'claude'));

  const resumed = modeTabCommand(hangar, 'abc-123');
  assert.equal(resumed, `${shimPath(hangar)} --resume abc-123`);
});

test('a restarted tab resumes the newest LIVE session, which a plain resume would refuse', () => {
  const idle = transcript({ id: 'idle', lastActiveAtMs: 300 });
  const held = transcript({ id: 'held', lastActiveAtMs: 200, live: true });
  const older = transcript({ id: 'older', lastActiveAtMs: 100, live: true });

  assert.deepEqual(restartChoice([idle, older, held]), { kind: 'resume', session: held });

  // Nothing live means the tab held no conversation worth naming: a fresh one, not the idle one.
  assert.deepEqual(restartChoice([idle]), { kind: 'none' });
  assert.deepEqual(restartChoice([]), { kind: 'none' });
});

test('every fallback to a fresh session is a warning, and a resume is not', () => {
  const session = transcript({ id: 'abcdef1234', title: 'fix the bar' });
  const resume = describeTabResume('ops', { kind: 'resume', session }, false);
  assert.equal(resume.warn, false);
  assert.ok(resume.text.includes('fix the bar') && resume.text.includes('abcdef12'));

  for (const choice of [
    { kind: 'live', session },
    { kind: 'gone', session },
    { kind: 'none' },
  ] as const) {
    const line = describeTabResume('dev', choice, true);
    assert.equal(line.warn, true, choice.kind);
    assert.ok(line.text.startsWith('dev: '), line.text);
  }
  assert.equal(describeTabResume('ops', { kind: 'window-exists' }, false).warn, false);
});

test('the proxy directory is skipped, so the shim can never resolve to itself', () => {
  const shim = join(hangar.root, '.local', 'bin');
  // Nothing exists under a synthetic root, so the honest answer is "not found" -- and the
  // property under test is that the shim is not it.
  assert.equal(resolveClaudeBinary(shim, hangar.root), undefined);
  assert.notEqual(resolveClaudeBinary(`${shim}:/usr/bin`, hangar.root), join(shim, 'claude'));
  assert.equal(resolveClaudeBinary(undefined, hangar.root), undefined);
  assert.equal(resolveClaudeBinary('', hangar.root), undefined);
});

test('a real binary on PATH is found, and the shim ahead of it does not shadow it', () => {
  // `/usr/bin/env` exists everywhere this suite runs, so it stands in for `claude`: the question
  // is only which DIRECTORY the walk accepts, never what the file is.
  const shim = join(hangar.root, '.local', 'bin');
  assert.equal(resolveClaudeBinary('/usr/bin', hangar.root, 'env'), '/usr/bin/env');
  assert.equal(resolveClaudeBinary(`${shim}:/usr/bin`, hangar.root, 'env'), '/usr/bin/env');
});
