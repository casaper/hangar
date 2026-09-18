import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CliError, run } from '../exec.ts';
import {
  discoverClones,
  cloneForCwd,
  knownClonesHint,
  requireClone,
  type Clone,
} from '../fleet.ts';
import { gitTry } from '../git.ts';
import { cloneLabel, heading, note, step, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar allow [clone]` -- `direnv allow` in every directory of a clone that has an `.envrc`.
 *
 * A repo can have more than one, and this one has three: the root, the app subdirectory and the
 * Playwright suite. All three are TRACKED, so any `git pull` or `hangar sync` changes their
 * content and direnv blocks all three at once -- which makes "allow this clone" a thing typed
 * often enough to be a command rather than three lines from memory.
 *
 * **The entry point that matters is the generated shell function, not this name.** direnv
 * considers exactly ONE `.envrc` -- the nearest -- and when that one is blocked it reverts the
 * environment outright rather than falling back to a parent. Measured: inside a blocked clone the
 * hangar's own `PATH_add "<hangar>/bin"` is gone, so `hangar` is not callable by name in the one
 * situation this command exists for. `clone-terminal.sh` defines `hangar_<id>_allow`, which the
 * developer's shell rc has already sourced and which names `bin/hangar` by ABSOLUTE path; that
 * binary resolves the hangar from `$PWD` under a stripped environment, so the route works with
 * direnv contributing nothing.
 *
 * That function delegates here rather than doing the work itself, for two reasons: it would be a
 * second implementation of `direnvDirs` to keep in step, and a self-contained one would have to
 * bake `repo.envrcDirs` into GENERATED TEXT -- this repo's own layout, in a file
 * `scan:literals` reads.
 */
export type AllowCommandOptions = {
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
};

/**
 * Every directory in the clone that has an `.envrc`, root first. PURE apart from the two reads.
 *
 * Discovered from git rather than declared: all of them are tracked, so `ls-files` is exact and
 * costs nothing, and a branch that adds a fourth `.envrc` is covered without editing anything.
 * `repo.envrcDirs` is the union'd fallback for a checkout git cannot answer for -- not the list
 * itself, because a hardcoded `['.', '<appDir>']` silently left the Playwright directory
 * un-allowed, and that one carries the symlink that reloads the shared secrets after the tracked
 * `.env` blanks the password -- so the login fails with an empty one and nothing says why.
 *
 * `existsSync` filters both halves: a configured directory that this branch does not have is not
 * a path `direnv allow` should be aimed at.
 */
export const direnvDirs = (clone: Clone): string[] => {
  const tracked = gitTry(clone.path, ['ls-files', '-z', '--', '*.envrc']) ?? '';
  const dirs = new Set(
    tracked
      .split('\0')
      .filter((file) => file.endsWith('.envrc'))
      .map((file) => dirname(file)),
  );
  for (const dir of clone.hangar.config.repo.envrcDirs) dirs.add(dir);
  return [...dirs]
    .filter((dir) => existsSync(join(clone.path, dir, '.envrc')))
    .sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
};

/** Where a directory's `.envrc` is, for a message. `.` is the clone root. */
const envrcLabel = (dir: string): string => (dir === '.' ? '.envrc' : `${dir}/.envrc`);

/**
 * What `add-clone` prints once the clone exists. PURE.
 *
 * It names the command rather than running it, and says so: allowing an `.envrc` is approving
 * the shell it runs, which is a thing the person who will run that shell decides. Both routes
 * are given because they are not interchangeable -- from the hangar root `hangar` is on PATH,
 * and from inside a clone whose `.envrc` has never been allowed it is not.
 */
export const allowInstructions = (clone: Clone): string =>
  [
    `  hangar allow ${clone.name}`,
    `  hangar_${clone.hangar.id}_allow`,
    '',
    'Allowing an .envrc is approving the shell it runs, so add-clone will not do it for you. The',
    'first line works from anywhere; the second is the shell function for when you are already in',
    'the clone, where a blocked .envrc means `hangar` itself is not yet on PATH. It reaches a new',
    'shell only.',
  ].join('\n');

export const allow = (hangar: Hangar, ref: string | undefined, opts: AllowCommandOptions): void => {
  const clones: readonly Clone[] =
    opts.all === true
      ? discoverClones(hangar)
      : [
          ref === undefined
            ? (cloneForCwd(hangar) ??
              (() => {
                throw new CliError(
                  'allow needs a clone name, or --all -- and this is not a clone',
                  knownClonesHint(hangar),
                );
              })())
            : requireClone(hangar, ref),
        ];

  /*
   * A failure WARNS and the run carries on; the exit code comes at the end.
   *
   * This is where the shape deliberately differs from `install`, which it otherwise copies. A
   * failed install step means the remaining steps would build on something that is not there, so
   * stopping is correct. Here each directory is independent of every other, and each clone
   * certainly is -- so throwing on the first one would leave a `--all` half applied, the earlier
   * clones allowed, the later ones untouched, and nothing on screen saying where it gave up. The
   * one case that fails for all of them at once is direnv not being installed, and that reads
   * just as clearly seven times as once.
   */
  const failures: string[] = [];

  for (const clone of clones) {
    heading(cloneLabel(clone));
    const dirs = direnvDirs(clone);
    if (dirs.length === 0) {
      note('no .envrc anywhere in this clone');
      continue;
    }
    for (const dir of dirs) {
      if (opts.dryRun === true) {
        step(`would allow ${envrcLabel(dir)}`);
        continue;
      }
      const res = run('direnv', ['allow', join(clone.path, dir)]);
      if (!res.ok) {
        const detail = (res.stderr || res.stdout).trim();
        warn(
          `${envrcLabel(dir)} — ${detail === '' ? 'is direnv installed? `brew install direnv`' : detail}`,
        );
        failures.push(`${clone.name}/${envrcLabel(dir)}`);
        continue;
      }
      // One line per FILE, never a single "done": what was just approved is the shell in each of
      // these, and a silent success is the wrong report for that.
      step(`allowed ${envrcLabel(dir)}`);
    }
  }

  if (failures.length > 0) {
    throw new CliError(
      `direnv allow failed for ${String(failures.length)} of them`,
      failures.join(', '),
    );
  }
};
