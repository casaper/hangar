import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePorcelainPaths } from '../src/git.ts';

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
