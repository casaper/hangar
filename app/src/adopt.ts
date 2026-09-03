import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';

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

const conflictName = (name: string, label: string): string => {
  const ext = extname(name);
  return `${basename(name, ext)}.from-${label}${ext}`;
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
