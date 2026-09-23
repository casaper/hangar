import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseConfigText } from '../src/config/load.ts';
import { CliError } from '../src/exec.ts';
import { cloneAt } from '../src/fleet.ts';
import { portCollisions, portForRole, portsFor, portSummary, roleUrl } from '../src/ports.ts';
import { first, fixtureConfigText, syntheticHangar } from './fixture.ts';

/**
 * Ports, and the guard that keeps two of them from landing on each other.
 *
 * Two clones sharing a dev server means a test run in one silently verifies the other's code --
 * the worst thing a hangar can do -- so this is worth asserting twice over: the arithmetic, and
 * the schema cross-check that rejects a role table which would produce a collision.
 *
 * **The distance rule is in `superRefine`, not in `portsFor`.** `portsFor` is three lines of
 * arithmetic and cannot detect anything; what actually protects a fleet is `parseConfigText`
 * refusing to load the config in the first place. That refusal is what the presets depend on --
 * a preset shipping colliding bases would be a config nobody can load, discovered by whoever ran
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

test('an offset at or beyond the step is refused while the step is above 1', () => {
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

/** The layout this repo's own hangar moves to: clone N on base + N, one port apart. */
const STEP_ONE = `ports:
  step: 1
  offset: 1
  roles:
    - id: api
      envKey: FIXTURE_API_PORT
      base: 4200
      label: PostgREST
    - id: db
      envKey: FIXTURE_DB_PORT
      base: 6100
      label: PostgreSQL
    - id: swagger
      envKey: FIXTURE_SWAGGER_PORT
      base: 9400
      label: Swagger UI
`;

test('step 1 loads, and leaves every base itself to no clone', () => {
  /*
   * At step 1 every two bases are a whole number of steps apart, so congruence alone would
   * refuse every step-1 config there could be. What matters is whether they are CLOSE: 4200 and
   * 6100 are 1900 clones apart. And `offset: 1` is an offset at the step, which step 1 has to
   * allow -- it is what keeps a repo's default port (a server started without the clone's
   * environment) off clone 1.
   */
  const hangar = syntheticHangar({ configText: withPorts(STEP_ONE) });
  assert.deepEqual(
    portsFor(hangar, 1).map((entry) => entry.port),
    [4201, 6101, 9401],
  );
  assert.deepEqual(
    portsFor(hangar, 7).map((entry) => entry.port),
    [4207, 6107, 9407],
  );
});

test('two roles fewer steps apart than a fleet can hold are still refused at step 1', () => {
  assert.throws(
    () =>
      parseConfigText(
        withPorts(STEP_ONE.replace('base: 6100', 'base: 4250')),
        'two bases 50 clones apart',
      ),
    CliError,
  );
});

test('a pin wins for the roles it names, and the formula answers the rest', () => {
  const hangar = syntheticHangar();
  const pinned = portsFor(
    hangar,
    2,
    new Map([
      ['FIXTURE_API_PORT', 4300],
      ['FIXTURE_DB_PORT', 6106],
    ]),
  );
  // swagger is in no pin -- a role added after the snapshot -- so it takes clone 2's formula port.
  assert.deepEqual(
    pinned.map((entry) => entry.port),
    [4300, 6106, 8217],
  );
});

test('portCollisions finds a released clone landing on a pinned sibling', () => {
  /*
   * The case this repo's own rollout has: under the new layout clone 6's second role is 6106,
   * which is exactly what clone 2 still holds under the old one. Neither layout collides with
   * itself, so only a check over the clones that exist can see it.
   */
  const next = syntheticHangar({ configText: withPorts(STEP_ONE) });
  const clone2 = {
    name: 'two',
    ports: portsFor(next, 2, new Map([['FIXTURE_DB_PORT', 6106]])),
  };
  const clone6 = { name: 'six', ports: portsFor(next, 6) };
  const collisions = portCollisions([clone2, clone6]);
  assert.equal(collisions.length, 1);
  const collision = first(collisions, 'collision');
  assert.equal(collision.port, 6106);
  assert.deepEqual(
    collision.claims.map((claim) => claim.clone),
    ['two', 'six'],
  );
  assert.deepEqual(portCollisions([clone6, { name: 'one', ports: portsFor(next, 1) }]), []);
});
