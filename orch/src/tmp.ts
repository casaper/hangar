import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import type { Clone } from './fleet.ts';
import { fleetTmp } from './paths.ts';

/**
 * The shared `tmp/`, and the one condition that makes sharing it safe.
 *
 * `tmp/` holds per-ticket Jira caches (which every clone wants to share) alongside live PID
 * files (which are strictly per clone). So the directory can only be shared once the clone's
 * own tooling writes PID files into `tmp/_<clone>/`: with a flat `tmp/<name>.pid` the first
 * clone to start a dev server blocks the other two, and `dev/pids.mjs --kill <name>` reaches
 * into whichever clone happens to have written the file.
 *
 * That is tracked application code, versioned per branch, so it arrives in each clone by a
 * normal merge. Until it does, this is what `tmp merge` refuses on and `doctor` waits for.
 */

/** The exact line an un-migrated `dev/pid-files.mjs` still carries. */
export const FLAT_PID_DIR = "export const pidDir = join(repoRoot, 'tmp');";

export const pidFilesModule = (clone: Clone): string => join(clone.path, 'dev', 'pid-files.mjs');

/** True when this clone's CHECKED-OUT tree writes PID files per clone. */
export const hasScopedPidDir = (clone: Clone): boolean => {
  try {
    return !readFileSync(pidFilesModule(clone), 'utf8').includes(FLAT_PID_DIR);
  } catch {
    // No such module: not this repo's layout, so there is nothing to wait for.
    return true;
  }
};

export const cloneTmpPath = (clone: Clone): string => join(clone.path, 'tmp');

/** True when this clone directory's `tmp` is the shared one rather than its own. */
export const isSharedTmpPath = (clonePath: string): boolean => {
  const tmp = join(clonePath, 'tmp');
  if (!existsSync(tmp)) return false;
  try {
    return realpathSync(tmp) === realpathSync(fleetTmp);
  } catch {
    return false;
  }
};

export const isSharedTmp = (clone: Clone): boolean => isSharedTmpPath(clone.path);

/**
 * PID files sitting in the ROOT of the shared `tmp/`.
 *
 * Once `tmp/` is shared, a flat `tmp/<name>.pid` cannot be attributed to a clone -- it is
 * whichever clone still writes flat paths, and it is exactly the file that would make one
 * clone's dev server look like every clone's. Reported once, at fleet level, rather than
 * being attributed to all of them.
 */
export const strayPidFilesInSharedTmp = (): string[] => {
  try {
    return readdirSync(fleetTmp).filter((entry) => entry.endsWith('.pid'));
  } catch {
    return [];
  }
};
