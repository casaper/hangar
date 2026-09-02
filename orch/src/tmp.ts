import { lstatSync, readdirSync, readlinkSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { Clone } from './fleet.ts';
import { fleetTmp } from './paths.ts';

/**
 * The shared `tmp/`: one store at the fleet root, and per-ENTRY symlinks in every clone.
 *
 * Every clone keeps its own real `tmp/` directory. What is shared is the content in it that
 * does not belong to one clone -- the per-ticket Jira cache, the PR descriptions, whatever
 * else the skills cache -- which lives at `<fleet>/tmp/<name>` with `clone_NN/tmp/<name>` a
 * symlink to it. What does belong to one clone stays exactly where it is and is never read,
 * moved or linked: the dev-server PID files, and the `_<clone>/` directory some branches put
 * them in.
 *
 * Linking one level DOWN rather than sharing `tmp/` itself is the whole point. A PID file is
 * per clone and ephemeral: `dev/run-with-pid.mjs` refuses a name that is already live and
 * `dev/pids.mjs --kill <name>` finds a server by that file, so a shared `tmp/` would let the
 * first clone to start a dev server block the other two and let a kill reach into a sibling.
 * With the links one level down none of that can happen, a running server is no obstacle to
 * sharing, and no branch has to have landed anything first -- which is what sharing the whole
 * directory had to wait for.
 *
 * It needs no change to the tracked skill tooling either:
 * `.claude/skills/jira-scope/jira-cache.mjs` hardcodes `<git toplevel>/tmp/<KEY>` with no
 * configuration, but only ever does `mkdirSync(..., {recursive: true})` on it, which follows
 * a symlink.
 */

export const cloneTmpPath = (clone: Clone): string => join(clone.path, 'tmp');

const lstatOrUndefined = (path: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

export const isPidFile = (name: string): boolean => name.endsWith('.pid');

/** Every file under `dir`, at any depth -- enough to recognise a directory of only PID files. */
const filesUnder = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    return isDir ? filesUnder(path) : [path];
  });
};

/**
 * True for an entry of a clone's `tmp/` that belongs to that clone alone.
 *
 * A blocklist, deliberately: `tmp/` holds one kind of private state (PID files, and the
 * directory a branch may scope them into) and everything else in it is cache every clone
 * wants. An allowlist of cache names would need editing every time a skill caches something
 * new, and the failure mode is silent -- the new file simply never gets shared.
 *
 * Dotfiles are private too. `.DS_Store` and `.gitkeep` are the ones that actually turn up, and
 * neither is worth carrying into the store or linking back out of it.
 */
export const isPrivateTmpEntry = (clone: Clone, name: string): boolean => {
  if (name.startsWith('.') || isPidFile(name)) return true;
  if (name === `_${clone.name}`) return true;
  // A directory holding nothing but PID files: `_<clone>/` under a name this fleet no longer
  // generates, or one left behind by a clone that has since been renumbered.
  const files = filesUnder(join(cloneTmpPath(clone), name));
  return files.length > 0 && files.every((path) => isPidFile(path));
};

/** The store's entries worth linking into a clone -- everything except dotfiles and PID files. */
export const shareableStoreEntries = (names: readonly string[]): string[] =>
  names.filter((name) => !name.startsWith('.') && !isPidFile(name)).sort();

export const storeEntries = (): string[] => {
  try {
    return shareableStoreEntries(readdirSync(fleetTmp));
  } catch {
    return [];
  }
};

/**
 * Give a FRESH `tmp/` a link to every shared entry, and report any name already taken.
 *
 * For a clone that has no cache of its own -- `add-clone`. `tmp merge` does not use it: that
 * command has to repair as well as create (replace a link pointing at the old store, leave a
 * correct one alone, keep a real file that a skipped adoption left behind) and has to preview
 * all of it. Here there is nothing to repair, and the one thing worth saying out loud is a
 * name that is somehow occupied already -- `symlinkSync` would throw EEXIST on it and abort
 * the rest of the clone's setup.
 */
export const linkStoreEntriesInto = (tmp: string): { linked: string[]; taken: string[] } => {
  const linked: string[] = [];
  const taken: string[] = [];
  for (const name of storeEntries()) {
    const path = join(tmp, name);
    if (lstatOrUndefined(path) !== undefined) {
      taken.push(name);
      continue;
    }
    symlinkSync(join(fleetTmp, name), path);
    linked.push(name);
  }
  return { linked, taken };
};

/** Where a `tmp/` entry points, or undefined when it is not a symlink. */
export const linkTargetOf = (path: string): string | undefined => {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
};

/** True when `clone_NN/tmp/<name>` is the symlink into the store this fleet maintains. */
export const isLinkedIntoStore = (clone: Clone, name: string): boolean =>
  linkTargetOf(join(cloneTmpPath(clone), name)) === join(fleetTmp, name);

/**
 * True when a clone's `tmp` is a symlink rather than its own directory.
 *
 * The shape an earlier version of `tmp merge` produced, when the whole directory was shared.
 * It is not merely redundant now, it is the thing this design exists to avoid -- with it in
 * place a clone's PID files are the fleet's -- so `tmp merge` turns it back into a real
 * directory of links and `doctor` reports it.
 */
export const tmpIsSymlink = (clone: Clone): boolean =>
  lstatOrUndefined(cloneTmpPath(clone))?.isSymbolicLink() === true;

export const tmpIsOwnDirectory = (clone: Clone): boolean =>
  lstatOrUndefined(cloneTmpPath(clone))?.isDirectory() === true;

/**
 * PID files sitting in the store itself.
 *
 * Nothing this fleet does can put one there: they are never adopted and never linked. So one
 * that IS there was written straight into the store by a clone whose whole `tmp/` was still a
 * symlink to it -- the shape above -- and it is exactly the file that makes one clone's dev
 * server look like every clone's. Reported, never deleted: it may belong to a live process.
 */
export const strayPidFilesInStore = (): string[] => {
  try {
    return readdirSync(fleetTmp).filter(isPidFile);
  } catch {
    return [];
  }
};
