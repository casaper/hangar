import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyArtifact } from '../src/generate/index.ts';

/**
 * The one writer every generated artifact goes through, against real files.
 *
 * It writes beside the destination and renames, so tmux's ten-second status job and a shell
 * sourcing the hook never read half a file. A rename has two ways to quietly change more than
 * the content -- the mode and a symlinked destination -- and these hold both.
 */

const fresh = (): string => mkdtempSync(join(tmpdir(), 'generate-write-'));

test('a new script is written whole and already executable, with no temp file left', () => {
  const dir = fresh();
  try {
    const path = join(dir, 'script.sh');
    assert.equal(
      applyArtifact({ path, content: '#!/bin/sh\n', mode: 0o755, what: 'a script' }, false),
      'written',
    );
    assert.equal(readFileSync(path, 'utf8'), '#!/bin/sh\n');
    assert.equal(statSync(path).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(dir), ['script.sh']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing file keeps its own mode when the artifact declares none', () => {
  const dir = fresh();
  try {
    const path = join(dir, 'private.json');
    writeFileSync(path, '{}\n', { mode: 0o600 });
    applyArtifact({ path, content: '{"a":1}\n', what: 'settings' }, false);
    assert.equal(readFileSync(path, 'utf8'), '{"a":1}\n');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlinked destination stays a link, and the file behind it is the one rewritten', () => {
  const dir = fresh();
  try {
    const real = join(dir, 'dotfiles-copy.conf');
    const link = join(dir, 'managed.conf');
    writeFileSync(real, 'old\n');
    symlinkSync(real, link);
    applyArtifact({ path: link, content: 'new\n', what: 'a conf' }, false);
    assert.ok(lstatSync(link).isSymbolicLink(), 'the link was replaced by a plain file');
    assert.equal(readFileSync(real, 'utf8'), 'new\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
