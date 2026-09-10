import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defaultSettings,
  hasAnyJiraHook,
  hasExecGuardHook,
  hasJiraHook,
  jiraHookCommand,
  withJiraHook,
  type HookMatcher,
  type SettingsJson,
} from '../src/clone-config.ts';
import { parseSyncCommand, scriptTail } from '../src/commands/jira.ts';
import { issueRow } from '../src/commands/status.ts';
import { cloneAt } from '../src/fleet.ts';
import { fixtureConfigText, fixtureVscodeConfigText, syntheticHangar } from './fixture.ts';

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

/**
 * The DISABLED tracker, which is the schema's default and which nothing used to honour.
 *
 * `tracker.kind` has defaulted to `none` for a long time and every consumer that reads tracker
 * DATA branched on it -- `issueUrl`, `jiraHook`'s decline, `tmp merge`'s store pass, `status`'s
 * row, the two `CLAUDE.local.md` builders. The per-clone `PreToolUse` hook did not: it read no
 * config at all, so a hangar with no tracker got the hook in every clone, `doctor` went red
 * demanding it, and `--fix` installed a process that runs on every Bash tool call and serves
 * nothing.
 *
 * **This lives in the suite rather than in a capture because neither fixture can carry it.**
 * `fixture.config.yaml` cannot flip: the tests above assert its cache keys disagree with the
 * vscode fixture's and with the schema defaults, which a `kind: none` block has no reason to
 * hold. `fixture-vscode.config.yaml` cannot either -- it is the sole carrier of `syncScript`,
 * `namerScript` and six other enumerated things. So the disabled settings shape gets no
 * byte-level golden pin, and these properties are what stands in for one.
 */

/** The fixture with its tracker switched off explicitly. */
const disabledHangar = (): ReturnType<typeof syntheticHangar> =>
  syntheticHangar({ configText: fixtureConfigText().replace('kind: jira', 'kind: none') });

/**
 * The fixture with no `tracker:` block at all -- a different claim from the one above.
 *
 * `trackerSchema.prefault({})` is what makes an omitted block mean `kind: none`, and that is the
 * half a reader assumes rather than checks. The replace is anchored on the following `repo:` key
 * and asserted to have bitten: a regex that quietly matched nothing would leave `kind: jira` in
 * place and send the next person debugging the wrong assertion.
 */
const noTrackerHangar = (): ReturnType<typeof syntheticHangar> => {
  const text = fixtureConfigText().replace(/\ntracker:\n[\s\S]*?\n\nrepo:/, '\nrepo:');
  assert.ok(!text.includes('tracker:'), 'the tracker block was not removed from the fixture');
  return syntheticHangar({ configText: text });
};

const preToolUse = (settings: SettingsJson): HookMatcher[] | undefined =>
  settings.hooks?.['PreToolUse'];

const jiraMatchers = (settings: SettingsJson): HookMatcher[] =>
  (preToolUse(settings) ?? []).filter((matcher) =>
    matcher.hooks.some((hook) => hook.command.includes('jira hook')),
  );

test('a hangar with no tracker declares kind none, whether it says so or omits the block', () => {
  // Guard on the guard, and the premise of every assertion below: if a fixture edit ever put a
  // tracker back, these tests must fail here rather than pass while proving nothing.
  assert.equal(disabledHangar().config.tracker.kind, 'none');
  assert.equal(noTrackerHangar().config.tracker.kind, 'none');
  assert.equal(syntheticHangar().config.tracker.kind, 'jira', 'the plain fixture IS enabled');
});

test('a clone of a tracker-less hangar is built with no jira hook and no empty key', () => {
  for (const hangar of [disabledHangar(), noTrackerHangar()]) {
    const settings = defaultSettings(cloneAt(hangar, 1));
    assert.deepEqual(jiraMatchers(settings), [], 'a hook was wired for a hangar with no tracker');
    // `PreToolUse` still exists, and holds the exec guard alone. That guard is unconditional --
    // it protects a rule about every hangar rather than a feature of this one -- so the old
    // assertion here (no key at all) would now pass only by deleting it. What must still be
    // true is that no EMPTY matcher is left behind, which is what the length check holds.
    assert.equal(preToolUse(settings)?.length, 1);
    assert.ok(hasExecGuardHook(hangar, settings));
  }
});

test('the enabled fixture still gets exactly one jira hook', () => {
  // The other direction, and the reason it is asserted: a gate that stripped unconditionally
  // would satisfy every test above and disable the cache in the one hangar that wants it.
  const settings = defaultSettings(cloneAt(syntheticHangar(), 1));
  assert.equal(jiraMatchers(settings).length, 1);
  assert.equal(
    jiraMatchers(settings)[0]?.hooks[0]?.command,
    jiraHookCommand(syntheticHangar()),
    'the wired command is the one this hangar would write today',
  );
});

