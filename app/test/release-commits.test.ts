import assert from 'node:assert/strict';
import { test } from 'node:test';

import { breakingCommits, parseCommit } from '../src/release/commits.ts';

/**
 * Reading a commit header, which is the only thing `hangar dev release` decides for itself.
 *
 * It does NOT work out a version -- semantic-release does that from `.releaserc.json`, and a
 * second implementation here would be two tables that have to agree. What is asserted is the
 * policy gate in front of it: a breaking marker while the CLI is 0.x, which semantic-release has
 * no setting for and would answer by cutting 1.0.0. Missing one is the whole failure, so both
 * spellings of the footer and the `!` are pinned.
 */

const commit = (subject: string, body = ''): ReturnType<typeof parseCommit> =>
  parseCommit({ sha: 'abc1234', subject, body });

test('the type, scope and summary come out of the header', () => {
  const c = commit('fix(modes): Resolve the status line on PATH');
  assert.equal(c.type, 'fix');
  assert.equal(c.scope, 'modes');
  assert.equal(c.summary, 'Resolve the status line on PATH');
});

test('an absent scope is undefined, and an empty one is too', () => {
  assert.equal(commit('docs: Something').scope, undefined);
  assert.equal(commit('docs(): Something').scope, undefined);
});

test('a subject that is not a Conventional Commit keeps its whole text as the summary', () => {
  const c = commit('Just some prose');
  assert.equal(c.type, undefined);
  assert.equal(c.summary, 'Just some prose');
  assert.equal(c.breaking, false);
});

test('every spelling of a breaking marker is caught', () => {
  assert.equal(commit('feat(cli)!: Change it').breaking, true);
  assert.equal(commit('feat!: Change it').breaking, true);
  assert.equal(commit('fix(cli): x', 'BREAKING CHANGE: the flag is gone').breaking, true);
  assert.equal(commit('fix(cli): x', 'BREAKING-CHANGE: the flag is gone').breaking, true);
  assert.equal(commit('fix(cli): x', 'a body\n\nBREAKING CHANGE: later on').breaking, true);
});

test('a body that merely mentions a breaking change is not one', () => {
  assert.equal(
    commit('fix(cli): x', 'This is not a BREAKING CHANGE, it is a note').breaking,
    false,
  );
  assert.equal(commit('fix(cli): x', 'no marker here at all').breaking, false);
});

test('breakingCommits selects only the marked ones, and keeps them identifiable', () => {
  const range = [commit('fix: a'), commit('feat!: b'), commit('docs: c')];
  const found = breakingCommits(range);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.summary, 'b');
  assert.deepEqual(breakingCommits([commit('fix: a')]), []);
});
