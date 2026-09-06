import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CliError } from '../src/exec.ts';
import { CHANGELOG_TYPES, RELEASE_RULES } from '../src/release/rules.ts';
import { nextVersion, parseCommit, releasePlanText } from '../src/release/version.ts';

/**
 * Which version a range of commits produces -- the only part of `hangar dev release` that
 * DECIDES anything, and so the only part a test can hold.
 *
 * Everything else that command does moves git state, and a capture of it would be a capture of
 * one release that has already happened. These are properties instead: what each type is worth,
 * that the highest one in a range wins, and that a breaking marker at 0.x is refused rather
 * than quietly escalated -- the assertion that stands between a stray `!` and a 1.0.0 nobody
 * decided on.
 */

const commit = (subject: string, body = ''): ReturnType<typeof parseCommit> =>
  parseCommit({ sha: 'abc1234', subject, body });

test('feat is the only type that moves the minor', () => {
  assert.equal(nextVersion('0.13.0', [commit('feat(sync): Add a thing')])?.version, '0.14.0');
  assert.equal(nextVersion('0.13.0', [commit('feat: Add a thing')])?.bump, 'minor');
});

test('every patch type moves the patch, the four this repo added included', () => {
  for (const type of ['fix', 'perf', 'revert', 'docs', 'refactor', 'test', 'build']) {
    const next = nextVersion('0.13.0', [commit(`${type}(cli): Something`)]);
    assert.equal(next?.version, '0.13.1', `${type} should be a patch`);
  }
});

test('ci, chore and style release nothing at all', () => {
  const commits = ['ci: Run it', 'chore(cli): Tidy', 'style: Reflow'].map((s) => commit(s));
  assert.equal(nextVersion('0.13.0', commits), undefined);
});

test('a subject that is not a Conventional Commit releases nothing', () => {
  assert.equal(nextVersion('0.13.0', [commit('Just some prose')]), undefined);
});

test('the highest bump in a mixed range wins, whatever the order', () => {
  const parts = [commit('fix: a'), commit('feat: b'), commit('chore: c')];
  assert.equal(nextVersion('0.13.0', parts)?.version, '0.14.0');
  assert.equal(nextVersion('0.13.0', [...parts].reverse())?.version, '0.14.0');
});

test('an empty range is undefined rather than a no-op release', () => {
  assert.equal(nextVersion('0.13.0', []), undefined);
});

test('a breaking change while the major is 0 is refused, not escalated', () => {
  const bang = [commit('feat(cli)!: Change everything')];
  assert.throws(() => nextVersion('0.13.0', bang), CliError);

  const footer = [commit('fix(cli): Something', 'BREAKING CHANGE: the flag is gone')];
  assert.throws(() => nextVersion('0.13.0', footer), CliError);

  // The refusal is about 0.x specifically: past 1.0.0 a breaking change is an ordinary major.
  assert.equal(nextVersion('1.4.2', bang)?.version, '2.0.0');
});

test('the patch bump carries the minor and major through unchanged', () => {
  assert.equal(nextVersion('2.7.13', [commit('fix: a')])?.version, '2.7.14');
  assert.equal(nextVersion('2.7.13', [commit('feat: a')])?.version, '2.8.0');
});

test('a scope is read out of the header, and its absence is undefined not empty', () => {
  assert.equal(commit('fix(modes): x').scope, 'modes');
  assert.equal(commit('fix: x').scope, undefined);
  assert.equal(commit('fix(): x').scope, undefined);
});

/**
 * The two tables are one source read twice -- by `changelog.preset.ts` and by `nextVersion` --
 * so the thing worth asserting is that they agree about what a type IS. A type that releases
 * something and renders into no section would vanish from the CHANGELOG of the release it
 * caused.
 */
test('every type that releases something also has a changelog section', () => {
  for (const type of Object.keys(RELEASE_RULES)) {
    const entry = CHANGELOG_TYPES.find((t) => t.type === type && t.scope === undefined);
    assert.ok(entry !== undefined, `${type} moves the version but renders nowhere`);
    assert.ok(entry.hidden !== true, `${type} moves the version but is hidden`);
  }
});

/**
 * The release commit must not appear in the changelog it commits, and `Array.find` is what makes
 * that fragile: the preset takes the FIRST entry whose type matches, so the scoped one only
 * wins while it sits in front of the bare one.
 */
test('the hidden chore(release) entry precedes the bare chore entry', () => {
  const hidden = CHANGELOG_TYPES.findIndex((t) => t.type === 'chore' && t.scope === 'release');
  const bare = CHANGELOG_TYPES.findIndex((t) => t.type === 'chore' && t.scope === undefined);
  assert.ok(hidden !== -1 && bare !== -1);
  assert.ok(hidden < bare, 'the scoped entry must come first or it never matches');
});

test('the plan text names the versions, the tag and every commit', () => {
  const commits = [commit('feat(test): Gate the tree'), commit('chore(cli): Tidy')];
  const next = nextVersion('0.13.0', commits);
  assert.ok(next !== undefined);
  const text = releasePlanText({
    from: 'v0.13.0',
    current: '0.13.0',
    next,
    tag: 'v0.14.0',
    commits,
  });
  for (const want of ['v0.13.0', '0.14.0', 'v0.14.0', 'minor', 'Gate the tree', 'Tidy']) {
    assert.ok(text.includes(want), `the plan should name ${want}`);
  }
});
