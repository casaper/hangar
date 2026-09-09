import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeReloadAction,
  isIdleShell,
  reloadPlan,
  SHELL_COMMANDS,
  type ReloadFacts,
} from '../src/commands/reload.ts';
import { cloneAt } from '../src/fleet.ts';
import type { TmuxPane } from '../src/tmux.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * `reload`, through its pure planner.
 *
 * Same shape as `close`'s, and for the same reason: it restarts processes somebody is working in,
 * so `-n` has to render exactly what the real run performs. What is asserted here is which pane
 * gets which treatment -- the decision that keeps a dev server alive and brings one conversation
 * back.
 */

const pane = (over: Partial<TmuxPane> = {}): TmuxPane => ({
  id: '%1',
  windowId: '@1',
  role: 'shell',
  command: 'zsh',
  path: '/tmp/x',
  ...over,
});

const reloadFacts = (over: Partial<ReloadFacts> = {}): ReloadFacts => {
  const hangar = syntheticHangar();
  return {
    clone: cloneAt(hangar, 1),
    sessionExists: true,
    panes: [pane()],
    liveSessionId: undefined,
    claudeCommand: 'claude',
    staleWorkspaces: [],
    ownPane: undefined,
    ...over,
  };
};

test('reload restarts Claude Code by its ROLE, not by what happens to be running in it', () => {
  const claudePane = pane({ id: '%9', role: 'claude', command: 'zsh' });
  const actions = reloadPlan(reloadFacts({ panes: [claudePane], liveSessionId: 'abc123' }), {});
  // A session that has been exited leaves a shell in that pane, and the pane is still the one
  // Claude Code belongs in -- so matching on `pane_current_command` would respawn a bare shell
  // there and quietly drop the resume.
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['source-conf', 'resume-claude'],
  );
  const resume = actions.find((a) => a.kind === 'resume-claude');
  assert.equal(resume?.kind === 'resume-claude' ? resume.session : '', 'abc123');
});

test('reload restarts Claude Code without a resume when no live session was found', () => {
  const claudePane = pane({ role: 'claude', command: 'node' });
  assert.deepEqual(
    reloadPlan(reloadFacts({ panes: [claudePane] }), {}).map((a) => a.kind),
    ['source-conf', 'restart-claude'],
  );
});

test('reload leaves a pane running anything but a shell alone, and names it', () => {
  const panes = [pane({ id: '%1', command: 'zsh' }), pane({ id: '%2', command: 'ng' })];
  const actions = reloadPlan(reloadFacts({ panes, claudeCommand: undefined }), {});
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['source-conf', 'respawn-shell', 'skip-pane'],
  );
  const skipped = actions.find((a) => a.kind === 'skip-pane');
  // The command is carried into the action rather than looked up again when it is printed: the
  // whole value of skipping is being told WHAT was spared.
  assert.equal(skipped?.kind === 'skip-pane' ? skipped.command : '', 'ng');
});

test('the shell list is an ALLOW-list, so an unrecognised command is never killed', () => {
  for (const command of SHELL_COMMANDS) assert.ok(isIdleShell(pane({ command })));
  // The question is "is it safe to kill what is in this pane", and the honest answer for
  // something unrecognised is no. A deny-list would have to name every dev server and test
  // runner anyone might run, and the first one it forgot would die without a word.
  for (const command of ['ng', 'node', 'vim', 'jest', 'less', 'claude', ''])
    assert.ok(!isIdleShell(pane({ command })), `${command} must not count as an idle shell`);
});

test('reload never respawns the pane it is running in', () => {
  const panes = [pane({ id: '%1', role: 'claude' }), pane({ id: '%2', role: 'shell' })];
  const actions = reloadPlan(reloadFacts({ panes, liveSessionId: 'zz', ownPane: '%1' }), {});
  // Respawning it would kill the command half way through its own run -- and for an agent
  // driving `hangar` from inside a clone, that is the agent killing itself. Skipped and named
  // rather than refusing the clone: the conf and every other pane still reload.
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['source-conf', 'skip-self', 'respawn-shell'],
  );
  assert.match(describeReloadAction(actions[1] as never), /running in it/);
});

test('reload does nothing to a clone that is not open, and says so', () => {
  assert.deepEqual(
    reloadPlan(reloadFacts({ sessionExists: false, panes: [] }), {}).map((a) => a.kind),
    ['not-open'],
  );
});

test('reload REPORTS a stale workspace file and never writes one', () => {
  const actions = reloadPlan(
    reloadFacts({ sessionExists: false, panes: [], staleWorkspaces: ['/x/a.code-workspace'] }),
    {},
  );
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['workspace-stale', 'not-open'],
  );
  // Named because the fix belongs to another command: the per-clone artifacts have one writer,
  // `add-clone` and `doctor --fix`, and a second one is how two builders drift apart.
  assert.match(describeReloadAction(actions[0] as never), /doctor --fix/);
});

test('--no-claude and --no-shells each drop exactly their own half', () => {
  const panes = [pane({ id: '%1', role: 'claude' }), pane({ id: '%2', role: 'shell' })];
  const facts = reloadFacts({ panes, liveSessionId: 'zz' });
  assert.deepEqual(
    reloadPlan(facts, { claude: false }).map((a) => a.kind),
    ['source-conf', 'respawn-shell'],
  );
  assert.deepEqual(
    reloadPlan(facts, { shells: false }).map((a) => a.kind),
    ['source-conf', 'resume-claude'],
  );
  // The conf is re-read either way: it is the half that needs no process killed at all.
  assert.deepEqual(
    reloadPlan(facts, { claude: false, shells: false }).map((a) => a.kind),
    ['source-conf'],
  );
});
