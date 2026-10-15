/**
 * `.vscode/bookmarks.json`, the file the alefragnani.Bookmarks extension writes when
 * `bookmarks.saveBookmarksInProject` is on -- brought into step across the clones by a THREE-WAY
 * merge, so a bookmark created, changed or deleted in one clone is created, changed or deleted
 * in every other.
 *
 * The third way is the base: what Hangar last left in each clone, kept in the hangar's
 * `.hangar/vscode-bookmarks.json`. A copy compared only with its siblings cannot tell "deleted
 * here" from "never had it", so a union spreads additions and resurrects every deletion; a copy
 * compared with its own base can. Everything in this file is pure; `vscode-bookmarks-sync.ts` is
 * the reading and writing.
 *
 * The file is `{"files":[{"path":<clone-relative>,"bookmarks":[{line,column,label?}]}]}`,
 * tab-indented by the extension's own `JSON.stringify(…, null, '\t')` with no trailing newline.
 * Paths are relative to the workspace folder, which is the clone root, so the file is portable
 * between clones as it stands.
 */

type Json = Record<string, unknown>;

export type Bookmark = Json & { readonly line: number };

export type BookmarkedFile = Json & {
  readonly path: string;
  readonly bookmarks: readonly Bookmark[];
};

export type BookmarksDoc = Json & { readonly files: readonly BookmarkedFile[] };

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The parsed file, or why it is not one -- a copy that fails this is neither read nor written. */
export const parseBookmarks = (text: string): BookmarksDoc | string => {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return `not JSON: ${(error as Error).message}`;
  }
  if (!isObject(doc) || !Array.isArray(doc['files'])) return 'no `files` array';
  for (const file of doc['files'] as unknown[]) {
    if (!isObject(file) || typeof file['path'] !== 'string' || !Array.isArray(file['bookmarks'])) {
      return 'a `files` entry without a `path` string and a `bookmarks` array';
    }
    for (const mark of file['bookmarks'] as unknown[]) {
      if (!isObject(mark) || typeof mark['line'] !== 'number') {
        return `a bookmark in ${file['path']} without a numeric \`line\``;
      }
    }
  }
  return doc as BookmarksDoc;
};

export const EMPTY_BOOKMARKS: BookmarksDoc = { files: [] };

/**
 * A bookmark's identity: its file and its line. The extension toggles per line, so two
 * bookmarks on one line cannot exist, and everything else about one -- label, column, any key a
 * later version adds -- is a property of it that an update changes.
 */
export const bookmarkKey = (path: string, line: number): string => `${path}:${String(line)}`;

type Entry = { readonly path: string; readonly mark: Bookmark };

/** Every bookmark of a document, keyed, in document order. */
const entries = (doc: BookmarksDoc): Map<string, Entry> => {
  const out = new Map<string, Entry>();
  for (const file of doc.files) {
    for (const mark of file.bookmarks)
      out.set(bookmarkKey(file.path, mark.line), { path: file.path, mark });
  }
  return out;
};

/** Key order of a JSON value is part of its identity here: the extension writes it stably. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** As the extension writes it, so a copy Hangar has nothing to add to compares byte-equal. */
export const renderBookmarks = (doc: BookmarksDoc): string => JSON.stringify(doc, null, '\t');

export type BookmarkDiff = {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly deleted: readonly string[];
};

/** What `current` did relative to `base`, by key. */
export const diffBookmarks = (base: BookmarksDoc, current: BookmarksDoc): BookmarkDiff => {
  const before = entries(base);
  const after = entries(current);
  const created: string[] = [];
  const updated: string[] = [];
  for (const [key, entry] of after) {
    const was = before.get(key);
    if (was === undefined) created.push(key);
    else if (!same(was.mark, entry.mark)) updated.push(key);
  }
  const deleted = [...before.keys()].filter((key) => !after.has(key));
  return { created, updated, deleted };
};

/** What Hangar remembers about one clone: what it last left there, and how that differed. */
export type CloneBookmarkState = {
  /** Exactly what the last sync left in the clone -- the base its next change is diffed against. */
  readonly base: BookmarksDoc;
  /** Keys a sync took OUT of the clone that its window may still hold. */
  readonly removed: readonly string[];
};

export type BookmarkSyncState = {
  /** The last merge result: what every clone in step holds. */
  readonly merged: BookmarksDoc;
  /** Keyed by clone directory name. */
  readonly clones: Readonly<Record<string, CloneBookmarkState>>;
};

export const EMPTY_SYNC_STATE: BookmarkSyncState = { merged: EMPTY_BOOKMARKS, clones: {} };

