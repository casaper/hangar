import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  expectedSecretVariables,
  hangarOwnSecretVariables,
  secretVariableProblem,
  secretVariableStatuses,
} from '../src/secrets.ts';
import type { SecretVariable } from '../src/config/schema.ts';
import { first } from './fixture.ts';

/**
 * `secrets.variables[]` -- the declaration, and the three states a declared name can be in.
 *
 * This belongs here rather than in the golden net for the reason the suite exists: no ARTIFACT
 * renders a secret variable, so a capture has nothing to show. What has to be true is a
 * property -- that a scaffold nobody filled in is reported as unset, and that `set but empty` is
 * never folded in with `absent` -- and properties are what this suite asserts.
 *
 * The bug it pins: this fleet's Playwright suite reads `USER_READWRITE_PASSWORD`, the tracked
 * `tests/.env` sets it empty, and direnv loads that AFTER the shared secrets. A symlink undoes
 * that, and its `why` says so -- but nothing declared the variable, so a new hangar came up with
 * the symlink created, `doctor` green, and Playwright logging in with an empty password.
 */

const decl = (name: string, optional = false): SecretVariable => ({
  name,
  why: `${name} is needed`,
  optional,
});

test('a variable with a value is set; the value never leaves the module', () => {
  const s = first(secretVariableStatuses([decl('TOKEN')], 'TOKEN=abc123\n'), 'status');
  assert.equal(s.state, 'set');
  assert.equal(secretVariableProblem(s), undefined);
  // The whole status object, serialised, must not contain the credential.
  assert.ok(!JSON.stringify(s).includes('abc123'));
});

test('the COMMENTED form `setup` writes is not a value', () => {
  // This is the exact shape of a fresh scaffold. Reading `# TOKEN=` as an assignment would
  // report every untouched secrets file as fully configured, which is the one answer that
  // must not happen -- it is indistinguishable from a correctly filled-in one.
  const s = first(secretVariableStatuses([decl('TOKEN')], '#\n# TOKEN=\n'), 'status');
  assert.equal(s.state, 'absent');
});

test('set-but-EMPTY is its own state, never folded in with absent', () => {
  // The distinction is the reason the scaffold is commented out at all: an empty value reads as
  // configured to everything downstream, so it produces a 401 rather than "no token".
  const empty = first(secretVariableStatuses([decl('TOKEN')], 'TOKEN=\n'), 'status');
  const quoted = first(secretVariableStatuses([decl('TOKEN')], 'TOKEN=""\n'), 'status');
  const absent = first(secretVariableStatuses([decl('TOKEN')], 'OTHER=x\n'), 'status');

  assert.equal(empty.state, 'empty');
  assert.equal(quoted.state, 'empty');
  assert.equal(absent.state, 'absent');
  assert.notEqual(secretVariableProblem(empty), secretVariableProblem(absent));
  assert.match(secretVariableProblem(empty) ?? '', /EMPTY/);
});

test('`export NAME=` and leading whitespace are still assignments', () => {
  const s = first(secretVariableStatuses([decl('TOKEN')], '  export TOKEN=real\n'), 'status');
  assert.equal(s.state, 'set');
});

test('a name that is a PREFIX of another is not matched by it', () => {
  // `TOKEN` must not be answered by `TOKEN_ID=x`: a substring match here would report a
  // credential as present because a differently-named one is.
  const s = first(secretVariableStatuses([decl('TOKEN')], 'TOKEN_ID=x\n'), 'status');
  assert.equal(s.state, 'absent');
});

test('a missing file makes every declared variable absent, not an error', () => {
  const statuses = secretVariableStatuses([decl('A'), decl('B')], undefined);
  assert.deepEqual(
    statuses.map((s) => s.state),
    ['absent', 'absent'],
  );
});

test('the problem line carries the `why`, which is why the schema requires one', () => {
  const s = first(secretVariableStatuses([decl('USER_READWRITE_PASSWORD')], ''), 'status');
  assert.match(secretVariableProblem(s) ?? '', /USER_READWRITE_PASSWORD is needed/);
});

