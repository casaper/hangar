import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSyncCommand, scriptTail } from '../src/commands/jira.ts';
import { fixtureVscodeConfigText, syntheticHangar } from './fixture.ts';

/**
 * The `tracker.*` keys the Jira cache hook runs on, asserted to have been READ.
 *
 * This is the "input that is WRONG" half of the seed suite, and it is the one thing a golden
 * capture structurally cannot show here: `jira hook` writes no artifact, so nothing in
 * `gated/` would move however these four keys were resolved.
 *
 * All four used to be literals -- `JIRA_SYNC_NO_CACHE`, a 60-minute TTL and this repo's two
 * skill paths -- beside a schema that declared every one of them. The tell is that both
 * fixtures disagree with the schema DEFAULT and with each other, so no swallowed error and no
 * surviving literal can satisfy both: a hook still spelling `JIRA_SYNC_NO_CACHE` passes nothing
 * below, and neither does one defaulting `bypassEnvKey` to `HANGAR_TRACKER_NO_CACHE`.
 */

const vscodeHangar = (): ReturnType<typeof syntheticHangar> =>
  syntheticHangar({ configText: fixtureVscodeConfigText() });

test('the declared syncScript is what a command is recognised by, not this repo’s literal', () => {
  const tracker = vscodeHangar().config.tracker;
  const syncScript = tracker.syncScript;
  assert.ok(syncScript !== undefined, 'the vscode fixture declares one');

  const declared = { syncScript, bypassEnvKey: tracker.cache.bypassEnvKey };
  const parsed = parseSyncCommand(`node ${syncScript} UI-42 --no-assets`, declared);
  assert.ok(parsed !== undefined, 'the declared script is recognised');
  assert.deepEqual(parsed.keys, ['UI-42']);
  assert.equal(parsed.assets, false);
  assert.equal(parsed.relations, true);

  // The literal this hook carried before the key was honoured must no longer match anything.
  assert.equal(
    parseSyncCommand('node .claude/skills/jira-ticket-sync/sync.mjs UI-42', declared),
    undefined,
  );
});

test('a command naming the script from elsewhere still matches — the tail is what is compared', () => {
  const tracker = vscodeHangar().config.tracker;
  const syncScript = tracker.syncScript;
  assert.ok(syncScript !== undefined);
  const declared = { syncScript, bypassEnvKey: tracker.cache.bypassEnvKey };

  // Same script, named bare and named absolutely. Both are how an agent actually types it.
  assert.deepEqual(parseSyncCommand(`node ${scriptTail(syncScript)} PLAT-7`, declared)?.keys, [
    'PLAT-7',
  ]);
  assert.deepEqual(parseSyncCommand(`node /somewhere/${syncScript} PLAT-7`, declared)?.keys, [
    'PLAT-7',
  ]);
});

test('the declared bypassEnvKey is the escape hatch, and the old literal is not', () => {
  const tracker = vscodeHangar().config.tracker;
  const syncScript = tracker.syncScript;
  assert.ok(syncScript !== undefined);
  const declared = { syncScript, bypassEnvKey: tracker.cache.bypassEnvKey };
  assert.equal(tracker.cache.bypassEnvKey, 'VSFIX_NO_CACHE');

  assert.equal(parseSyncCommand(`VSFIX_NO_CACHE=1 node ${syncScript} UI-42`, declared), undefined);
  // The pre-config literal must NOT bypass any more: obeying a name the config does not declare
  // is how a hangar was told one variable by `config show` and honoured another.
  assert.deepEqual(
    parseSyncCommand(`JIRA_SYNC_NO_CACHE=1 node ${syncScript} UI-42`, declared)?.keys,
    ['UI-42'],
  );
});

test('both fixtures disagree with the schema default for the cache keys', () => {
  /*
   * The guard on the guard. If either fixture ever drifted onto the schema default
   * (`HANGAR_TRACKER_NO_CACHE`, 60) the tests above would keep passing while proving less, so
   * the disagreement is asserted rather than assumed.
   */
  const plain = syntheticHangar().config.tracker.cache;
  const vscode = vscodeHangar().config.tracker.cache;
  for (const cache of [plain, vscode]) {
    assert.notEqual(cache.bypassEnvKey, 'HANGAR_TRACKER_NO_CACHE');
    assert.notEqual(cache.ttlMinutes, 60);
  }
  assert.notEqual(plain.bypassEnvKey, vscode.bypassEnvKey);
  assert.notEqual(plain.ttlMinutes, vscode.ttlMinutes);
});

test('the script keys are OPTIONAL, and the fixture that omits them says so', () => {
  // The hook's fail-open path: no declared script is a decline, never a fallback to a literal.
  const tracker = syntheticHangar().config.tracker;
  assert.equal(tracker.syncScript, undefined);
  assert.equal(tracker.namerScript, undefined);
});
