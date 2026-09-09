import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  closePlan,
  closeWarnings,
  describeCloseAction,
  type CloseFacts,
} from '../src/commands/close.ts';
import { emacsDriver } from '../src/editor/emacs.ts';
import { jetbrainsDriver } from '../src/editor/jetbrains.ts';
import { VSCODE_FORKS } from '../src/editor/kinds.ts';
import { eclipseDriver, xcodeDriver } from '../src/editor/launch-only.ts';
import { vimDriver } from '../src/editor/vim.ts';
import { vscodeDriver } from '../src/editor/vscode.ts';
import { zedDriver } from '../src/editor/zed.ts';
import { cloneAt } from '../src/fleet.ts';
import { platform } from '../src/platform/index.ts';
import { linuxPlatform } from '../src/platform/linux.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * `close`, through its pure planner.
 *
 * It ends processes somebody is working in, so the decision is a pure function of read facts and
 * the writes are a switch over its output -- which is what lets every branch, the refusal
 * included, be asserted here without a clone, a tmux server or a live Claude Code session. `-n`
 * renders the same list, so a dry run cannot describe something the real run does not do.
 *
 * The two seam tests at the end belong with it: `close` is the only consumer of
 * `EditorCapabilities.closeWindow` and of `PlatformDriver.closeAppWindow`.
 */

const closeFacts = (over: Partial<CloseFacts> = {}): CloseFacts => {
  const hangar = syntheticHangar();
  return {
    clone: cloneAt(hangar, 1),
    sessionExists: true,
    roles: ['claude', 'shell'],
    claudeSessions: 0,
    servers: [],
    serversUnknown: false,
    fromInside: false,
    closers: [],
    ...over,
  };
};

test('close kills the session and only then collects what the dead session cannot', () => {
  const actions = closePlan(closeFacts(), {});
  const kinds = actions.map((a) => a.kind);
  assert.deepEqual(kinds, ['kill-session', 'collect']);
  // The ordering is the assertion, not the presence. A killed Claude Code process skips its
  // SessionEnd hook, so this command has to collect -- and the root CLAUDE.md's reason for the
  // hook's timing is that session end is the first moment nothing can rewrite the plan. Collect
  // first and it races the session being closed.
  assert.ok(kinds.indexOf('collect') > kinds.indexOf('kill-session'));
});

test('close refuses from inside the clone it would close, and --force is the way past', () => {
  const inside = closeFacts({ fromInside: true });
  assert.deepEqual(
    closePlan(inside, {}).map((a) => a.kind),
    ['refuse-from-inside'],
  );
  // Nothing else is planned either -- a refusal that still closed the editor window would leave
  // the developer with the terminal they are typing in and no editor.
  assert.deepEqual(
    closePlan(inside, { force: true }).map((a) => a.kind),
    ['kill-session', 'collect'],
  );
});

test('close collects nothing when there was no session to kill', () => {
  // With nothing running, no SessionEnd hook was skipped, so there is nothing here the clone's
  // own hook has not already done.
  const actions = closePlan(closeFacts({ sessionExists: false, roles: [] }), {});
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['nothing-open'],
  );
});

test('close warns about what dies with the session, and about not having been able to look', () => {
  const busy = closeFacts({ claudeSessions: 2, servers: ['ng_serve'] });
  const warnings = closeWarnings(busy).join('\n');
  assert.match(warnings, /2 live Claude Code session/);
  assert.match(warnings, /ng_serve/);
  // "Nothing is running" and "nobody could ask" are the same empty list, and only one of them is
  // a reason to go ahead -- the same distinction `ServerScan.portsChecked` exists for.
  assert.match(closeWarnings(closeFacts({ serversUnknown: true })).join('\n'), /lsof/);
  assert.deepEqual(closeWarnings(closeFacts()), []);
});

test('every close action renders a line, so a dry run can never fall silent', () => {
  const all = [
    ...closePlan(closeFacts({ fromInside: true }), {}),
    ...closePlan(closeFacts({ sessionExists: false }), {}),
    ...closePlan(closeFacts(), {}),
  ];
  const name = cloneAt(syntheticHangar(), 1).name;
  for (const action of all) {
    const line = describeCloseAction(action);
    assert.ok(line.length > 0, `${action.kind} renders nothing`);
    // Every line names its clone, because `--all` prints them interleaved and a bare
    // "nothing to close" in the middle of six of them says nothing at all.
    assert.ok(line.includes(name), `${action.kind} does not name its clone`);
  }
});

test('closing a window is a capability, and only the VS Code family claims it', () => {
  const others = [
    jetbrainsDriver('idea'),
    zedDriver(),
    emacsDriver(),
    vimDriver('mvim'),
    xcodeDriver(),
    eclipseDriver('eclipse'),
  ];
  for (const driver of others) {
    // Every other editor is best effort and has no window Hangar can name from outside: closing
    // one needs the clone's name in the window TITLE, which only the generated `*.code-workspace`
    // arranges. Declared false rather than left undefined, so adding a driver has to answer it.
    assert.equal(driver.capabilities.closeWindow, false, driver.kind);
    assert.equal(driver.closeWindow, undefined, driver.kind);
  }
  for (const fork of VSCODE_FORKS) {
    const driver = vscodeDriver(fork);
    // A driver that claims the capability must carry the method, and `close` filters on both --
    // a capability with no implementation behind it would report success and do nothing.
    assert.ok(driver.closeWindow !== undefined, fork);
    assert.equal(driver.capabilities.closeWindow, platform().capabilities.controlAppWindows, fork);
  }
});

test('a platform that cannot reach another app returns unsupported, and never throws', () => {
  const linux = linuxPlatform();
  assert.equal(linux.capabilities.controlAppWindows, false);
  // The refusal is a value rather than an exception, like `openExternally`'s false, so a caller
  // that forgot to check the capability gets something it can print.
  assert.deepEqual(linux.closeAppWindow('Code', 'clone_01'), { kind: 'unsupported' });
});
