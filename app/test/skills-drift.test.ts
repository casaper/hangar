import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyDrift, type DriftFacts, type SkillEntry } from '../src/commands/skills.ts';

/**
 * The personal-skill drift verdict, through its pure classifier.
 *
 * Everything this decides is read out of git -- a blob on the default branch, whether that branch
 * is there at all -- so none of it is reachable from a golden capture, and half the states need a
 * repository in a condition nobody can arrange on demand: an original DELETED upstream, a default
 * branch missing from a shallow clone. Handing the classifier the facts is what makes those
 * assertable at all.
 *
 * The distinction the whole file is about: an original absent from the default branch means two
 * opposite things, and only `adoptedFrom` says which.
 */

const ORIGINAL = '3df1c0c526807af2fa701eecdcbe5d65627d376a';
const MOVED = '691ab4f79c8b62190a0fb87c6e73e6da8a277ffe';

const entry = (over: Partial<SkillEntry> = {}): SkillEntry => ({
  name: 'shorten-comment',
  divergence: 'intentional',
  mirrors: '.claude/skills/shorten-comment/SKILL.md',
  basedOn: ORIGINAL,
  ...over,
});

const facts = (over: Partial<DriftFacts> = {}): DriftFacts => ({
  branch: 'master',
  repoFound: true,
  hasBranch: true,
  original: ORIGINAL,
  ours: undefined,
  ...over,
});

test('an original absent from the default branch is a finding only when nobody said it would be', () => {
  /*
   * The same `rev-parse` miss, read two ways. Undeclared, the original was removed and the copy
   * here now shadows nothing -- a real finding. Declared, the skill was adopted ahead of its
   * merge and the absence is exactly what was expected.
   */
  const gone = classifyDrift(entry(), facts({ original: undefined }));
  assert.equal(gone.kind, 'drifted');
  assert.match(gone.detail, /gone from master/);

  const waiting = classifyDrift(
    entry({ adoptedFrom: 'feature/adds-it' }),
    facts({ original: undefined }),
  );
  assert.equal(waiting.kind, 'pending');
  // The detail names the branch, because it is the only place that blob is reachable from until
  // it merges -- and the only thing a reader can act on.
  assert.match(waiting.detail, /feature\/adds-it/);
});

test('waiting costs no detection, which is the whole reason it is not a failure', () => {
  /*
   * The property that makes `pending` safe rather than merely quieter. The moment the blob turns
   * up, the ordinary comparison resumes -- unchanged is green, changed on the way in is red and
   * names the move. So the red row during the wait would detect nothing the merge does not; it
   * would only nag, and it was in fact read as "the link was never made".
   */
  const adopted = entry({ adoptedFrom: 'feature/adds-it' });
  assert.equal(classifyDrift(adopted, facts({ original: ORIGINAL })).kind, 'ok');

  const changed = classifyDrift(adopted, facts({ original: MOVED }));
  assert.equal(changed.kind, 'drifted');
  assert.match(changed.detail, /the original moved/);
});

test('a clone that could not be read is never mistaken for an answer', () => {
  // Four different ways of knowing nothing, and not one of them is a failure: going red on a
  // shallow clone would make the check red in normal operation for anyone who has one.
  const unreadable: readonly DriftFacts[] = [
    facts({ repoFound: false }),
    facts({ hasBranch: false, original: undefined }),
  ];
  for (const [at, shape] of unreadable.entries()) {
    assert.equal(classifyDrift(entry(), shape).kind, 'not-compared', `shape ${String(at)}`);
  }
  assert.equal(
    classifyDrift(entry({ mirrors: undefined }), facts()).kind,
    'not-compared',
    'no mirrors path',
  );
  // `intentional` with no `basedOn` is refused by the schema, so this is the belt to that braces:
  // comparing against nothing must not read as agreement.
  assert.equal(classifyDrift(entry({ basedOn: undefined }), facts()).kind, 'not-compared');
});

test('a standalone skill is never compared, whatever the clone happens to hold', () => {
  const alone = entry({ divergence: 'standalone', mirrors: undefined, basedOn: undefined });
  for (const shape of [facts(), facts({ original: undefined }), facts({ repoFound: false })]) {
    assert.equal(classifyDrift(alone, shape).kind, 'standalone');
  }
});

test('a copy that may not differ is compared by content, and only there', () => {
  const same = entry({ divergence: 'none', basedOn: undefined });
  assert.equal(classifyDrift(same, facts({ ours: ORIGINAL })).kind, 'ok');
  assert.equal(classifyDrift(same, facts({ ours: MOVED })).kind, 'drifted');
  // `basedOn` is an `intentional` concept: a `none` entry carrying one must not be judged by it.
  assert.equal(
    classifyDrift(entry({ divergence: 'none' }), facts({ ours: MOVED })).kind,
    'drifted',
  );
});
