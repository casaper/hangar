import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { allowInstructions, direnvDirs } from '../src/commands/allow.ts';
import { run } from '../src/exec.ts';
import { cloneAt } from '../src/fleet.ts';
import { fixtureConfigText, syntheticHangar } from './fixture.ts';

/**
 * Which directories of a clone `hangar allow` aims direnv at.
 *
 * **These need a REAL directory, and that is the same fact that leaves the golden capture of this
 * builder empty.** `syntheticHangar()` is in-memory at `/wt`, so `direnvDirs`' `existsSync` filter
 * removes every candidate and the function returns `[]` -- against which every assertion below
 * would pass while checking nothing. So the clone is a temp directory carrying the `.envrc` files
 * the test is asking about, following `pr-cache.test.ts`.
 */

/** A synthetic hangar rooted in a fresh temp directory, plus its clone 1, created on disk. */
const tempClone = (
  envrcDirs: readonly string[],
): { clone: ReturnType<typeof cloneAt>; path: string } => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-allow-'));
  const configText = fixtureConfigText().replace(
    /^ {2}envrcDirs: .*$/m,
    `  envrcDirs: [${envrcDirs.map((d) => `'${d}'`).join(', ')}]`,
  );
  const hangar = syntheticHangar({ root, configText, claudeDir: join(root, '.claude') });
  const clone = cloneAt(hangar, 1);
  mkdirSync(clone.path, { recursive: true });
  return { clone, path: clone.path };
};

/** Write an `.envrc` into `<clone>/<dir>`, creating the directory. */
const envrcIn = (clonePath: string, dir: string): string => {
  const target = join(clonePath, dir);
  mkdirSync(target, { recursive: true });
  const file = join(target, '.envrc');
  writeFileSync(file, 'export FIXTURE=1\n');
  return file;
};

test('the configured directories are returned root first, and only where an .envrc exists', () => {
  const { clone, path } = tempClone(['.', 'web', 'nope']);
  envrcIn(path, '.');
  envrcIn(path, 'web');

  /*
   * `nope` is declared and has no `.envrc` on this branch. It is dropped rather than returned,
   * because a path with nothing at it is not one `direnv allow` should be aimed at -- and a
   * config listing a directory the current branch does not carry is the normal case, not a
   * misconfiguration.
   */
  assert.deepEqual(direnvDirs(clone), ['.', 'web']);
});

test('a directory git knows about is allowed even when the config does not list it', () => {
  /*
   * The union is the whole of `direnvDirs`, and it is the half with a history: the list was once
   * hardcoded to the root and the app directory, which silently left a third `.envrc` un-allowed
   * -- and that one carries the symlink reloading the shared secrets over a tracked `.env` that
   * blanks a password, so the suite it belongs to logged in with an empty one and nothing said
   * why. `gitTry` swallows a failure into `?? ''`, so a git half that quietly returned nothing
   * would leave the command working for exactly whatever the config happened to name.
   *
   * This is the one test in the suite that spawns git. It has to: `ls-files` is the question.
   */
  const { clone, path } = tempClone(['.']);
  envrcIn(path, '.');
  const undeclared = envrcIn(path, 'tools/e2e');

  const init = run('git', ['-C', path, 'init', '-q']);
  assert.ok(init.ok, `git init failed: ${init.stderr}`);
  const add = run('git', ['-C', path, 'add', '-f', '--', undeclared]);
  assert.ok(add.ok, `git add failed: ${add.stderr}`);

  assert.deepEqual(direnvDirs(clone), ['.', 'tools/e2e']);
});

test('what add-clone prints names both routes, and no directory of this repo', () => {
  const { clone } = tempClone(['.']);
  const text = allowInstructions(clone);

  // Both routes, because they are not interchangeable: `hangar` is on PATH at the hangar root
  // and is NOT inside a clone whose .envrc has never been allowed.
  assert.ok(text.includes(`hangar allow ${clone.name}`), text);
  assert.ok(text.includes(`hangar_${clone.hangar.id}_allow`), text);

  // Rendered from the clone and the id, so nothing in it can name one repo's layout. The
  // `.envrc` directories are deliberately absent: they are config, and this text is captured.
  for (const literal of ['angular', 'clone_0', 'DN-', '/Users/', '/home/']) {
    assert.ok(!text.includes(literal), `instructions name "${literal}":\n${text}`);
  }
});