/** The state file, or the empty state when it is missing or unreadable -- which degrades to a union. */
export const parseSyncState = (text: string | undefined): BookmarkSyncState => {
  if (text === undefined) return EMPTY_SYNC_STATE;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_SYNC_STATE;
  }
  if (!isObject(raw) || !isObject(raw['clones'])) return EMPTY_SYNC_STATE;
  const merged = parseBookmarks(JSON.stringify(raw['merged']));
  if (typeof merged === 'string') return EMPTY_SYNC_STATE;
  const clones: Record<string, CloneBookmarkState> = {};
  for (const [name, value] of Object.entries(raw['clones'])) {
    if (!isObject(value)) continue;
    const base = parseBookmarks(JSON.stringify(value['base']));
    if (typeof base === 'string') continue;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    clones[name] = { base, removed: strings(value['removed']) };
  }
  return { merged, clones };
};

export const renderSyncState = (state: BookmarkSyncState): string =>
  `${JSON.stringify(state, null, 2)}\n`;

/**
 * One clone's copy, as the sync found it.
 *
 * `absent` carries a time too: the extension DELETES the file when a window's last bookmark goes,
 * so a missing file with a base is a clone that deleted everything, and the caller passes the
 * `.vscode/` directory's mtime -- which the unlink moved -- for it to compete on.
 */
export type BookmarkCopy =
  | {
      readonly clone: string;
      readonly kind: 'file';
      readonly doc: BookmarksDoc;
      readonly text: string;
      readonly mtimeMs: number;
    }
  | { readonly clone: string; readonly kind: 'absent'; readonly mtimeMs: number }
  /** Neither read nor written: unparseable, tracked by git, or not ignored by it. */
  | { readonly clone: string; readonly kind: 'skip'; readonly why: string };

export type BookmarkAction = 'in-sync' | 'write' | 'create' | 'delete';

export type BookmarkPlan = {
  readonly merged: BookmarksDoc;
  /** What every clone gets: the rendered merge, or `undefined` for "no file", as the extension does. */
  readonly text: string | undefined;
  readonly clones: readonly { readonly clone: string; readonly action: BookmarkAction }[];
  /** Clones whose change was WITHHELD because their window looks older than the last sync. */
  readonly stale: readonly { readonly clone: string; readonly why: string }[];
  readonly skipped: readonly { readonly clone: string; readonly why: string }[];
  /** What this merge changed relative to the last one. */
  readonly changes: BookmarkDiff;
  readonly next: BookmarkSyncState;
};

const docOf = (copy: BookmarkCopy): BookmarksDoc =>
  copy.kind === 'file' ? copy.doc : EMPTY_BOOKMARKS;

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/**
 * Why this clone's window looks like it was open across the last sync, or `undefined`.
 *
 * The extension reads the file once, when its window starts, and rewrites the whole of it from
 * memory on every change. A window open across a sync therefore still holds the OLD set, and its
 * next toggle writes that set back: against its base that reads as deleting everything the sync
 * brought in and re-creating everything it took out. Applied, it would undo every other clone's
 * work, so the clone's change is withheld instead -- it is still rewritten to the merge, and the
 * report says to reload first.
 *
 * Only the second half is a usable signature. A copy that brings back exactly the bookmark the
 * sync took out is a window that never saw the deletion. A copy MISSING what the sync brought in
 * is not evidence of anything: deliberately deleting the one bookmark that just arrived from
 * another clone writes the very same file, and that is the deletion this merge exists to spread.
 */
const staleness = (copy: BookmarkCopy, known: CloneBookmarkState): string | undefined => {
  const current = entries(docOf(copy));
  const back = known.removed.filter((key) => current.has(key));
  return back.length === 0
    ? undefined
    : `brings back ${plural(back.length, 'bookmark')} the last sync removed (${back.join(', ')})`;
};

/**
 * The three-way merge.
 *
 * Every clone's change is its own copy diffed against its own base, applied onto the last merge
 * in ascending mtime -- so where two clones touched one bookmark (one deleted it, one relabelled
 * it), the clone that changed most recently wins. A clone with no base yet (its first sync, or a
 * state file that was lost) can only contribute creates and updates: without a base, a missing
 * bookmark is not evidence of a deletion. That is also what a first sync is: a union.
 *
 * The merge keeps the last merge's order and appends what is new, so a clone Hangar has nothing
 * to add to compares byte-equal, is not written, and its window is not told to reload for
 * nothing.
 */
