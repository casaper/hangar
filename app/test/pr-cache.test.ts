import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cloneAt } from '../src/fleet.ts';
import {
  forgetCachedPr,
  parsePrCacheLine,
  prCacheLine,
  readCachedPr,
  writeCachedPr,
} from '../src/pr-cache.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * Which pull request a branch has, remembered on disk.
 *
 * Properties, and one of them needs a real directory: the cache is a file, and "another branch's
 * line is not an answer" is a claim about what a read does with what a write left behind.
 */

test('a cache line round-trips, and anything else is not a cache line', () => {
  const pr = {
    branch: 'fixes/BE-12_x',
    id: 852,
    url: 'https://example.invalid/pr/852',
    fetchedAt: 17,
  };
  assert.deepEqual(parsePrCacheLine(prCacheLine(pr)), pr);
  // The newline is not decoration: shell `read` returns non-zero at an EOF with no newline, so
  // a file written without one is a cache the bar can never use.
  assert.ok(prCacheLine(pr).endsWith('\n'));
  for (const junk of ['', 'branch', 'branch 12', 'branch x url 1', 'a 1 u 1 extra', '{"id":1}']) {
    assert.equal(parsePrCacheLine(junk), undefined, `parsed junk: ${junk}`);
  }
});

test("a cached pull request belongs to ONE branch, and another branch's is not read", () => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-pr-'));
  const h = syntheticHangar({ root });
  const clone = cloneAt(h, 1);
  assert.equal(readCachedPr(h, clone, 'anything'), undefined, 'a cold cache is not an error');

  const pr = { branch: 'fixes/BE-12_x', id: 852, url: 'https://example.invalid/852', fetchedAt: 1 };
  writeCachedPr(h, clone, pr);
  assert.deepEqual(readCachedPr(h, clone, 'fixes/BE-12_x'), pr);
  // The whole reason it is keyed on the branch: last week's number on today's branch is the
  // shape of wrong that gets believed, so a line for another branch is simply not an answer.
  assert.equal(readCachedPr(h, clone, 'fixes/BE-99_y'), undefined);

  // And forgetting is branch-scoped too -- another branch's line is somebody else's answer.
  forgetCachedPr(h, clone, 'fixes/BE-99_y');
  assert.deepEqual(readCachedPr(h, clone, 'fixes/BE-12_x'), pr, 'the wrong branch deleted it');
  forgetCachedPr(h, clone, 'fixes/BE-12_x');
  assert.equal(readCachedPr(h, clone, 'fixes/BE-12_x'), undefined);
});
