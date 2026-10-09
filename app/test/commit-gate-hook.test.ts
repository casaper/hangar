import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  commitGateHookCommand,
  defaultSettings,
  hasCommitGateCommand,
  hasCommitGateHook,
  withCommitGateHook,
  type SettingsJson,
} from '../src/clone-config.ts';
import { cloneAt } from '../src/fleet.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * The commit gate's two timeouts, and the clone that was wired before they split.
 *
 * A capture pins what a NEW clone's settings say. It cannot show that a clone carrying the old
 * SessionStart timeout is reported -- `hasCommitGateHook` matched on the command alone, so every
 * clone wired before the split would have passed `doctor` and kept the timeout that got its
 * banner cancelled.
 */

const gateTimeouts = (settings: SettingsJson, event: string): (number | undefined)[] =>
  (settings.hooks?.[event] ?? []).flatMap((matcher) =>
    matcher.hooks
      .filter((hook) => hook.command.endsWith('hangar-commit-gate'))
      .map((hook) => hook.timeout),
  );

/** The settings a clone carried before the split: the same gate, 10s on BOTH events. */
const wiredBeforeTheSplit = (): SettingsJson => {
  const hangar = syntheticHangar();
  const settings = defaultSettings(cloneAt(hangar, 1));
  const hooks = { ...settings.hooks };
  hooks['SessionStart'] = (hooks['SessionStart'] ?? []).map((matcher) => ({
    ...matcher,
    hooks: matcher.hooks.map((hook) =>
      hook.command === commitGateHookCommand(hangar) ? { ...hook, timeout: 10 } : hook,
    ),
  }));
  return { ...settings, hooks };
};

test('a new clone gets a long SessionStart timeout and a short PreToolUse one', () => {
  const settings = defaultSettings(cloneAt(syntheticHangar(), 1));
  const start = gateTimeouts(settings, 'SessionStart');
  const tool = gateTimeouts(settings, 'PreToolUse');
  assert.equal(start.length, 1);
  assert.equal(tool.length, 1);
  assert.ok((start[0] ?? 0) > (tool[0] ?? 0), 'SessionStart must outlast a busy session start');
  assert.ok(hasCommitGateHook(syntheticHangar(), settings));
});

test('a clone wired before the split is reported, not passed on its command alone', () => {
  assert.equal(hasCommitGateHook(syntheticHangar(), wiredBeforeTheSplit()), false);
});

test('reconciling it leaves one gate per event, at today’s timeouts', () => {
  const hangar = syntheticHangar();
  const repaired = withCommitGateHook(hangar, wiredBeforeTheSplit());
  assert.ok(hasCommitGateHook(hangar, repaired));
  assert.deepEqual(
    gateTimeouts(repaired, 'SessionStart'),
    gateTimeouts(defaultSettings(cloneAt(hangar, 1)), 'SessionStart'),
  );
  assert.equal(gateTimeouts(repaired, 'PreToolUse').length, 1, 'a repair must not duplicate');
});

test('the stale clone is still WIRED, which is what keeps doctor from calling it unhonoured', () => {
  assert.ok(hasCommitGateCommand(syntheticHangar(), wiredBeforeTheSplit()));
  assert.equal(hasCommitGateCommand(syntheticHangar(), {}), false);
});
