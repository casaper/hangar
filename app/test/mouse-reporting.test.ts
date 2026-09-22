import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mouseReportingBadge } from '../src/commands/doctor.ts';
import { appleTerminalDriver } from '../src/terminal/apple-terminal.ts';
import { gnomeTerminalDriver } from '../src/terminal/gnome-terminal.ts';
import { iterm2Driver, iterm2MouseReport, iterm2MouseState } from '../src/terminal/iterm2.ts';
import { konsoleDriver } from '../src/terminal/konsole.ts';
import { noneDriver } from '../src/terminal/none.ts';
import type { MouseReporting } from '../src/terminal/types.ts';

/**
 * Whether the emulator reports a CLICK at all -- the second half of a bar that can be clicked.
 *
 * The first half is the tmux binding, which `tmux-conf.test.ts` pins. This is the half that has
 * no binding to look at: iTerm2 splits scroll reporting from button reporting across two
 * settings, so a profile can scroll a pane with the wheel and deliver no click, and nothing
 * inside tmux can tell that apart from a wrong key. Every gate stays green and the tabs, the
 * issue key and the pull request are all dead.
 *
 * The decision is pure, which is the only reason any of this is assertable: the probe reads this
 * machine's own preferences, so the state a capture would pin is whatever the developer running
 * it happens to have set.
 */

const ALL_STATES: readonly MouseReporting[] = ['clicks', 'wheel-only', 'off', 'unknown'];

const profile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  Guid: 'THE-DEFAULT',
  Name: 'Default',
  'Mouse Reporting': true,
  ...over,
});

test('wheel reporting without clicks is its own state, and a missing key is not it', () => {
  // The measured shape: reporting on, buttons off. This is what a click-that-does-nothing looks
  // like in the preferences file, and it is the whole reason this probe exists.
  assert.equal(
    iterm2MouseState([profile({ 'Mouse Reporting allow clicks and drags': false })], 'THE-DEFAULT'),
    'wheel-only',
  );
  // Absent, not false. iTerm2's shipped DefaultBookmark.plist carries `Mouse Reporting` and NOT
  // this key, so its compiled-in default is unverified -- and a guess here is a false alarm on a
  // machine that is fine. Only the state that was measured is ever reported.
  assert.equal(iterm2MouseState([profile()], 'THE-DEFAULT'), 'clicks');
  assert.equal(iterm2MouseState([profile({ 'Mouse Reporting': false })], 'THE-DEFAULT'), 'off');
});

test('the DEFAULT profile is the one read, because that is the one every clone window runs under', () => {
  // `openScript` creates every tab and window `with default profile`, so this is not a guess
  // about which of several profiles a developer's window uses.
  const others = [
    profile({ Guid: 'OTHER', 'Mouse Reporting': false }),
    profile({ 'Mouse Reporting allow clicks and drags': false }),
    profile({ Guid: 'ANOTHER', 'Mouse Reporting allow clicks and drags': false }),
  ];
  assert.equal(iterm2MouseState(others, 'THE-DEFAULT'), 'wheel-only');
  // One profile is the default whatever the guid says -- and `Default Bookmark Guid` is a
  // separate read that can fail on its own.
  assert.equal(
    iterm2MouseState([profile({ 'Mouse Reporting allow clicks and drags': false })], undefined),
    'wheel-only',
  );
  // Several profiles and no way to tell which: declined rather than guessed at.
  assert.equal(iterm2MouseState(others, undefined), 'unknown');
  assert.equal(iterm2MouseState(others, 'NO-SUCH-PROFILE'), 'unknown');
});

test('anything unreadable is unknown, and never a default', () => {
  // The probe hands this whatever `JSON.parse` produced, so the shapes are not hypothetical.
  const unreadable: readonly unknown[] = [undefined, null, {}, 'a string', 42, []];
  for (const [at, shape] of unreadable.entries()) {
    assert.equal(iterm2MouseState(shape, 'THE-DEFAULT'), 'unknown', `shape ${String(at)}`);
  }
  // A profile list holding nothing that is a profile is the same case.
  assert.equal(iterm2MouseState(['x', 3], 'THE-DEFAULT'), 'unknown');
});

test('exactly the two states with a repair carry a hint, and it names the setting', () => {
  for (const state of ALL_STATES) {
    const report = iterm2MouseReport(state);
    assert.equal(report.state, state);
    const wanted = state === 'wheel-only' || state === 'off';
    assert.equal(report.hint !== undefined, wanted, state);
  }
  // A hint that named only the symptom would send the reader to tmux, which is where this was
  // looked for the first time and is not where it is.
  assert.match(iterm2MouseReport('wheel-only').hint ?? '', /Settings → Profiles → Terminal/);
  // And it names the cost, because the setting is off on purpose often enough that "turn it on"
  // alone would be advice rather than information.
  assert.match(iterm2MouseReport('wheel-only').hint ?? '', /drag/);
  assert.match(iterm2MouseReport('off').hint ?? '', /Settings → Profiles → Terminal/);
});

test('doctor says nothing at all when there is nothing to say', () => {
  // `unknown` and `clicks` both render as silence, which is what keeps the emulator row the same
  // one line on every machine but the one it has something to report.
  assert.equal(mouseReportingBadge('clicks'), undefined);
  assert.equal(mouseReportingBadge('unknown'), undefined);
  for (const state of ['wheel-only', 'off'] as const) {
    const badge = mouseReportingBadge(state);
    assert.ok(badge !== undefined && badge.length > 0, state);
  }
  // The badge and the hint agree about which states are worth a word: a badge with no hint would
  // name a problem and withhold its repair.
  for (const state of ALL_STATES) {
    assert.equal(
      mouseReportingBadge(state) !== undefined,
      iterm2MouseReport(state).hint !== undefined,
      state,
    );
  }
});

test('the probe is on the seam, and only the driver that can answer carries it', () => {
  // The wiring, not the decision. `iterm2MouseState` is pure and covered above; nothing there
  // would notice the method being dropped from the object the driver factory returns.
  assert.ok(iterm2Driver().mouseReporting !== undefined);
  for (const driver of [
    appleTerminalDriver(),
    konsoleDriver(),
    gnomeTerminalDriver(),
    noneDriver(undefined),
  ]) {
    // Omitted rather than answering `unknown`, so "nobody asked" and "asked and it is fine" stay
    // different states -- and a driver that learns to answer has to opt in rather than inherit a
    // silence that looks like a measurement.
    assert.equal(driver.mouseReporting, undefined, driver.kind);
  }
});
