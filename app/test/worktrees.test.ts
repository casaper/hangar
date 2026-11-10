import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extraWorktrees, worktreeRow } from '../src/worktrees.ts';

const MAIN = 'worktree /h/clone_01\nHEAD aaaa\nbranch refs/heads/main\n';

test('the clone itself is never an extra worktree, and none means no row', () => {
  assert.deepEqual(extraWorktrees(MAIN), []);
  assert.equal(worktreeRow('/h/clone_01', []), undefined);
});

test('a review worktree in use is reported, not failed', () => {
  const extras = extraWorktrees(`${MAIN}\nworktree /t/review\nHEAD bbbb\ndetached\n`);
  assert.deepEqual(extras, [{ path: '/t/review', what: 'detached', prunable: undefined }]);
  assert.equal(worktreeRow('/h/clone_01', extras)?.ok, true);
});

test('a stale registration is red and names the prune for that clone', () => {
  const extras = extraWorktrees(
    `${MAIN}\nworktree /t/gone\nHEAD cccc\nbranch refs/heads/feature/ABC-1323_x\n` +
      'prunable gitdir file points to non-existent location\n\n' +
      'worktree /t/live\nHEAD dddd\ndetached\n',
  );
  assert.equal(extras[0]?.what, 'feature/ABC-1323_x');
  assert.ok(extras[0]?.prunable?.includes('non-existent'));
  const row = worktreeRow('/h/clone_01', extras);
  assert.equal(row?.ok, false);
  assert.ok(row.detail.includes('git -C /h/clone_01 worktree prune'));
  assert.ok(row.detail.includes('/t/gone'));
  assert.ok(!row.detail.includes('/t/live'), 'a live one is not called stale');
});
