import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import pc from 'picocolors';

import { wantsWorkspaceFiles } from '../clone-config.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import { git } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { cloneLabel, heading, note, table, warn } from '../ui.ts';
import { tildify } from '../user-paths.ts';
import {
  bookmarkSyncSummary,
  parseBookmarks,
  parseSyncState,
  planBookmarkSync,
  renderSyncState,
  type BookmarkAction,
  type BookmarkCopy,
  type BookmarkPlan,
} from './vscode-bookmarks.ts';

/**
 * The reading and writing half of the VS Code bookmarks merge; `vscode-bookmarks.ts` is the pure
 * half and says what the merge does.
 *
 * Run by `ide vscode sync` and `doctor --fix` on purpose, and by `open`, `edit`, `close`,
 * `reload`, `up` and `down` as a side effect -- the moments a developer is opening or leaving a
 * window, which is when a bookmark made in one clone should reach the rest. So it never throws:
 * a bookmarks failure is a warning, never a window that did not open.
 */

const RELATIVE = join('.vscode', 'bookmarks.json');

export const bookmarksPath = (clone: Clone): string => join(clone.path, RELATIVE);

/** A lock older than this was left by a run that died; nothing in one sync takes a second. */
const STALE_LOCK_MS = 60_000;

const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * One clone's copy, classified.
 *
 * Two git checks come before the file is read, and both are about what a write would do to the
 * clone's BRANCH rather than to its bookmarks. A tracked copy is versioned per branch, so it is
 * never written -- the floor every editor artifact has. A copy git does NOT ignore would turn up
 * as an untracked file the first time this sync created one: this repo ignores `.vscode/*`, the
 * next one may not.
 */
const readCopy = (clone: Clone): BookmarkCopy => {
  const path = bookmarksPath(clone);
  if (git(clone.path, ['ls-files', '--error-unmatch', '--', RELATIVE]).ok) {
    return { clone: clone.name, kind: 'skip', why: `${RELATIVE} is tracked by git` };
  }
  if (!git(clone.path, ['check-ignore', '-q', '--', RELATIVE]).ok) {
    return { clone: clone.name, kind: 'skip', why: `git does not ignore ${RELATIVE}` };
  }
  if (!existsSync(path)) {
    // The extension deletes the file when a window's last bookmark goes, and the unlink moved
    // the directory's mtime: that is when this clone deleted everything.
    return { clone: clone.name, kind: 'absent', mtimeMs: mtimeOf(dirname(path)) };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { clone: clone.name, kind: 'skip', why: (error as Error).message };
  }
  const doc = parseBookmarks(text);
  // Neither merged nor written: writing would destroy what it holds, and leaving it out of the
  // merge while writing it would look like a deletion of all of it.
  if (typeof doc === 'string') return { clone: clone.name, kind: 'skip', why: doc };
  return { clone: clone.name, kind: 'file', doc, text, mtimeMs: mtimeOf(path) };
};

const readState = (hangar: Hangar): string | undefined => {
  try {
    return readFileSync(hangar.paths.vscodeBookmarksState, 'utf8');
  } catch {
    return undefined;
  }
};

/** Rename into place, so a run that dies half-way leaves the previous base rather than half of one. */
const writeState = (hangar: Hangar, text: string): void => {
  const path = hangar.paths.vscodeBookmarksState;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text, 'utf8');
  renameSync(`${path}.tmp`, path);
};

/** What the merge would do now, changing nothing. `undefined` when no VS Code editor is configured. */
export const previewVscodeBookmarks = (hangar: Hangar): BookmarkPlan | undefined => {
  if (!wantsWorkspaceFiles(hangar)) return undefined;
  const clones = discoverClones(hangar);
  return planBookmarkSync(parseSyncState(readState(hangar)), clones.map(readCopy));
};

/** Clone directories the state file remembers and the fleet no longer has. */
export const orphanedBookmarkStates = (hangar: Hangar): string[] => {
  const known = new Set(discoverClones(hangar).map((clone) => clone.name));
  return Object.keys(parseSyncState(readState(hangar)).clones).filter((name) => !known.has(name));
};

