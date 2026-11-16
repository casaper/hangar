import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrState, PullRequest } from '../src/bitbucket.ts';
import { describePrTarget } from '../src/commands/pr-target.ts';
import { followTarget, MAX_TARGET_HOPS, type TargetAsk } from '../src/pr-target.ts';

/**
 * Where a stored PR target leads once the branches it names have merged. The forge and origin are
 * a table here: each branch's pull request (state and destination) and whether origin has it.
 */
const pr = (state: PrState, destination: string): PullRequest => ({
  id: 1,
  title: 't',
  destination,
  url: 'u',
  state,
  draft: false,
  headCommit: '',
  review: 'none',
  reviewers: 0,
  approvals: 0,
  author: '',
  authorName: '',
});

const forge = (
  prs: Record<string, PullRequest | 'unknown'>,
  gone: readonly string[],
): TargetAsk & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    pr: (branch) => {
      asked.push(branch);
      return Promise.resolve(prs[branch]);
    },
    onOrigin: (branch) => Promise.resolve(!gone.includes(branch)),
  };
};

test('a merged, deleted target moves on to where its pull request went', async () => {
  const ask = forge({ 'feat/a': pr('merged', 'master') }, ['feat/a']);
  assert.equal(await followTarget('feat/a', 'master', ask), 'master');
});

test('a stacked chain is followed hop by hop, and stops at the default branch', async () => {
  const ask = forge({ 'feat/a': pr('merged', 'feat/b'), 'feat/b': pr('merged', 'master') }, [
    'feat/a',
    'feat/b',
  ]);
  assert.equal(await followTarget('feat/a', 'master', ask), 'master');
  assert.ok(!ask.asked.includes('master'), 'the default branch is never looked up');
});

test('a target whose branch still exists on origin stays, merged or not', async () => {
  // A long-lived branch that once had a merged pull request: Bitbucket retargets nothing here.
  const ask = forge({ release9: pr('merged', 'master') }, []);
  assert.equal(await followTarget('release9', 'master', ask), 'release9');
});

test('an open, declined, absent or unknown pull request stops the walk where it stands', async () => {
  for (const found of [pr('open', 'master'), pr('declined', 'master'), 'unknown' as const]) {
    assert.equal(
      await followTarget('feat/a', 'master', forge({ 'feat/a': found }, ['feat/a'])),
      'feat/a',
    );
  }
  assert.equal(await followTarget('feat/a', 'master', forge({}, ['feat/a'])), 'feat/a');
});

test('the default branch is never hopped off', async () => {
  const ask = forge({ master: pr('merged', 'release9') }, ['master']);
  assert.equal(await followTarget('master', 'master', ask), 'master');
  assert.deepEqual(ask.asked, []);
});

test('the walk is capped, and a cycle ends it', async () => {
  const prs: Record<string, PullRequest> = {};
  const gone: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    prs[`b${String(i)}`] = pr('merged', `b${String(i + 1)}`);
    gone.push(`b${String(i)}`);
  }
  assert.equal(await followTarget('b0', 'master', forge(prs, gone)), `b${String(MAX_TARGET_HOPS)}`);
  const loop = forge({ x: pr('merged', 'y'), y: pr('merged', 'x') }, ['x', 'y']);
  assert.equal(await followTarget('x', 'master', loop), 'y');
});

test('pr target names the branch, the target, and says when nothing is stored', () => {
  assert.match(describePrTarget('clone_02', 'feat/b', 'feat/a', 'master'), /feat\/b → feat\/a$/);
  assert.match(describePrTarget('clone_02', 'feat/b', 'master', 'master'), /the default branch/);
  assert.match(
    describePrTarget('clone_02', 'feat/b', undefined, 'master'),
    /no stored PR target.*master/,
  );
});
