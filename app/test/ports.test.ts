import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseConfigText } from '../src/config/load.ts';
import { CliError } from '../src/exec.ts';
import { cloneAt } from '../src/fleet.ts';
import { portForRole, portsFor, portSummary, roleUrl } from '../src/ports.ts';
import { fixtureConfigText, syntheticHangar } from './fixture.ts';

/**
 * Ports, and the guard that keeps two of them from landing on each other.
 *
 * Two clones sharing a dev server means a test run in one silently verifies the other's code --
 * the worst thing a hangar can do -- so this is worth asserting twice over: the arithmetic, and
 * the schema cross-check that rejects a role table which would produce a collision.
 *
 * **The congruence rule is in `superRefine`, not in `portsFor`.** `portsFor` is three lines of
 * arithmetic and cannot detect anything; what actually protects a fleet is `parseConfigText`
 * refusing to load the config in the first place. That refusal is what the presets depend on --
 * a preset shipping congruent bases would be a config nobody can load, discovered by whoever ran
 * `hangar setup` rather than by whoever wrote it.
 */

const withPorts = (yaml: string): string =>
  fixtureConfigText().replace(/\nports:\n[\s\S]*?\n\nterminal:/, `\n${yaml}\nterminal:`);

test('a port is base + offset + (index - 1) * step', () => {
  const hangar = syntheticHangar();
  // The fixture's offset is 37 and its step 100, chosen so a formula that drops the offset is
  // visible rather than accidentally right -- which it would be at this hangar's `offset: 0`.
  assert.deepEqual(
    portsFor(hangar, 1).map((entry) => [entry.role.id, entry.port]),
    [
      ['api', 3037],
      ['db', 5469],
      ['swagger', 8117],
    ],
  );
  assert.deepEqual(
    portsFor(hangar, 3).map((entry) => entry.port),
    [3237, 5669, 8317],
  );
});

test('roles keep the order the config writes them in', () => {
  const hangar = syntheticHangar();
  assert.deepEqual(
    portsFor(hangar, 1).map((entry) => entry.role.id),
    ['api', 'db', 'swagger'],
  );
  assert.equal(portSummary(portsFor(hangar, 2)), 'api 3137 · db 5569 · swagger 8217');
});

test('portForRole answers undefined for a role this hangar does not declare', () => {
  // Not an exception and not zero: a hangar whose repo serves nothing on `storybook` is a normal
  // hangar, and every caller has to decide what to print for it.
  const ports = portsFor(syntheticHangar(), 1);
  assert.equal(portForRole(ports, 'api'), 3037);
  assert.equal(portForRole(ports, 'storybook'), undefined);
});

test('roleUrl renders {port}, and is undefined for a role that has no URL', () => {
  const ports = portsFor(syntheticHangar(), 2);
  const api = ports.find((entry) => entry.role.id === 'api');
  const db = ports.find((entry) => entry.role.id === 'db');
  assert.ok(api !== undefined && db !== undefined);
  assert.equal(roleUrl(api), 'http://localhost:3137');
  // A database port answers no HTTP request, so a URL for it would be a link to nothing --
  // which is what the fixture published until this test was written: `url:` OMITTED takes the
  // schema default, and only an explicit `url: null` means "this role has none".
  assert.equal(roleUrl(db), undefined);
});

test('a clone carries the ports of its own index and no other', () => {
  const hangar = syntheticHangar();
  assert.deepEqual(
    cloneAt(hangar, 4).ports.map((entry) => entry.port),
    [3337, 5769, 8417],
  );
});

test('the fixture loads: 3000 / 5432 / 8080 are in distinct classes mod 100', () => {
  assert.doesNotThrow(() => parseConfigText(fixtureConfigText(), 'the fixture'));
});

test('two roles congruent mod step are REFUSED at load, not at render', () => {
  /*
   * `api: 3000` beside `admin: 3100` at step 100 puts clone 2's api on clone 1's admin. It is
   * statically checkable and completely silent at runtime -- a dev server answering on another
   * role's port verifies the wrong code and reports success.
   */
  const colliding = withPorts(`ports:
  step: 100
  offset: 37
  roles:
    - id: api
      envKey: FIXTURE_API_PORT
      base: 3000
      label: PostgREST
    - id: admin
      envKey: FIXTURE_ADMIN_PORT
      base: 3100
      label: Admin
`);
  assert.throws(
    () => parseConfigText(colliding, 'a colliding fixture'),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      // The message has to name both roles: "some ports collide" is not actionable.
      const said = `${error.message} ${error.hint ?? ''}`;
      assert.match(said, /api/);
      assert.match(said, /admin/);
      return true;
    },
  );
});

test('an offset at or beyond the step is refused', () => {
  // `0 <= offset < step` is what makes the offset a residue class at all. An offset of exactly
  // the step is another hangar's class shifted by one clone, which collides on every index.
  assert.throws(
    () =>
      parseConfigText(
        withPorts(`ports:
  step: 100
  offset: 100
  roles:
    - id: api
      envKey: FIXTURE_API_PORT
      base: 3000
      label: PostgREST
`),
        'an out-of-range offset',
      ),
    CliError,
  );
});

test('a hangar may declare NO port roles at all', () => {
  // The likely answer for a repo that runs no server, and it must be a config that loads rather
  // than one the schema treats as unfinished.
  const none = parseConfigText(
    withPorts(`ports:
  step: 100
  offset: 37
  roles: []
`),
    'a hangar with no ports',
  );
  assert.deepEqual(none.ports.roles, []);
  assert.deepEqual(portsFor({ ...syntheticHangar(), config: none }, 1), []);
});
