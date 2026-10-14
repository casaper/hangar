import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `.local/bin/claude`: a bare `claude` is operator mode at the hangar root, developer mode in
 * `app/`, and the real binary everywhere else.
 *
 * A shell file no builder renders and no capture holds, and it is the one place a mode's four
 * flags are written -- `hangar up`'s tabs run it too. So the ordering that makes a resume land IN
 * its mode is tested here, by running the file: a copy of it in a temp hangar, with a fake
 * `claude` behind it that prints the argv it was handed and the `HANGAR_MODE` it saw.
 */

const shimSource = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.local',
  'bin',
  'claude',
);

const FAKE = '#!/bin/sh\nprintf "HANGAR_MODE=%s\\n" "${HANGAR_MODE-unset}"\nprintf "%s\\n" "$@"\n';

const layout = (): { root: string; shimDir: string; fakeDir: string } => {
  // `realpathSync` because the shim compares `pwd -P`, and a temp dir is behind a symlink on macOS.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hangar-shim-')));
  const shimDir = join(root, '.local', 'bin');
  mkdirSync(shimDir, { recursive: true });
  copyFileSync(shimSource, join(shimDir, 'claude'));
  chmodSync(join(shimDir, 'claude'), 0o755);
  for (const dir of ['app/src', 'clone_01']) mkdirSync(join(root, dir), { recursive: true });
  const fakeDir = join(root, 'fake-bin');
  mkdirSync(fakeDir);
  writeFileSync(join(fakeDir, 'claude'), FAKE);
  chmodSync(join(fakeDir, 'claude'), 0o755);
  return { root, shimDir, fakeDir };
};

const { root, shimDir, fakeDir } = layout();

/** Run the shim from `dir` with the shim's own directory FIRST on PATH, as direnv puts it. */
const runShim = (
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { mode: string; argv: string[] } => {
  const res = spawnSync(join(shimDir, 'claude'), args, {
    cwd: join(root, dir),
    env: { PATH: `${shimDir}:${fakeDir}:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const [first, ...argv] = res.stdout.replace(/\n$/, '').split('\n');
  return { mode: (first ?? '').replace(/^HANGAR_MODE=/, ''), argv };
};

const modeFlags = (mode: string): string[] => [
  '--settings',
  join(root, '.claude', 'modes', `${mode}.settings.json`),
  '--append-system-prompt-file',
  join(root, '.claude', 'modes', `${mode}.md`),
  '--mcp-config',
  join(root, '.claude', 'modes', 'mcp.json'),
];

test('the hangar root is operator mode, with the mode ahead of what the caller passed', () => {
  // Ahead, because that ordering is what makes `claude --resume <id>` resume INTO the mode.
  const { mode, argv } = runShim('.', ['--resume', 'abc']);
  assert.equal(mode, 'ops');
  assert.deepEqual(argv, [...modeFlags('ops'), '-n', 'hangar ops', '--resume', 'abc']);
});

test('app/ is developer mode', () => {
  const { mode, argv } = runShim('app', []);
  assert.equal(mode, 'dev');
  assert.deepEqual(argv, [...modeFlags('dev'), '-n', 'hangar dev']);
});

test('a caller who names the session keeps their name', () => {
  for (const name of [['-n', 'mine'], ['--name', 'mine'], ['--name=mine']]) {
    const { argv } = runShim('.', name);
    assert.deepEqual(argv, [...modeFlags('ops'), ...name], name.join(' '));
  }
});

test('anywhere else is the real binary, untouched -- a clone and app/src included', () => {
  // Every clone is inside the hangar, so only EXACT equality keeps a clone's own session itself.
  for (const dir of ['clone_01', 'app/src']) {
    const { mode, argv } = runShim(dir, ['-p', 'hi'], { HANGAR_MODE: 'ops' });
    assert.deepEqual(argv, ['-p', 'hi'], dir);
    // Unset, not passed on: a bare claude started from a mode session must not wear its badge.
    assert.equal(mode, 'unset', dir);
  }
});

test('inside a Claude Code session there is no mode to be had', () => {
  // The escalation guard: an operator session's `cd app && claude -p` must not get dev's rules.
  for (const dir of ['.', 'app']) {
    const { mode, argv } = runShim(dir, ['-p', 'x'], { CLAUDECODE: '1', HANGAR_MODE: 'ops' });
    assert.deepEqual(argv, ['-p', 'x'], dir);
    assert.equal(mode, 'unset', dir);
  }
});

test('a subcommand reaches claude bare, decided on the first word alone', () => {
  for (const args of [['mcp', 'list'], ['update'], ['--version'], ['-h']]) {
    assert.deepEqual(runShim('.', args).argv, args, args.join(' '));
  }
  // The accepted cost, pinned so nobody "fixes" it into a parser of claude's command line: a
  // prompt whose first word is a subcommand's name IS that subcommand.
  assert.deepEqual(runShim('.', ['update', 'the', 'README']).argv, ['update', 'the', 'README']);
  // And a prompt that is not one gets the mode.
  assert.equal(runShim('.', ['tidy', 'the', 'README']).mode, 'ops');
});

test('with no real claude behind it, it says so rather than finding itself', () => {
  const res = spawnSync(join(shimDir, 'claude'), [], {
    cwd: root,
    env: { PATH: `${shimDir}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  assert.equal(res.status, 127);
  assert.match(res.stderr, /not found on PATH/);
});
