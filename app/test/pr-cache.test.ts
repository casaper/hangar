import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ciStateOf, reviewStateOf } from '../src/bitbucket.ts';
import { cloneAt } from '../src/fleet.ts';
import {
  parsePrCacheLine,
  pickPullRequest,
  prCacheIsStale,
  prCacheLine,
  readCachedPr,
  writeCachedPr,
  type CachedPullRequest,
} from '../src/pr-cache.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * What a branch's pull request is doing, remembered on disk.
 *
 * Properties, and one of them needs a real directory: the cache is a file, and "another branch's
 * line is not an answer" is a claim about what a read does with what a write left behind.
 */

const RECORD: CachedPullRequest = {
  branch: 'fixes/BE-12_x',
  id: 852,
  url: 'https://example.invalid/pr/852',
  fetchedAt: 17,
  state: 'open',
  draft: true,
  ci: 'fail',
  review: 'changes',
};

test('a cache line round-trips, and anything else is not a cache line', () => {
  assert.deepEqual(parsePrCacheLine(prCacheLine(RECORD)), RECORD);
  // The newline is not decoration: shell `read` returns non-zero at an EOF with no newline, so
  // a file written without one is a cache the bar can never use.
  assert.ok(prCacheLine(RECORD).endsWith('\n'));
  // Every field has to survive the trip, or the bar draws a state nobody is in.
  for (const state of ['open', 'merged', 'declined'] as const) {
    for (const ci of ['pass', 'fail', 'running', 'none'] as const) {
      for (const review of ['approved', 'changes', 'none'] as const) {
        const record = { ...RECORD, state, ci, review, draft: false };
        assert.deepEqual(parsePrCacheLine(prCacheLine(record)), record);
      }
    }
  }
  for (const junk of ['', 'branch', 'branch x url 1', '{"id":1}']) {
    assert.equal(parsePrCacheLine(junk), undefined, `parsed junk: ${junk}`);
  }
});

test('an unknown trailing field is tolerated, and a short line still names its pull request', () => {
  /*
   * The half of "fields are appended, never reordered" that has to be true on the READ side.
   * A record written by a newer CLI must not read as corrupt -- and the case that actually
   * happens is the other one: the first redraw after an upgrade meets a four-field line written
   * by the old CLI, and blanking the bar there would look exactly like a broken script.
   */
  const forward = parsePrCacheLine(`${prCacheLine(RECORD).trim()} something-new-here\n`);
  assert.deepEqual(forward, RECORD, 'a field from the future was not ignored');

  const old = parsePrCacheLine('fixes/BE-12_x 852 https://example.invalid/852 17\n');
  assert.ok(old !== undefined, 'a short line stopped naming its pull request');
  assert.equal(old.id, 852);
  assert.equal(old.state, 'open', 'the fallback state should be the unremarkable one');
  assert.equal(old.draft, false);
  assert.equal(old.ci, 'none');
  assert.equal(old.review, 'none');

  // An unreadable value falls back rather than propagating: the bar has no way to draw "?".
  const bogus = parsePrCacheLine('b 1 u 2 sideways yes purple maybe\n');
  assert.ok(bogus !== undefined);
  assert.equal(bogus.state, 'open');
  assert.equal(bogus.ci, 'none');
  assert.equal(bogus.review, 'none');
});

test('id 0 is the negative record — asked, and there is none', () => {
  /*
   * The property the whole refresh loop rests on. Without a way to write "asked, none exists",
   * a branch that never gets a pull request is indistinguishable from one nobody has looked up,
   * so every redraw re-asks for ever.
   */
  const none: CachedPullRequest = { ...RECORD, id: 0, url: 'https://example.invalid/search' };
  const parsed = parsePrCacheLine(prCacheLine(none));
  assert.ok(parsed !== undefined, 'a negative record is an ANSWER, not an unreadable line');
  assert.equal(parsed.id, 0, 'the negative record has to survive the round trip');
});

