import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describePush, pushes, pushPlan } from '../src/push.ts';

/** What `hangar push`, and the push in front of `pr create`/`pr update`, would do. */

test('only a missing branch or one ahead of origin is pushed', () => {
  assert.equal(pushPlan({ onOrigin: false, ahead: 0, behind: 0 }), 'missing');
  assert.equal(pushPlan({ onOrigin: false, ahead: 5, behind: 0 }), 'missing');
  assert.equal(pushPlan({ onOrigin: true, ahead: 2, behind: 0 }), 'ahead');
  assert.equal(pushPlan({ onOrigin: true, ahead: 0, behind: 0 }), 'up-to-date');
  assert.equal(pushPlan({ onOrigin: true, ahead: 0, behind: 3 }), 'behind');
  assert.equal(pushPlan({ onOrigin: true, ahead: 2, behind: 3 }), 'diverged');
  const pushed = (['missing', 'ahead', 'up-to-date', 'behind', 'diverged'] as const).filter(pushes);
  assert.deepEqual(pushed, ['missing', 'ahead'], 'never a pull, never a force');
});

test('every plan says which branch and how many commits', () => {
  for (const plan of ['missing', 'ahead', 'up-to-date', 'behind', 'diverged'] as const) {
    const line = describePush('features/ABC-1323_x', { plan, ahead: 1, behind: 2 });
    assert.match(line, /features\/ABC-1323_x/, plan);
  }
  assert.match(describePush('b', { plan: 'ahead', ahead: 1, behind: 0 }), /1 commit /);
  assert.match(describePush('b', { plan: 'diverged', ahead: 1, behind: 2 }), /2 commits there/);
});
