import assert from 'node:assert/strict';
import { test } from 'node:test';

import { iterm2OpenScript } from '../src/terminal/iterm2.ts';
import type { WindowSpec } from '../src/terminal/types.ts';

/**
 * Where iTerm2 puts a clone's tab.
 *
 * Nothing but iTerm2 itself can show which window a tab landed in, and the wrong one fails
 * quietly -- the tab opens, the client attaches, `open` reports success, and the developer is
 * looking at a different window. So the script is asserted as text: that a tab with a known
 * origin is created beside it, and that every other case still has somewhere to go.
 */

const spec = (overrides: Partial<WindowSpec>): WindowSpec => ({
  command: '/usr/bin/env tmux attach',
  placement: 'tab',
  ...overrides,
});

test('a tab with an origin tty is created in the window hosting that tty', () => {
  const script = iterm2OpenScript(spec({ originTty: 'ttys001' }));
  assert.ok(script.includes('if tty of s is "/dev/ttys001" then'), 'matches the full device path');
  assert.ok(script.includes('tell w to create tab with default profile command'));
  // The origin may be in no iTerm2 window at all -- run from another emulator, or its tab closed.
  assert.ok(
    script.indexOf('tell w to create tab') < script.indexOf('tell current window'),
    'the current window is the fallback, after the search',
  );
});

test('a tab with no origin goes to the current window, or a new one when there is none', () => {
  const script = iterm2OpenScript(spec({}));
  assert.ok(!script.includes('tty of s'));
  assert.ok(script.includes('tell current window to create tab'));
  assert.ok(script.includes('if (count of windows) is 0 then'));
});

test('a window placement ignores the origin', () => {
  const script = iterm2OpenScript(spec({ placement: 'window', originTty: '/dev/ttys001' }));
  assert.ok(!script.includes('tty of s'));
  assert.ok(script.includes('create window with default profile command'));
  assert.ok(!script.includes('create tab'));
});