test('freshness is measured against the TTL, and an absent record is always stale', () => {
  assert.equal(prCacheIsStale(undefined, 90, 1_000), true);
  assert.equal(prCacheIsStale({ ...RECORD, fetchedAt: 1_000 }, 90, 1_000), false);
  assert.equal(prCacheIsStale({ ...RECORD, fetchedAt: 950 }, 90, 1_000), false);
  assert.equal(prCacheIsStale({ ...RECORD, fetchedAt: 910 }, 90, 1_000), true, 'exactly the TTL');
  assert.equal(prCacheIsStale({ ...RECORD, fetchedAt: 0 }, 90, 1_000), true);
});

test("a cached pull request belongs to ONE branch, and another branch's is not read", () => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-pr-'));
  const h = syntheticHangar({ root });
  const clone = cloneAt(h, 1);
  assert.equal(readCachedPr(h, clone, 'anything'), undefined, 'a cold cache is not an error');

  writeCachedPr(h, clone, RECORD);
  assert.deepEqual(readCachedPr(h, clone, 'fixes/BE-12_x'), RECORD);
  // The whole reason it is keyed on the branch: last week's number on today's branch is the
  // shape of wrong that gets believed, so a line for another branch is simply not an answer.
  assert.equal(readCachedPr(h, clone, 'fixes/BE-99_y'), undefined);

  // A record is SUPERSEDED, never deleted: "this branch has no pull request" is itself a record
  // (id 0), so there is no path that leaves the bar unable to tell "none" from "never asked".
  writeCachedPr(h, clone, { ...RECORD, id: 0 });
  assert.equal(readCachedPr(h, clone, 'fixes/BE-12_x')?.id, 0);
});

test('a change request outranks an approval, and only reviewers count', () => {
  /*
   * The live case this was written against had one of each on the same pull request. Showing the
   * approval there would report the good half of a mixed answer about a branch that is blocked.
   */
  assert.equal(
    reviewStateOf([
      { role: 'REVIEWER', state: 'approved' },
      { role: 'REVIEWER', state: 'changes_requested' },
    ]),
    'changes',
  );
  assert.equal(reviewStateOf([{ role: 'REVIEWER', state: 'approved' }]), 'approved');
  assert.equal(reviewStateOf([]), 'none');
  assert.equal(reviewStateOf([{ role: 'REVIEWER', state: null }]), 'none');
  // Bitbucket adds a PARTICIPANT for anybody who comments. They were never asked for a verdict.
  assert.equal(reviewStateOf([{ role: 'PARTICIPANT', state: 'approved' }]), 'none');
});

test('the worst build state on a commit is the one that counts', () => {
  // This fleet's CI posts one status per job, so several on one commit is the normal case and a
  // green unit-test build beside a red end-to-end one is a red commit.
  assert.equal(ciStateOf(['SUCCESSFUL', 'FAILED']), 'fail');
  assert.equal(ciStateOf(['INPROGRESS', 'FAILED']), 'fail', 'a known failure is not provisional');
  assert.equal(ciStateOf(['SUCCESSFUL', 'INPROGRESS']), 'running');
  assert.equal(ciStateOf(['SUCCESSFUL']), 'pass');
  // A cancelled build did not pass, and calling it "no build" would draw the same as a commit
  // CI never saw.
  assert.equal(ciStateOf(['STOPPED']), 'fail');
  assert.equal(ciStateOf([]), 'none');
  assert.equal(ciStateOf(['SOMETHING_NEW']), 'none', 'an unknown state is not a pass');
});

test('an open pull request wins over a closed one on the same branch', () => {
  const base = {
    title: '',
    destination: 'master',
    url: '',
    headCommit: '',
    review: 'none',
  } as const;
  const merged = { ...base, id: 1, state: 'merged' as const, draft: false };
  const open = { ...base, id: 2, state: 'open' as const, draft: false };
  assert.equal(pickPullRequest([merged, open])?.id, 2);
  assert.equal(pickPullRequest([open, merged])?.id, 2);
  // With none open, the most recent -- Bitbucket returns them oldest first for this query.
  assert.equal(pickPullRequest([merged, { ...merged, id: 3 }])?.id, 3);
  assert.equal(pickPullRequest([]), undefined);
});
