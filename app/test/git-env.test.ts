import assert from 'node:assert/strict';
import { test } from 'node:test';

import { noEditorEnv } from '../src/git.ts';

/**
 * The environment every git subprocess of this CLI runs in.
 *
 * `git.ts` carries the measured precedence table; this holds the half of it that matters, which
 * is that the answer does not depend on the shell `hangar` was started from. A golden capture
 * cannot reach this: nothing is generated, and the failure is a hang rather than wrong text.
 *
 * The three variables below are named because they are git's own fallback chain -- `GIT_EDITOR`,
 * then `core.editor`, then `VISUAL`, then `EDITOR`. A guard that only overrode the last two
 * would look right and lose to exactly the rc file that caused the trouble.
 */

test('no editor survives, whichever one the shell asked for', () => {
  const env = noEditorEnv({
    GIT_EDITOR: 'vim',
    VISUAL: 'vim',
    EDITOR: 'vim',
    GIT_SEQUENCE_EDITOR: 'vim',
  });
  assert.equal(env['GIT_EDITOR'], 'true');
  assert.equal(env['GIT_SEQUENCE_EDITOR'], 'true');
});

test('an editor is forced even when the shell names none', () => {
  const env = noEditorEnv({});
  assert.equal(env['GIT_EDITOR'], 'true');
  assert.equal(env['GIT_SEQUENCE_EDITOR'], 'true');
});

test('everything else the shell exported reaches git untouched', () => {
  const base = { PATH: '/usr/bin:/bin', HOME: '/home/somebody', SSH_AUTH_SOCK: '/tmp/agent.sock' };
  const env = noEditorEnv({ ...base, GIT_EDITOR: 'vim' });
  for (const [key, value] of Object.entries(base)) assert.equal(env[key], value);
});

test('the caller’s own environment is not mutated', () => {
  const base: NodeJS.ProcessEnv = { GIT_EDITOR: 'vim' };
  noEditorEnv(base);
  assert.equal(base['GIT_EDITOR'], 'vim');
});
