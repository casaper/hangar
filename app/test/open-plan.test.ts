import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloneAt } from '../src/fleet.ts';
import {
  describeAction,
  openPlan,
  tabsFor,
  type OpenAction,
  type OpenFacts,
} from '../src/commands/open.ts';
import type { EmulatorCapabilities } from '../src/terminal/index.ts';
import { tmuxSessionName } from '../src/tmux.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * What `hangar open` decides, given what it found.
 *
 * The whole decision is a pure function precisely so that these cases can be asserted without a
 * tmux server, an emulator, or a clone -- and the first one below is the reason it was worth
 * extracting at all. `open` runs against clones that may already hold a live Claude Code session,
 * so "a clone that is fully open receives no writes" is not a nicety: a stray `new-window` in a
 * session somebody is working in is the failure this command exists to prevent, and nothing in
 * `dev/golden` can see it, because golden captures no `open` output at all.
 *
 * Properties, never expected text. `describeAction` is checked for shape rather than wording, so
 * the prose stays editable.
 */

const hangar = syntheticHangar();
const clone = cloneAt(hangar, 1);

const ALL: EmulatorCapabilities = { openTab: true, openWindow: true, raiseByTty: true };
const NO_RAISE: EmulatorCapabilities = { openTab: true, openWindow: true, raiseByTty: false };
const NO_TAB: EmulatorCapabilities = { openTab: false, openWindow: true, raiseByTty: true };
const NONE: EmulatorCapabilities = { openTab: false, openWindow: false, raiseByTty: false };

const roles = tabsFor(hangar, clone, {}, []);

const facts = (over: Partial<OpenFacts> = {}): OpenFacts => ({
  clone,
  roles,
  sessionExists: false,
  existingRoles: [],
  clientTtys: [],
  currentSession: undefined,
  placement: 'tab',
  emulator: ALL,
  ...over,
});

const kinds = (plan: readonly OpenAction[]): string[] => plan.map((a) => a.kind);
const WRITES = ['create-session', 'create-window'];

test('a clone that is not open gets a session, its remaining roles, and a window', () => {
  const plan = openPlan(hangar, facts());
  assert.equal(
    plan[0]?.kind,
    'create-session',
    'the session has to exist before anything is added',
  );
  assert.equal(kinds(plan).filter((k) => k === 'create-session').length, 1);
  assert.equal(kinds(plan).filter((k) => k === 'create-window').length, roles.length - 1);
  assert.equal(plan.at(-1)?.kind, 'open-emulator');
});

test('a clone that is fully open with somebody attached is raised, and NOTHING is written', () => {
  const plan = openPlan(
    hangar,
    facts({
      sessionExists: true,
      existingRoles: roles.map((r) => r.role),
      clientTtys: ['/dev/ttys004'],
    }),
  );
  // The property that protects a live agent: no `new-window`, no `new-session`, one raise.
  assert.deepEqual(kinds(plan), ['raise']);
  for (const write of WRITES)
    assert.ok(!kinds(plan).includes(write), `${write} reached a live session`);
});

test('a session missing one role gets exactly that role, and no duplicate', () => {
  const missing = roles[roles.length - 1];
  assert.ok(missing !== undefined);
  const plan = openPlan(
    hangar,
    facts({
      sessionExists: true,
      existingRoles: roles.slice(0, -1).map((r) => r.role),
      clientTtys: ['/dev/ttys004'],
    }),
  );
  const created = plan.flatMap((a) => (a.kind === 'create-window' ? [a.tab.role] : []));
  // This is how a new `terminal.tabs[]` entry reaches a clone that is already open.
  assert.deepEqual(created, [missing.role]);
  assert.ok(!kinds(plan).includes('create-session'), 'the session is already there');
});

test('a session with no client is reattached rather than duplicated', () => {
  const plan = openPlan(
    hangar,
    facts({ sessionExists: true, existingRoles: roles.map((r) => r.role), clientTtys: [] }),
  );
  // The window comes back with whatever was running in it -- the case a per-window model cannot
  // have at all, because there the window WAS the session.
  assert.deepEqual(kinds(plan), ['open-emulator']);
});

test('no plan ever both raises and opens', () => {
  for (const over of [
    {},
    { sessionExists: true, clientTtys: ['/dev/ttys004'] },
    { sessionExists: true, clientTtys: [] },
    { sessionExists: true, existingRoles: roles.map((r) => r.role), clientTtys: ['/dev/ttys004'] },
  ]) {
    const k = kinds(openPlan(hangar, facts(over)));
    assert.ok(
      !(k.includes('raise') && k.includes('open-emulator')),
      `a clone got brought forward AND opened: ${k.join(', ')}`,
    );
  }
});

