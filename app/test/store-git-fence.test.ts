import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';

import { STORE_GIT_FENCE_CONTENT, storeGitFencePath } from '../src/hangar-files.ts';
import { isNeverSharedName } from '../src/tmp.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * The shared store sits inside the hangar's own repository and clones reach it through symlinks,
 * so git run from a `tmp/<name>` link named the HANGAR repo -- and GitLens ran a clone's compare
 * there. The fence is a gitfile pointing nowhere, which stops discovery at the store.
 */

test('the fence lives in the store, points where nothing can exist, and is never shared', () => {
  const hangar = syntheticHangar();
  const fence = storeGitFencePath(hangar.paths.tmp);
  assert.equal(dirname(fence), hangar.paths.tmp);
  assert.match(STORE_GIT_FENCE_CONTENT, /^gitdir: \/dev\/null\//);
  // `tmp merge` links every store entry into every clone; a shared `.git` would fence the clone's
  // own `tmp/` off from the CLONE's repo instead.
  assert.ok(isNeverSharedName(hangar, basename(fence)));
});

test('real git stops at the fence instead of finding the repo around the store', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hangar-fence-')));
  try {
    // No inherited `GIT_*`: run from a git hook, `GIT_DIR` would answer for every directory.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const git = (cwd: string, ...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8', env });
    const hangarRoot = join(root, 'hangar');
    const store = join(hangarRoot, 'tmp');
    mkdirSync(join(store, 'ABC-1323'), { recursive: true });
    mkdirSync(join(root, 'clone', 'tmp'), { recursive: true });
    assert.equal(git(hangarRoot, 'init', '-q').status, 0);
    const link = join(root, 'clone', 'tmp', 'ABC-1323');
    symlinkSync(join(store, 'ABC-1323'), link);

    // Unfenced, a clone's link answers the hangar repo: the fault.
    assert.equal(git(link, 'rev-parse', '--show-toplevel').stdout.trim(), hangarRoot);

    writeFileSync(storeGitFencePath(store), STORE_GIT_FENCE_CONTENT);
    const fenced = git(link, 'rev-parse', '--show-toplevel');
    assert.notEqual(fenced.status, 0, 'git still found a repository through the store');
    assert.equal(fenced.stdout.trim(), '');
    // And the hangar repo itself still works from its root.
    assert.equal(git(hangarRoot, 'rev-parse', '--show-toplevel').stdout.trim(), hangarRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
