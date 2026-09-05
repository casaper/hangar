import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pathsFor } from '../src/hangar.ts';
import { namesNoMachinePath, syntheticHangar } from './fixture.ts';

/**
 * `pathsFor` -- pure, frozen, and a pure function of its four arguments.
 *
 * This is the replacement for the five module constants that used to live in `paths.ts`, and the
 * failure it exists to prevent is worth restating: a value derived from a root that comes from a
 * FILE cannot be evaluated at import time. Five such constants embedded the root in text written
 * into a live clone, and a wrong absolute path there typechecks, lints, and is invisible until
 * somebody opens the file.
 */

test('every path is derived from the arguments and nothing else', () => {
  const paths = pathsFor('/somewhere/hangar', 'demo', '.env.secret', '/somewhere/claude');
  assert.equal(paths.root, '/somewhere/hangar');
  assert.equal(paths.configFile, '/somewhere/hangar/hangar.config.yaml');
  assert.equal(paths.bin, '/somewhere/hangar/bin/hangar');
  assert.equal(paths.plans, '/somewhere/hangar/plans');
  assert.equal(paths.tmp, '/somewhere/hangar/tmp');
  assert.equal(paths.jiraTickets, '/somewhere/hangar/tmp/jira-tickets');
  assert.equal(paths.envShared, '/somewhere/hangar/.env.secret');
  assert.equal(paths.colourAssignmentsFile, '/somewhere/hangar/.hangar/colour-assignments.json');
  assert.equal(paths.legacyColourAssignmentsFile, '/somewhere/hangar/colour-assignments.json');
});

test('what a hangar writes OUTSIDE its root carries its id; what it writes inside does not', () => {
  // The rule that settles every naming question in this CLI. `~/.claude` is the same directory
  // for every hangar on the machine, so a second hangar would otherwise overwrite the first's
  // statusline and read the first's memory as notes about its own repo.
  const paths = pathsFor('/somewhere/hangar', 'demo', '.env.secret', '/somewhere/claude');
  assert.equal(paths.statuslineScript, '/somewhere/claude/demo-clone-statusline.sh');
  assert.equal(paths.memory, '/somewhere/claude/demo-memory');
  // Inside the root: no id anywhere in the path segment names.
  for (const inside of [paths.plans, paths.tmp, paths.cloneColoursScript, paths.terminalHookScript])
    assert.ok(!inside.slice('/somewhere/hangar'.length).includes('demo'), inside);
});

test('the record is frozen, so nothing can mutate a path after resolution', () => {
  const paths = pathsFor('/somewhere/hangar', 'demo', '.env.secret', '/somewhere/claude');
  assert.ok(Object.isFrozen(paths));
  // ESM is always strict mode, so an assignment to a frozen property throws rather than
  // silently no-opping. Both halves are asserted: the throw, and that the value survived.
  assert.throws(() => {
    (paths as { root: string }).root = '/hijacked';
  }, TypeError);
  assert.equal(paths.root, '/somewhere/hangar');
});

test('calling it twice with the same arguments gives equal, independent records', () => {
  const a = pathsFor('/r', 'id', '.env', '/c');
  const b = pathsFor('/r', 'id', '.env', '/c');
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'a cached singleton would break rendering two hangars at once');
});

test('the synthetic fixture names no path on this machine', () => {
  // The standing guard for the whole suite: if a builder ever reaches `homedir()` or the real
  // hangar root through a path that was not threaded, this is where it shows up -- here rather
  // than on a colleague's clone, where every expected string would be wrong at once.
  const hangar = syntheticHangar();
  for (const path of Object.values(hangar.paths)) {
    assert.ok(namesNoMachinePath(path), `${path} names a machine path`);
  }
});
