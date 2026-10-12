import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withPlansHook } from '../src/clone-config.ts';
import { conflictName } from '../src/plans.ts';
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
