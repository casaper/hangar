import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { run } from '../src/exec.ts';
import { conflictedFiles, parsePorcelainPaths } from '../src/git.ts';
import { hasConflictMarkers } from '../src/resolve-conflicts.ts';

/** What `C-b C-e` offers first, read off `git status --porcelain=v1 -z`. */

test('staged, unstaged and untracked paths each appear once, in git order', () => {
  // The leading space is half the first entry's status, so nothing may trim it away.
  const raw = ' M src/b.ts\0M  src/a.ts\0MM src/c.ts\0?? notes/new file.md\0';
  assert.deepEqual(parsePorcelainPaths(raw), [
    'src/b.ts',
    'src/a.ts',
    'src/c.ts',
    'notes/new file.md',
  ]);
});

test('a rename yields its new path, and its old path is never a row', () => {
  const raw = 'R  src/new.ts\0src/old.ts\0 M src/d.ts\0';
  assert.deepEqual(parsePorcelainPaths(raw), ['src/new.ts', 'src/d.ts']);
});

test('a deleted path has nothing to open', () => {
  const raw = 'D  gone.ts\0 D also-gone.ts\0A  kept.ts\0';
  assert.deepEqual(parsePorcelainPaths(raw), ['kept.ts']);
});

test('a clean tree gives no rows, so the picker falls back to every file', () => {
  assert.deepEqual(parsePorcelainPaths(''), []);
});

test('a conflicted non-ASCII path is named as it is, and its markers are found', () => {
  /*
   * Under git's default `core.quotePath=true`, `diff --name-only` prints `"caf\303\251.ts"`,
   * quotes included. `readFileSync` on that throws, a throw read as "no markers" would let an
   * integration commit them. Real git in a throwaway repo: the quoting is git's, not ours.
   */
  const saved = Object.entries(process.env).filter(([key]) => key.startsWith('GIT_'));
  for (const [key] of saved) Reflect.deleteProperty(process.env, key);
  const repo = mkdtempSync(join(tmpdir(), 'quotepath-'));
  try {
    const sh = (...args: string[]): void => {
      const res = run('git', [
        '-C',
        repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@e.invalid',
        ...args,
      ]);
      assert.ok(res.ok, `git ${args.join(' ')}: ${res.stderr}`);
    };
    sh('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'café.ts'), 'base\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'base');
    sh('checkout', '-q', '-b', 'other');
    writeFileSync(join(repo, 'café.ts'), 'theirs\n');
    sh('commit', '-q', '-am', 'theirs');
    sh('checkout', '-q', 'main');
    writeFileSync(join(repo, 'café.ts'), 'ours\n');
    sh('commit', '-q', '-am', 'ours');
    assert.equal(run('git', ['-C', repo, 'merge', '-q', 'other']).ok, false);

    assert.deepEqual(conflictedFiles(repo), ['café.ts']);
    assert.deepEqual(hasConflictMarkers(repo, conflictedFiles(repo)), ['café.ts']);
    // Absent is clean (a delete resolves a modify/delete conflict); unreadable is not.
    assert.deepEqual(hasConflictMarkers(repo, ['gone.ts']), []);
    mkdirSync(join(repo, 'a-dir.ts'));
    assert.deepEqual(hasConflictMarkers(repo, ['a-dir.ts']), ['a-dir.ts']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    for (const [key, value] of saved) process.env[key] = value;
  }
});
