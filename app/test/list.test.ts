import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listPrCells } from '../src/commands/list.ts';
import { visibleWidth } from '../src/ui.ts';
import type { CachedPullRequest } from '../src/pr-cache.ts';

/**
 * `hangar list`'s pull-request columns. Properties rather than text: which cells say something,
 * and which must stay empty, for each shape of record the cache can hold.
 */

const RECORD: CachedPullRequest = {
  branch: 'fixes/ABC-1323_x',
  id: 852,
  url: 'https://example.invalid/pr/852',
  fetchedAt: 17,
  state: 'open',
  draft: false,
  ci: 'pass',
  review: 'approved',
  reviewers: 2,
  approvals: 1,
};

const plain = (cells: readonly string[]): string[] =>
  // eslint-disable-next-line no-control-regex
  cells.map((c) => c.replace(/\x1b\[[0-9;]*m/g, ''));

test('an open pull request says its number, its build and its reviews with their counts', () => {
  const [pr, build, review] = plain(listPrCells({ kind: 'known', record: RECORD, stale: false }));
  assert.equal(pr, '#852');
  assert.ok(build?.includes('pass'));
  assert.ok(review?.includes('approved') && review.includes('1/2'));
  const pending = plain(
    listPrCells({
      kind: 'known',
      record: { ...RECORD, review: 'pending', approvals: 0 },
      stale: false,
    }),
  );
  assert.ok(pending[2]?.includes('pending') && pending[2].includes('0/2'));
});

test('a settled pull request says its state and nothing about builds or reviews', () => {
  for (const state of ['merged', 'declined', 'superseded'] as const) {
    const [pr, build, review] = plain(
      listPrCells({ kind: 'known', record: { ...RECORD, state }, stale: false }),
    );
    assert.ok(pr?.includes(state) && pr.includes('#852'));
    assert.equal(build, '-');
    assert.equal(review, '-');
  }
});

test('id 0 never renders as #0, and a stale record says so', () => {
  const none = plain(listPrCells({ kind: 'known', record: { ...RECORD, id: 0 }, stale: false }));
  assert.ok(!none.some((c) => c.includes('#0')));
  const stale = plain(listPrCells({ kind: 'known', record: RECORD, stale: true }));
  assert.ok(stale[0]?.includes('stale'));
  // Not applicable and not known are different answers, and both leave the other cells empty.
  assert.notDeepEqual(listPrCells({ kind: 'none' }), listPrCells({ kind: 'unknown' }));
  for (const cells of [listPrCells({ kind: 'none' }), listPrCells({ kind: 'unknown' })]) {
    assert.deepEqual(plain(cells).slice(1), ['-', '-']);
    assert.ok(cells.every((c) => visibleWidth(c) > 0));
  }
});