test('declaring nothing produces nothing — the empty default stays silent', () => {
  assert.deepEqual(secretVariableStatuses([], undefined), []);
});

test('`optional` is carried through, so the caller can pick the severity', () => {
  const s = first(secretVariableStatuses([decl('NICE_TO_HAVE', true)], undefined), 'status');
  assert.equal(s.optional, true);
  // It is still a problem line -- optional changes how it is PRINTED, not whether it is unset.
  assert.notEqual(secretVariableProblem(s), undefined);
});

/**
 * The DERIVED half: what a hangar needs because of what its config already says.
 *
 * A property, not a snapshot, for the same reason as everything else here -- and the bug it pins
 * is the one the declaration alone could not catch. `secrets.variables[]` covers what the REPO's
 * tooling reads; Hangar's own credentials follow from `forge` and `tracker`, and used to be
 * scaffolded into the FILE by `setup` while `doctor` checked only the declared list. So this
 * fleet, declaring one variable, was silent about three of the four credentials it uses.
 */
test('a bitbucket + jira hangar expects three credentials it never had to declare', () => {
  const derived = hangarOwnSecretVariables({
    forgeKind: 'bitbucketCloud',
    forgeTokenEnvKey: undefined,
    trackerKind: 'jira',
  });
  assert.deepEqual(
    derived.map((v) => v.name),
    ['BITBUCKET_TOKEN', 'ATLASSIAN_USER_EMAIL', 'ATLASSIAN_API_TOKEN'],
  );
  // Every one degrades visibly rather than breaking, so none of them may make `doctor` red on a
  // hangar whose owner simply never syncs: a check red in normal operation is one nobody reads.
  assert.ok(derived.every((v) => v.optional));
  // `why` is what the row prints, and an empty one would make the row say nothing at all.
  assert.ok(derived.every((v) => v.why.length > 0));
});

test('forge.tokenEnvKey renames the derived row, so the scaffold and the reader agree', () => {
  const [token] = hangarOwnSecretVariables({
    forgeKind: 'bitbucketCloud',
    forgeTokenEnvKey: 'ACME_BITBUCKET_PAT',
    trackerKind: 'none',
  });
  assert.equal(token?.name, 'ACME_BITBUCKET_PAT');
});

test('a hangar on no forge and no tracker expects nothing, so it gets no row', () => {
  assert.deepEqual(
    hangarOwnSecretVariables({
      forgeKind: 'none',
      forgeTokenEnvKey: undefined,
      trackerKind: 'none',
    }),
    [],
  );
});

/**
 * The override is the escape hatch for the two judgements the derivation makes for you.
 *
 * Deriving a row means deciding its `why` and its `optional` on the hangar's behalf. A hangar
 * that genuinely cannot work without its forge token has to be able to say so and get a red row,
 * and the mechanism is declaring the same NAME -- which must replace the derived entry rather
 * than sit beside it, or `doctor` prints the same credential twice with opposite verdicts.
 */
test('a declared variable replaces the derived one of the same name, never duplicates it', () => {
  const derived = hangarOwnSecretVariables({
    forgeKind: 'bitbucketCloud',
    forgeTokenEnvKey: undefined,
    trackerKind: 'none',
  });
  const declared: SecretVariable[] = [
    { name: 'BITBUCKET_TOKEN', why: 'this fleet cannot sync without it', optional: false },
    { name: 'USER_READWRITE_PASSWORD', why: 'the Playwright login', optional: false },
  ];
  const expected = expectedSecretVariables(derived, declared);
  assert.deepEqual(
    expected.map((v) => v.name),
    ['BITBUCKET_TOKEN', 'USER_READWRITE_PASSWORD'],
  );
  assert.equal(expected.find((v) => v.name === 'BITBUCKET_TOKEN')?.optional, false);
});
