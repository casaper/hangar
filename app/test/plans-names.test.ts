import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { withPlansHook } from '../src/clone-config.ts';
import { conflictName, moveInto } from '../src/plans.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * Two ways `plans collect` and its `doctor` rows went wrong without saying so.
 *
 * No capture reaches either: the conflict name only appears when two plans collide, and the hook
 * writer only drops a key when `doctor --fix` repairs two rows in one run.
 */

test('a conflict copy is one flat filename, whatever path its source is', () => {
  // A source label is a clone name, a nested plan directory or `~/.claude/plans`. Taken
  // verbatim, a `/` makes the target a path under a directory that does not exist, so the
  // rename fails on every run and the plan never leaves `~/.claude/plans`.
  for (const source of ['clone_02', '~/.claude/plans', '/wt/clone_01/angular/.claude/plans']) {
    const name = conflictName('2026-09-08_-_groovy-moseying-crab.md', source);
    assert.ok(!name.includes('/'), name);
    assert.ok(name.startsWith('2026-09-08_-_groovy-moseying-crab.from-'), name);
    assert.ok(name.endsWith('.md'), name);
  }
});

test('the plans hook writer keeps a plansDirectory doctor wrote', () => {
  // `doctor --fix` writes an explicit value when the tracked one resolves outside the clone, then
  // repairs a missing hook through this writer. Dropping the key here would undo the first repair.
  const settings = withPlansHook(syntheticHangar(), { plansDirectory: '.claude/plans' });
  assert.equal(settings.plansDirectory, '.claude/plans');
});

test('a collected plan never lands on top of one already in the archive', () => {
  // Twin `SessionEnd` runs pick target names from one stale snapshot, and a rename would replace
  // the first run's plan with the second's, silently.
  const dir = mkdtempSync(join(tmpdir(), 'plans-move-'));
  try {
    const first = join(dir, 'a.md');
    const second = join(dir, 'b.md');
    const target = join(dir, 'archive.md');
    writeFileSync(first, 'first\n');
    writeFileSync(second, 'second\n');
    moveInto(first, target);
    assert.equal(existsSync(first), false);
    assert.throws(() => {
      moveInto(second, target);
    }, /EEXIST/);
    assert.equal(readFileSync(target, 'utf8'), 'first\n');
    assert.equal(readFileSync(second, 'utf8'), 'second\n', 'the loser must stay where it was');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