const withLock = (hangar: Hangar, body: () => void): boolean => {
  const lock = hangar.paths.vscodeBookmarksLock;
  mkdirSync(dirname(lock), { recursive: true });
  const take = (): boolean => {
    try {
      closeSync(openSync(lock, 'wx'));
      return true;
    } catch {
      return false;
    }
  };
  if (!take()) {
    if (Date.now() - mtimeOf(lock) < STALE_LOCK_MS) return false;
    unlinkSync(lock);
    if (!take()) return false;
  }
  try {
    body();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Gone already; nothing to release.
    }
  }
  return true;
};

const ACTION_LABEL: Readonly<Record<BookmarkAction, readonly [string, string]>> = {
  'in-sync': [pc.dim('in sync'), pc.dim('in sync')],
  write: [pc.green('rewritten'), pc.yellow('would rewrite')],
  create: [pc.green('created'), pc.yellow('would create')],
  delete: [pc.green('deleted'), pc.yellow('would delete')],
};

const printTable = (plan: BookmarkPlan, clones: readonly Clone[], dryRun: boolean): void => {
  const byName = new Map(clones.map((clone) => [clone.name, clone]));
  const label = (name: string): string => {
    const clone = byName.get(name);
    return clone === undefined ? name : cloneLabel(clone);
  };
  const why = new Map([...plan.stale, ...plan.skipped].map((s) => [s.clone, s.why]));
  table([
    ...plan.clones.map(({ clone, action }) => [
      label(clone),
      dryRun ? ACTION_LABEL[action][1] : ACTION_LABEL[action][0],
      plan.stale.some((s) => s.clone === clone) ? pc.yellow('change withheld') : '',
    ]),
    ...plan.skipped.map(({ clone }) => [label(clone), pc.red('skipped'), why.get(clone) ?? '']),
  ]);
};

export type BookmarksSyncOptions = {
  readonly dryRun?: boolean | undefined;
  /** `ide vscode sync`'s own section, with a row per clone; every other caller prints a summary. */
  readonly verbose?: boolean | undefined;
};

/**
 * Bring every clone's `.vscode/bookmarks.json` into step. Returns how many clones it wrote (or
 * would write), and never throws.
 */
export const syncVscodeBookmarks = (hangar: Hangar, opts: BookmarksSyncOptions = {}): number => {
  const dryRun = opts.dryRun === true;
  try {
    if (!wantsWorkspaceFiles(hangar)) return 0;
    let written = 0;
    const run = (): void => {
      const clones = discoverClones(hangar);
      const plan = planBookmarkSync(parseSyncState(readState(hangar)), clones.map(readCopy));
      if (opts.verbose === true) {
        heading('.vscode/bookmarks.json');
        printTable(plan, clones, dryRun);
      }
      if (!dryRun) {
        for (const { clone: name, action } of plan.clones) {
          const clone = clones.find((c) => c.name === name);
          if (clone === undefined || action === 'in-sync') continue;
          const path = bookmarksPath(clone);
          if (plan.text === undefined) unlinkSync(path);
          else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, plan.text, 'utf8');
          }
        }
        writeState(hangar, renderSyncState(plan.next));
      }
      written = plan.clones.filter((c) => c.action !== 'in-sync').length;
      for (const line of bookmarkSyncSummary(plan, dryRun)) note(line);
    };
    if (dryRun) run();
    else if (!withLock(hangar, run)) {
      note('VS Code bookmarks: another hangar command is syncing them right now — skipped');
    }
    return written;
  } catch (error) {
    warn(`VS Code bookmarks not synced: ${(error as Error).message}`);
    return 0;
  }
};

/**
 * Forget one clone's base -- `add-clone` and `remove-clone`, for the same reason they drop a
 * colour assignment. `add-clone` reuses free indices, and a new clone inheriting the old one's
 * base would read as "the file is gone, so every bookmark was deleted" and empty the whole fleet.
 */
export const forgetCloneBookmarks = (hangar: Hangar, cloneName: string): boolean => {
  const text = readState(hangar);
  if (text === undefined) return false;
  const state = parseSyncState(text);
  if (!(cloneName in state.clones)) return false;
  const clones = Object.fromEntries(
    Object.entries(state.clones).filter(([name]) => name !== cloneName),
  );
  try {
    writeState(hangar, renderSyncState({ ...state, clones }));
    return true;
  } catch (error) {
    warn(`${tildify(hangar.paths.vscodeBookmarksState)}: ${(error as Error).message}`);
    return false;
  }
};
