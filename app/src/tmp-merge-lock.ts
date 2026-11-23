import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * One `tmp merge` at a time, hangar-wide.
 *
 * Every clone runs `tmp merge --quiet` from `SessionEnd`, so `reload`, `down` or closing several
 * clones starts several at once over ONE store. Nothing in the merge survives that: two
 * `jdupes -L` runs each rename a duplicate aside while they link it, and the other then finds the
 * path missing -- which jdupes reports as "link target is a read-only file", because it checks
 * `access(W_OK)` and never looks at errno. The sets it was halfway through are left as two linked
 * groups that are never linked to each other.
 *
 * The holder's pid is the whole lock, and a lock whose pid is gone is stale. An age rule cannot
 * work: a merge's length grows with the store, so any fixed age either breaks a live lock or
 * keeps waiting on a dead one.
 */

/** How long a lock file with no pid in it yet is taken to be mid-creation. */
const UNWRITTEN_GRACE_MS = 5_000;

export type LockVerdict = 'take' | 'wait' | 'stale';

/**
 * What to do about the lock file's current content.
 *
 * `undefined` is no lock file at all. Content that is not a pid is held while it is young -- the
 * holder creates the file and writes its pid in two steps -- and stale after that, because a run
 * killed between the two leaves one that nothing would ever clear.
 */
export const lockVerdict = (
  content: string | undefined,
  ageMs: number,
  alive: (pid: number) => boolean,
): LockVerdict => {
  if (content === undefined) return 'take';
  const trimmed = content.trim();
  if (!/^\d+$/.test(trimmed)) return ageMs < UNWRITTEN_GRACE_MS ? 'wait' : 'stale';
  return alive(Number(trimmed)) ? 'wait' : 'stale';
};

const ageOf = (path: string): number => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

const readLock = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

export type LockAttempt =
  | { readonly taken: true; readonly release: () => void }
  | { readonly taken: false; readonly holder: string };

/**
 * Remove the stale lock that was JUDGED, and only that one.
 *
 * Compare-then-remove was two steps, and two waiters could both judge one dead lock stale: A
 * removed it and took its own, then B -- its comparison already passed -- removed A's live lock
 * and took the lock too, so two merges ran at once, which is the damage this file exists to
 * prevent. A rename is atomic, so exactly one waiter moves the file aside; and if what it moved
 * is not the file it judged, it was a FRESH lock, which is linked straight back.
 */
export const clearStale = (path: string, judged: string | undefined, pid: number): void => {
  const grave = `${path}.stale-${String(pid)}`;
  try {
    renameSync(path, grave);
  } catch {
    return; // Somebody else moved it first; the next attempt reads what is there now.
  }
  if (readLock(grave) !== judged) {
    try {
      linkSync(grave, path);
    } catch {
      // A third run took the name meanwhile. Nothing better to do than leave theirs.
    }
  }
  rmSync(grave, { force: true });
};

/**
 * One attempt to take the lock: created exclusively, so two runs cannot both win, and a stale one
 * is removed and retried once. `release` removes the file only while it still names `pid`.
 */
export const tryTakeLock = (
  path: string,
  pid: number,
  alive: (pid: number) => boolean,
): LockAttempt => {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${String(pid)}\n`);
      } finally {
        closeSync(fd);
      }
      return {
        taken: true,
        release: () => {
          if (readLock(path)?.trim() === String(pid)) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const content = readLock(path);
    // `take` here means it went between the failed open and this read: the holder just finished.
    const verdict = lockVerdict(content, ageOf(path), alive);
    if (verdict === 'wait') return { taken: false, holder: content?.trim() ?? '' };
    if (verdict === 'stale') clearStale(path, content, pid);
  }
  return { taken: false, holder: readLock(path)?.trim() ?? '' };
};