export const planBookmarkSync = (
  state: BookmarkSyncState,
  copies: readonly BookmarkCopy[],
): BookmarkPlan => {
  const skipped = copies.flatMap((c) =>
    c.kind === 'skip' ? [{ clone: c.clone, why: c.why }] : [],
  );
  const live = copies.filter((c) => c.kind !== 'skip');

  const result = entries(state.merged);
  const stale: { clone: string; why: string }[] = [];
  let top: Json = state.merged;
  const fileProps = new Map<string, Json>();
  for (const file of state.merged.files) fileProps.set(file.path, file);

  for (const copy of [...live].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    const known = state.clones[copy.clone];
    const doc = docOf(copy);
    if (known === undefined) {
      if (copy.kind !== 'file') continue;
      for (const [key, entry] of entries(doc)) result.set(key, entry);
    } else {
      if (same(doc, known.base)) continue;
      const why = staleness(copy, known);
      if (why !== undefined) {
        stale.push({ clone: copy.clone, why });
        continue;
      }
      const delta = diffBookmarks(known.base, doc);
      const now = entries(doc);
      for (const key of [...delta.created, ...delta.updated]) {
        const entry = now.get(key);
        if (entry !== undefined) result.set(key, entry);
      }
      for (const key of delta.deleted) result.delete(key);
    }
    if (copy.kind === 'file') {
      top = copy.doc;
      for (const file of copy.doc.files) fileProps.set(file.path, file);
    }
  }

  // Grouped by file, files and bookmarks both in first-seen order.
  const byPath = new Map<string, Bookmark[]>();
  for (const { path, mark } of result.values()) {
    const marks = byPath.get(path) ?? [];
    marks.push(mark);
    byPath.set(path, marks);
  }
  const merged: BookmarksDoc = {
    ...top,
    files: [...byPath].map(([path, bookmarks]) => ({ ...fileProps.get(path), path, bookmarks })),
  };
  const text = merged.files.length === 0 ? undefined : renderBookmarks(merged);

  const mergedKeys = entries(merged);
  const staleNames = new Set(stale.map((s) => s.clone));
  const clones: { clone: string; action: BookmarkAction }[] = [];
  const nextClones: Record<string, CloneBookmarkState> = {};
  for (const copy of live) {
    const action: BookmarkAction =
      copy.kind === 'file'
        ? text === undefined
          ? 'delete'
          : copy.text === text
            ? 'in-sync'
            : 'write'
        : text === undefined
          ? 'in-sync'
          : 'create';
    clones.push({ clone: copy.clone, action });

    /*
     * What the clone's WINDOW may still hold that its file will not. A copy untouched since the
     * last sync has not proved its window reloaded, so what that sync took out stays pending.
     *
     * A clone just reported stale starts clean instead: it has been told once, and carrying the
     * evidence forward would withhold a bookmark deliberately re-added on that line forever.
     */
    const current = entries(docOf(copy));
    const known = state.clones[copy.clone];
    const untouched = known !== undefined && same(docOf(copy), known.base);
    const removed = new Set(untouched ? known.removed : []);
    if (!staleNames.has(copy.clone)) {
      for (const key of current.keys()) if (!mergedKeys.has(key)) removed.add(key);
    }
    nextClones[copy.clone] = {
      base: merged,
      removed: [...removed].filter((key) => !mergedKeys.has(key)),
    };
  }
  // A skipped clone keeps what it had: it was neither read nor written.
  for (const { clone } of skipped) {
    const known = state.clones[clone];
    if (known !== undefined) nextClones[clone] = known;
  }

  return {
    merged,
    text,
    clones,
    stale,
    skipped,
    changes: diffBookmarks(state.merged, merged),
    next: { merged, clones: nextClones },
  };
};

/** Clones that will be written (or would be, under `-n`). */
export const touchedClones = (plan: BookmarkPlan): string[] =>
  plan.clones.filter((c) => c.action !== 'in-sync').map((c) => c.clone);

/**
 * The one-paragraph report every trigger prints -- empty when there is nothing to say, so
 * `hangar open` stays quiet on the common run.
 */
export const bookmarkSyncSummary = (plan: BookmarkPlan, dryRun: boolean): string[] => {
  const lines: string[] = [];
  const touched = touchedClones(plan);
  if (touched.length > 0) {
    const { created, updated, deleted } = plan.changes;
    const what = [
      created.length > 0 ? `${String(created.length)} created` : '',
      updated.length > 0 ? `${String(updated.length)} updated` : '',
      deleted.length > 0 ? `${String(deleted.length)} deleted` : '',
    ]
      .filter((part) => part !== '')
      .join(', ');
    lines.push(
      `VS Code bookmarks${what === '' ? '' : `: ${what}`} — ${dryRun ? 'would write' : 'wrote'} ${touched.join(', ')}`,
    );
    if (!dryRun) {
      lines.push(
        "reload those clones' VS Code windows (Developer: Reload Window) before touching a bookmark there",
      );
    }
  }
  for (const { clone, why } of plan.stale) {
    lines.push(`${clone}: change withheld — its window ${why}; reload it, then redo the change`);
  }
  for (const { clone, why } of plan.skipped) lines.push(`${clone}: bookmarks skipped — ${why}`);
  return lines;
};
