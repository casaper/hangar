import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  dotenvValues,
  envLocalContent,
  envLocalExtrasDrift,
  envLocalPath,
  readEnvLocalPorts,
} from '../src/clone-config.ts';
import { CliError } from '../src/exec.ts';
import { cloneAt } from '../src/fleet.ts';
import { clearPortPin, portPins, setPortPin } from '../src/port-pins.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * `.hangar/port-pins.json`, read through the one path every command takes: `cloneAt`.
 *
 * Each test gets its own root, because the pins are cached per root -- and a test that shared one
 * would be testing the cache rather than the file.
 */
const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'hangar-pins-'));

test('a pinned clone keeps its snapshot, and its siblings keep the formula', () => {
  const root = freshRoot();
  try {
    const hangar = syntheticHangar({ root });
    setPortPin(hangar, 2, new Map([['FIXTURE_API_PORT', 4300]]));
    const pinned = cloneAt(hangar, 2);
    assert.equal(pinned.portsPinned, true);
    assert.equal(pinned.ports[0]?.port, 4300);
    assert.equal(cloneAt(hangar, 3).portsPinned, false);
    assert.equal(cloneAt(hangar, 3).ports[0]?.port, 3237);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unpinning the last clone removes the file', () => {
  const root = freshRoot();
  try {
    const hangar = syntheticHangar({ root });
    setPortPin(hangar, 1, new Map([['FIXTURE_API_PORT', 3000]]));
    assert.equal(clearPortPin(hangar, 1), true);
    assert.equal(clearPortPin(hangar, 1), false);
    assert.equal(portPins(hangar).size, 0);
    assert.equal(existsSync(hangar.paths.portPinsFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pin file that will not parse is an error, never "no pins"', () => {
  /*
   * "No pins" would put every pinned clone on the new layout at once -- the one thing a pin
   * exists to prevent, and silently, since every derived value would agree with itself.
   */
  for (const text of ['{ not json', '[]', '{"2": {"FIXTURE_API_PORT": "4300"}}', '{"two": {}}']) {
    const root = freshRoot();
    try {
      mkdirSync(join(root, '.hangar'));
      writeFileSync(join(root, '.hangar', 'port-pins.json'), text);
      assert.throws(() => cloneAt(syntheticHangar({ root }), 2), CliError, text);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('two hangars in one process do not share pins', () => {
  const a = freshRoot();
  const b = freshRoot();
  try {
    setPortPin(syntheticHangar({ root: a }), 2, new Map([['FIXTURE_API_PORT', 4300]]));
    assert.equal(cloneAt(syntheticHangar({ root: a }), 2).ports[0]?.port, 4300);
    assert.equal(cloneAt(syntheticHangar({ root: b }), 2).portsPinned, false);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('a port key with a digit in it is read back from the dotenv', () => {
  // The schema allows `^[A-Z][A-Z0-9_]*$`; the reader once took `[A-Z_]+` only, so doctor called
  // a correctly written `E2E_PORT` missing for ever and the collision check never saw it.
  const root = freshRoot();
  try {
    const clone = cloneAt(syntheticHangar({ root }), 1);
    mkdirSync(clone.path, { recursive: true });
    writeFileSync(envLocalPath(clone), 'E2E_PORT=4311\nS3_PORT=\'4312\'\nAPI_PORT="4313"\n');
    assert.deepEqual(readEnvLocalPorts(clone), { E2E_PORT: 4311, S3_PORT: 4312, API_PORT: 4313 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dotenv check covers the root key and every cloneEnv var, not only the ports', () => {
  const clone = cloneAt(syntheticHangar(), 2);
  const generated = envLocalContent(clone);
  assert.deepEqual(envLocalExtrasDrift(clone, generated), []);

  const extras = [...dotenvValues(generated).keys()].filter(
    (key) => !clone.ports.some((entry) => entry.role.envKey === key),
  );
  assert.ok(extras.length > 0, 'the fixture derives nothing but ports -- this test proves nothing');
  const [first] = extras;
  assert.ok(first !== undefined);
  const without = generated
    .split('\n')
    .filter((line) => !line.startsWith(`${first}=`))
    .join('\n');
  assert.deepEqual(envLocalExtrasDrift(clone, without), [`${first} missing`]);
  const changed = generated.replace(new RegExp(`^${first}=.*$`, 'm'), `${first}=elsewhere`);
  assert.deepEqual(envLocalExtrasDrift(clone, changed), [
    `${first} differs from what the config derives`,
  ]);
});
