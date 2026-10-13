import assert from 'node:assert/strict';
import { test } from 'node:test';

import { downRootLines } from '../src/commands/down.ts';

/**
 * `hangar down`'s report on the root window. The clone half is `close`'s planner, unchanged.
 */

test('a root window that is not running says so, and plans no kill', () => {
  const lines = downRootLines(false, []);
  assert.equal(lines.length, 1);
  assert.ok(!lines.some((l) => l.includes('kill')));
});

test('every live Claude Code tab is named with its uptime, and the kill is the last line', () => {
  const lines = downRootLines(true, [
    { name: 'ops', claudeUp: '01:02:03' },
    { name: 'dev', claudeUp: '04:05' },
    { name: 'shell', claudeUp: undefined },
  ]);
  assert.ok(lines.some((l) => l.includes('ops') && l.includes('01:02:03')));
  assert.ok(lines.some((l) => l.includes('dev') && l.includes('04:05')));
  assert.ok(lines.some((l) => l.includes('shell') && !l.includes('Claude')));
  assert.ok(lines.at(-1)?.includes('kill'), 'the server kill is reported last, as it runs');
});
