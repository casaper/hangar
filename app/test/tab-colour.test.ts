import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { tabResetFor } from '../src/commands/up.ts';
import { windowSpecFor } from '../src/commands/open.ts';
import { cloneAt } from '../src/fleet.ts';
import { iterm2TabColourCommand } from '../src/terminal/iterm2.ts';
import type { Hangar } from '../src/hangar.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * iTerm2's tab colour: a clone's tab gets its hue, the hangar tab gets none.
 *
 * Neither half reaches a capture -- the bytes go to a tty -- and both fail quietly: a tab with no
 * colour, or a hangar tab wearing whichever clone its shell last stood in. So the builders are
 * asserted here, and the wrapped command is actually RUN, because whether a shell expands the
 * escapes and still execs the attach command is a fact about `sh`, not about the string.
 */

const hangar = syntheticHangar();

const withChrome = (h: Hangar, chrome: boolean): Hangar => ({
  ...h,
  config: {
    ...h.config,
    terminal: { ...h.config.terminal, colour: { ...h.config.terminal.colour, chrome } },
  },
});

const ESC = '\x1b';
const BEL = '\x07';

test('the wrapped command prints the OSC 6 triple and then runs the command it wraps', () => {
  const line = iterm2TabColourCommand('/bin/echo attached', '153;102;255');
  const res = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(
    res.stdout,
    `${ESC}]6;1;bg;red;brightness;153${BEL}` +
      `${ESC}]6;1;bg;green;brightness;102${BEL}` +
      `${ESC}]6;1;bg;blue;brightness;255${BEL}` +
      'attached\n',
  );
});

test('the wrapped command leaves the attach line as trailing argv, never quoted inside quotes', () => {
  const attach = "/usr/bin/env -u TMUX /opt/tmux -f '/a b/clone-tmux.conf' new-session -A";
  const line = iterm2TabColourCommand(attach, '1;2;3');
  assert.ok(line.endsWith(` ${attach}`));
  assert.ok(!line.includes("'\\''"));
  assert.ok(line.includes('exec "$@"'));
});

test('a clone tab is handed its hue, and none when the chrome layer is off', () => {
  // Set both ways explicitly: `dev/fixture.config.yaml` has the chrome layer off.
  const on = cloneAt(withChrome(hangar, true), 1);
  assert.equal(windowSpecFor(on, 'cmd', 'tab').tabColour, on.colour.mainTriple);
  const off = cloneAt(withChrome(hangar, false), 1);
  assert.equal(windowSpecFor(off, 'cmd', 'tab').tabColour, undefined);
});

test('up resets an iTerm2 tab, and sends nothing anywhere else', () => {
  const iterm = { ITERM_SESSION_ID: 'w0t0p0:x' };
  assert.equal(tabResetFor(iterm, true, true), `${ESC}]6;1;bg;*;default${BEL}`);
  assert.equal(tabResetFor({ TERM_PROGRAM: 'iTerm.app' }, true, true)?.startsWith(ESC), true);
  assert.equal(tabResetFor({ ...iterm, TMUX: '/tmp/s,1,0' }, true, true), undefined);
  assert.equal(tabResetFor(iterm, false, true), undefined);
  assert.equal(tabResetFor(iterm, true, false), undefined);
  assert.equal(tabResetFor({ TERM_PROGRAM: 'Apple_Terminal' }, true, true), undefined);
  assert.equal(tabResetFor({}, true, true), undefined);
});