test('switching a tracker off REMOVES the hook the clone already carries', () => {
  /*
   * The jira -> none transition, which is the whole reason `withJiraHook` filters before it
   * appends rather than gating at the call sites. Without the removal a hangar that switches its
   * tracker off keeps the hook in every clone forever: inert, since `jiraHook` declines, but a
   * Node process spawned on every Bash tool call for a feature nobody asked for any more.
   */
  const enabled = syntheticHangar();
  const wired = defaultSettings(cloneAt(enabled, 1));
  assert.equal(jiraMatchers(wired).length, 1, 'the premise: it starts out wired');

  const off = disabledHangar();
  assert.deepEqual(jiraMatchers(withJiraHook(off, wired)), []);
  // The exec guard is not the tracker's and must survive the tracker being switched off.
  assert.equal(preToolUse(withJiraHook(off, wired))?.length, 1);
  assert.ok(hasExecGuardHook(enabled, withJiraHook(off, wired)));
});

test('removal matches an OLD hook form, which exact equality would miss', () => {
  /*
   * `hasJiraHook` is exact equality and `withJiraHook` strips by `invokesOurCli`, which also
   * matches a command with no `--hangar` -- the form wired before the root was baked in, and
   * the form a hangar-root move leaves behind. Reporting on one and repairing by the other is
   * how `doctor` would call a hook "correctly absent" and then delete it in the same run.
   */
  const off = disabledHangar();
  const stale: SettingsJson = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `${off.paths.bin} jira hook` }] },
      ],
    },
  };
  assert.equal(hasJiraHook(off, stale), false, 'the premise: exact equality does not see it');
  assert.equal(hasAnyJiraHook(off, stale), true, 'the weaker predicate does');
  assert.equal(preToolUse(withJiraHook(off, stale)), undefined, 'and it is what gets removed');
});

test('a hook belonging to ANOTHER tool is left alone', () => {
  // The filter is scoped to our own CLI, so switching a tracker off must not touch a repo's own
  // `PreToolUse` guard sitting in the same array.
  const off = disabledHangar();
  const foreign: HookMatcher = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'node ./scripts/guard.mjs' }],
  };
  const result = withJiraHook(off, { hooks: { PreToolUse: [foreign] } });
  assert.deepEqual(result.hooks?.['PreToolUse'], [foreign]);
});

/**
 * `status`'s issue row, whose three silences used to collapse into one wrong answer.
 *
 * The builder's own header claimed it distinguished "no key in this branch" from "this hangar
 * has no tracker", and the ordering defeated it: the no-key arm returned before anything read
 * the config. So a tracker-less clone was told its BRANCH was named wrong -- advice about a
 * convention that hangar never adopted -- and a branch that happened to carry a key-shaped
 * token was told `tracker.baseUrl` was missing instead. One cause, two wrong answers, neither
 * actionable.
 *
 * Asserted WITHOUT stripping ANSI, and that is a property of what is asserted rather than an
 * assumption about the tty `picocolors` looks for: an escape sequence is `[`, digits, `;` and
 * `m`, so it can never contain one of the words matched below, and the one exact comparison is
 * on the arm that does not call `picocolors` at all. `NO_COLOR` is how `dev/golden.sh`
 * neutralises colour where it genuinely must; a test that needed it here would be pinning bytes
 * it has no business pinning.
 */

test('a tracker-less clone is told there is no tracker, not that its branch is misnamed', () => {
  for (const hangar of [disabledHangar(), noTrackerHangar()]) {
    const said = issueRow(cloneAt(hangar, 1), undefined);
    assert.match(said, /no tracker/);
    assert.doesNotMatch(said, /branch/, 'a hangar with no tracker was blamed for its branch name');
  }
});

test('and it is told that even when a key WAS inferred from the branch', () => {
  /*
   * The arm that used to blame a missing `tracker.baseUrl`. `inferTicket` reads any key-shaped
   * token, so a tracker-less hangar whose branch is `BE-7-something` reached it -- naming the
   * one config key that is NOT the reason, since `kind: none` is.
   */
  const said = issueRow(cloneAt(disabledHangar(), 1), { key: 'BE-7', source: 'branch' });
  assert.match(said, /no tracker/);
  assert.doesNotMatch(said, /baseUrl/, 'blamed baseUrl for what tracker.kind decides');
});

test('an enabled hangar still links the key, and still reports a branch with none', () => {
  // Guard on the guard: a gate answering "no tracker" unconditionally would satisfy both tests
  // above and silence the row in the one hangar that wants it.
  const clone = cloneAt(syntheticHangar(), 1);
  assert.equal(
    issueRow(clone, { key: 'BE-7', source: 'branch' }),
    'https://example.invalid/browse/BE-7',
  );
  assert.match(issueRow(clone, undefined), /none inferred/);
});