test('being inside the clone’s own session opens nothing at all', () => {
  const plan = openPlan(
    hangar,
    facts({
      sessionExists: true,
      existingRoles: roles.map((r) => r.role),
      clientTtys: ['/dev/ttys004'],
      currentSession: tmuxSessionName(clone),
    }),
  );
  assert.deepEqual(kinds(plan), ['already-here']);
});

test('being inside ANOTHER clone’s session is the ordinary path', () => {
  const other = tmuxSessionName(cloneAt(hangar, 2));
  const plan = openPlan(hangar, facts({ currentSession: other }));
  // Never a `switch-client`: that would put two clones through one tab, which is the one thing
  // one-session-per-clone exists to prevent.
  assert.ok(kinds(plan).includes('open-emulator'));
  assert.ok(!kinds(plan).includes('already-here'));
});

test('an emulator that cannot raise says so and names the way back in', () => {
  const plan = openPlan(
    hangar,
    facts({
      sessionExists: true,
      existingRoles: roles.map((r) => r.role),
      clientTtys: ['/dev/ttys004'],
      emulator: NO_RAISE,
    }),
  );
  const [action] = plan;
  assert.ok(action?.kind === 'cannot-raise', `expected cannot-raise, got ${String(action?.kind)}`);
  // Silence would be the wrong degradation: the clone IS open, and the developer needs the tty
  // and the attach line rather than a command that appeared to do nothing.
  assert.ok(action.hint.includes('attach'));
});

test('a tab that cannot be delivered becomes a window rather than a refusal', () => {
  const plan = openPlan(hangar, facts({ placement: 'tab', emulator: NO_TAB }));
  const opened = plan.find((a) => a.kind === 'open-emulator');
  assert.ok(opened?.kind === 'open-emulator' && opened.placement === 'window');
});

test('`terminal.kind: none` still builds the session and hands over the attach line', () => {
  const plan = openPlan(hangar, facts({ emulator: NONE }));
  // The branch NOTHING else exercises: golden captures no `open` output, so this is the only
  // place a `none` hangar's behaviour is checked at all.
  assert.ok(kinds(plan).includes('create-session'));
  assert.ok(!kinds(plan).includes('open-emulator'), 'there is no emulator to open anything in');
  const hints = plan.filter((a) => a.kind === 'attach-hint');
  assert.equal(hints.length, 1);
  assert.ok(hints[0]?.kind === 'attach-hint' && hints[0].hint.includes('-L'));
});

test('every action renders, in both tenses, and names its clone', () => {
  const seen = new Set<string>();
  for (const over of [
    {},
    { emulator: NONE },
    { sessionExists: true, clientTtys: ['/dev/ttys004'], existingRoles: roles.map((r) => r.role) },
    {
      sessionExists: true,
      clientTtys: ['/dev/ttys004'],
      existingRoles: roles.map((r) => r.role),
      emulator: NO_RAISE,
    },
    {
      sessionExists: true,
      clientTtys: ['/dev/ttys004'],
      existingRoles: roles.map((r) => r.role),
      currentSession: tmuxSessionName(clone),
    },
  ]) {
    for (const action of openPlan(hangar, facts(over))) {
      seen.add(action.kind);
      for (const done of [true, false]) {
        const line = describeAction(action, done);
        assert.ok(line.length > 0, `${action.kind} rendered nothing`);
        assert.ok(line.includes(clone.name), `${action.kind} does not name the clone: ${line}`);
      }
      // A dry run must read as conditional and a real run as done, or `-n` looks like it acted --
      // but only for the actions that DO something. `already-here`, `cannot-raise` and
      // `attach-hint` are observations about the state `open` found, and there is no past tense
      // of a fact: rewording them per tense would invent a step that never happened.
      const OBSERVATIONS = ['already-here', 'cannot-raise', 'attach-hint'];
      if (OBSERVATIONS.includes(action.kind)) {
        assert.equal(describeAction(action, true), describeAction(action, false));
      } else {
        assert.notEqual(describeAction(action, true), describeAction(action, false));
      }
    }
  }
  // Every variant of the union above is reachable from the cases in this file.
  assert.deepEqual([...seen].sort(), [
    'already-here',
    'attach-hint',
    'cannot-raise',
    'create-session',
    'create-window',
    'open-emulator',
    'raise',
  ]);
});

test('the roles come from the config, in order, and resolve under the clone', () => {
  assert.equal(roles.length, hangar.config.terminal.tabs.length);
  assert.deepEqual(
    roles.map((r) => r.role),
    hangar.config.terminal.tabs.map((t) => t.role),
  );
  for (const role of roles) assert.ok(role.cwd.startsWith(clone.path));
});

test('--no-claude keeps every window and drops every command', () => {
  const quiet = tabsFor(hangar, clone, { claude: false }, []);
  assert.equal(quiet.length, roles.length, 'a window with no command is a shell, not an absence');
  for (const role of quiet) assert.equal(role.command, undefined);
});
