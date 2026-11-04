import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { lockVerdict, tryTakeLock } from '../src/tmp-merge-lock.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * The lock that keeps two `tmp merge` runs -- one per clone's `SessionEnd`, all at once after a
 * `reload` -- from racing inside `jdupes -L`. Properties: one holder at a time, a dead holder
 * never blocks, and a release never removes somebody else's lock.
 */

const dir = mkdtempSync(join(tmpdir(), 'hangar-merge-lock-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ALIVE = (): boolean => true;
const DEAD = (): boolean => false;

test('no lock file is taken, a live pid is waited for, a dead one is stale', () => {
  assert.equal(lockVerdict(undefined, 0, ALIVE), 'take');
  assert.equal(lockVerdict('4242\n', 60_000, ALIVE), 'wait');
  assert.equal(lockVerdict('4242\n', 0, DEAD), 'stale');
});

test('a lock with no pid in it is mid-creation while young, and stale once old', () => {
  assert.equal(lockVerdict('', 100, ALIVE), 'wait');
  assert.equal(lockVerdict('garbage', 600_000, ALIVE), 'stale');
});

test('a second take fails while the first holds it, and succeeds after release', () => {
  const path = join(dir, 'a', 'tmp-merge.lock');
  const first = tryTakeLock(path, 111, ALIVE);
  assert.ok(first.taken);
  assert.deepEqual(tryTakeLock(path, 222, ALIVE), { taken: false, holder: '111' });
  first.release();
  assert.equal(existsSync(path), false);
  const third = tryTakeLock(path, 222, ALIVE);
  assert.ok(third.taken);
  third.release();
});

test('a dead holder is cleared and the lock taken', () => {
  const path = join(dir, 'b.lock');
  writeFileSync(path, '999999\n');
  const attempt = tryTakeLock(path, 333, DEAD);
  assert.ok(attempt.taken);
  assert.equal(readFileSync(path, 'utf8').trim(), '333');
  attempt.release();
});

test("release leaves a lock that is no longer this run's alone", () => {
  const path = join(dir, 'c.lock');
  const attempt = tryTakeLock(path, 444, ALIVE);
  assert.ok(attempt.taken);
  writeFileSync(path, '555\n');
  attempt.release();
  assert.equal(readFileSync(path, 'utf8').trim(), '555');
});

test('the lock lives under the hangar root, beside its other state', () => {
  const hangar = syntheticHangar();
  assert.ok(hangar.paths.tmpMergeLock.startsWith(join(hangar.root, '.hangar') + '/'));
});
