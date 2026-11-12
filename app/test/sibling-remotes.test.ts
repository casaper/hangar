import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fetchRemotesFor } from '../src/commands/sync.ts';
import { loudSiblingRemotes, quietSiblingRemote } from '../src/git.ts';

/**
 * A sibling remote is fetched by NAME only: `skipFetchAll` keeps it out of `git fetch --all`, and
 * the refs it had are dropped, because nothing refreshes them afterwards and three safety checks
 * read any remote-tracking ref as proof that a commit is safe.
 */

test('a sync fetches origin, plus the sibling a target names and nothing else', () => {
  const siblings = ['clone_01', 'clone_03'];
  assert.deepEqual(fetchRemotesFor('origin/main', siblings), ['origin']);
  assert.deepEqual(fetchRemotesFor('clone_01/fixes/x', siblings), ['origin', 'clone_01']);
  // A branch that only LOOKS remote-qualified is not a sibling, and neither is a bare name.
  assert.deepEqual(fetchRemotesFor('fixes/x', siblings), ['origin']);
  assert.deepEqual(fetchRemotesFor('main', siblings), ['origin']);
});

test('real git: a quieted sibling loses its refs and is skipped by fetch --all, not by name', () => {
  // `quietSiblingRemote` runs git in this process's environment. Run from a git hook, `GIT_DIR`
  // would answer for every directory, so every inherited `GIT_*` goes -- this file is its own
  // process under `node --test`, so nothing else sees the change.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) Reflect.deleteProperty(process.env, key);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hangar-siblings-')));
  try {
    const git = (cwd: string, ...args: string[]) => {
      const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
      return res.stdout.trim();
    };
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
    for (const name of ['origin', 'clone_01', 'clone_02']) {
      git(root, 'init', '-q', '-b', 'main', name);
      git(join(root, name), ...id, 'commit', '-q', '--allow-empty', '-m', name);
    }
    git(root, 'clone', '-q', 'origin', 'clone_03');
    const repo = join(root, 'clone_03');
    git(repo, 'remote', 'add', 'clone_01', '../clone_01');
    git(repo, 'remote', 'add', 'clone_02', '../clone_02');
    git(repo, 'fetch', '-q', '--all');
    const refsOf = (remote: string) =>
      git(repo, 'for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/`);

    // `clone_09` is a sibling with no remote here: never a config section for it.
    const siblings = ['clone_01', 'clone_02', 'clone_09'];
    assert.deepEqual(loudSiblingRemotes(repo, siblings), ['clone_01', 'clone_02']);

    const quieted = quietSiblingRemote(repo, 'clone_01');
    assert.deepEqual(quieted.failed, []);
    assert.ok(quieted.dropped > 0, 'the refs of a remote that had been fetched were kept');
    assert.equal(refsOf('clone_01'), '');
    assert.deepEqual(loudSiblingRemotes(repo, siblings), ['clone_02']);
    assert.ok(!git(repo, 'remote').split('\n').includes('clone_09'));

    // `--all` skips it; naming it still fetches it.
    git(repo, 'fetch', '-q', '--all');
    assert.equal(refsOf('clone_01'), '');
    git(repo, 'fetch', '-q', 'clone_01');
    assert.notEqual(refsOf('clone_01'), '');

    // Idempotent: a second run sets the same key and drops what the named fetch brought back.
    assert.deepEqual(quietSiblingRemote(repo, 'clone_01').failed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
