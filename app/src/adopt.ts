import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

import { isInside } from './user-paths.ts';

/**
 * Moving per-clone state into one shared fleet directory.
 *
 * Both shared directories -- the plan archive and the shared `tmp/` -- are built by taking
 * three clones' copies of the same thing and merging them into one. The rules are the same in
 * both cases and are deliberately conservative: nothing is ever overwritten, byte-identical
 * copies collapse to one, and anything that differs is kept beside the winner under a name
 * that says where it came from. A merge that silently picked a winner would lose work in a way
 * nobody would notice until they needed the file.
 */

export type AdoptKind = 'moved' | 'dropped' | 'conflict' | 'skipped';

export type AdoptAction = {
  readonly kind: AdoptKind;
  readonly message: string;
};

export type AdoptOptions = {
  /** Where the entry came from -- used for the `.from-<label>` conflict suffix. */
  readonly label: string;
  readonly dryRun: boolean;
  /**
   * The store's ROOT, carried down unchanged while `destDir` descends. A link anywhere in it is
   * the store's own -- the Jira hook links a real ticket directory's records into
   * `jira-tickets/`, which is not under that ticket's `destDir` -- and judging by `destDir`
   * alone warned "left alone" about every one of them, which in `--quiet` mode is a warn that
   * prints the whole narration at the end of every session in that clone.
   */
  readonly storeRoot: string;
};

const hashOf = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const isDir = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether the link at `from`, moved into `destDir`, would still resolve to `target`. An absolute
 * link always does; the Jira hook's are RELATIVE (`../jira-tickets/<KEY>.md`), and those do too
 * whenever the destination sits at the same depth beside the record store -- as a ticket
 * directory in the clone and its twin in the store do.
 */
const samePlaceFrom = (destDir: string, from: string, target: string): boolean => {
  try {
    const link = readlinkSync(from);
    return realpathSync(isAbsolute(link) ? link : resolve(destDir, link)) === target;
  } catch {
    return false;
  }
};

/** Rename, falling back to copy-then-remove when the move would cross a filesystem. */
const move = (from: string, to: string): void => {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, preserveTimestamps: true });
    rmSync(from, { recursive: true });
  }
};

/**
 * What marks a copy as the half that lost a `tmp merge` conflict.
 *
 * Exported because a second reader now exists (`pr-description.ts` skips these when it looks for a
 * pull-request description) and the two must agree by construction: a reader spelling it itself
 * would go on finding conflict copies the day this suffix changes, and would publish one.
 */
export const CONFLICT_MARKER = '.from-';

const conflictName = (name: string, label: string): string => {
  const ext = extname(name);
  return `${basename(name, ext)}${CONFLICT_MARKER}${label}${ext}`;
};

/**
 * Move `from` into `destDir`. Directories are merged entry by entry rather than replaced, so
 * two clones each holding half of a ticket's files end up with both halves.
 */
export const adoptInto = (from: string, destDir: string, opts: AdoptOptions): AdoptAction[] => {
  const name = basename(from);
  const to = join(destDir, name);
  const actions: AdoptAction[] = [];

  // A symlink that already points into the destination is the OLD sharing mechanism; the
  // content it names has been moved there, so the link itself is what is left to remove.
  if (isSymlink(from)) {
    let target: string | undefined;
    try {
      target = realpathSync(from);
    } catch {
      target = undefined;
    }
    if (target === undefined || target === to || target.startsWith(`${destDir}/`)) {
      actions.push({ kind: 'dropped', message: `${opts.label}/${name}: symlink into the store` });
      if (!opts.dryRun) rmSync(from);
    } else if (isInside(target, opts.storeRoot) && samePlaceFrom(destDir, from, target)) {
      // A link into the store from OUTSIDE this destination -- the Jira hook's link from a real
      // ticket directory to its record in `jira-tickets/`. It is the store's own, and is carried
      // like a file: moved in when the name is free (an absolute link moves intact), dropped when
      // the store already has the same link, and only otherwise left -- with a reason.
      let there: string | undefined;
      try {
        there = exists(to) ? realpathSync(to) : undefined;
      } catch {
        there = undefined;
      }
      if (!exists(to)) {
        actions.push({ kind: 'moved', message: `${opts.label}/${name}: link into the store` });
        if (!opts.dryRun) {
          mkdirSync(destDir, { recursive: true });
          move(from, to);
        }
      } else if (there === target) {
        actions.push({
          kind: 'dropped',
          message: `${opts.label}/${name}: same link as the store's`,
        });
        if (!opts.dryRun) rmSync(from);
      } else {
        actions.push({
          kind: 'skipped',
          message: `${opts.label}/${name}: links to ${target}, but the store's ${name} is something else — left alone`,
        });
      }
    } else {
      actions.push({
        kind: 'skipped',
        message: `${opts.label}/${name}: symlink to ${target} — left alone`,
      });
    }
    return actions;
  }

  if (!exists(to)) {
    actions.push({ kind: 'moved', message: `${opts.label}/${name}` });
    if (!opts.dryRun) {
      mkdirSync(destDir, { recursive: true });
      move(from, to);
    }
    return actions;
  }

  if (isDir(from) && isDir(to)) {
    for (const entry of readdirSync(from)) {
      actions.push(
        ...adoptInto(join(from, entry), to, { ...opts, label: `${opts.label}/${name}` }),
      );
    }
    if (!opts.dryRun) {
      try {
        rmdirSync(from);
      } catch {
        actions.push({
          kind: 'skipped',
          message: `${opts.label}/${name}: not empty after merging — left in place`,
        });
      }
    }
    return actions;
  }

  if (isDir(from) !== isDir(to)) {
    actions.push({
      kind: 'skipped',
      message: `${opts.label}/${name}: a ${isDir(from) ? 'directory' : 'file'} where the store has a ${isDir(to) ? 'directory' : 'file'}`,
    });
    return actions;
  }

  if (hashOf(from) === hashOf(to)) {
    actions.push({ kind: 'dropped', message: `${opts.label}/${name}: identical to the store` });
    if (!opts.dryRun) rmSync(from);
    return actions;
  }

  const kept = conflictName(name, opts.label.replaceAll('/', '-'));
  actions.push({
    kind: 'conflict',
    message: `${opts.label}/${name}: differs from the store — kept as ${kept}`,
  });
  if (!opts.dryRun) move(from, join(destDir, kept));
  return actions;
};
