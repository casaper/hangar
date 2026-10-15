/**
 * `.vscode/bookmarks.json`, the file the alefragnani.Bookmarks extension writes when
 * `bookmarks.saveBookmarksInProject` is on -- merged across the clones rather than copied.
 *
 * Copying would be wrong for this file in a way it is not for `settings.json`: bookmarks are
 * each clone's own working state, so newest-wins would replace every other clone's set with one
 * clone's. A union spreads additions and can never spread a deletion, which is the trade the
 * extension forces: it keeps no history, so a bookmark absent from one copy is indistinguishable
 * from one that copy never had.
 *
 * The file is `{"files":[{"path":<clone-relative>,"bookmarks":[{line,column,label?}]}]}`,
 * tab-indented by the extension's own `JSON.stringify(…, null, '\t')`. Paths are relative to the
 * workspace folder, which is the clone root, so the file is portable between clones as it stands.
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

/**
 * The union of every copy, as the extension would serialise it.
 *
 * A bookmark is identified by file and line -- the extension toggles per line -- and where two
 * copies disagree about one (its label, its column) the LATER copy wins, so the caller orders
 * them oldest first. Order is first-seen rather than sorted, so the merge of one copy is that
 * copy byte for byte: a clone the sync has nothing to add to reads as in sync, not rewritten.
 *
 * Every input must already have passed `parseBookmarks`; one that has not is the caller's to
 * report, never to drop silently here.
 */
export const mergeBookmarks = (docs: readonly BookmarksDoc[]): string => {
  const files = new Map<string, { file: BookmarkedFile; marks: Map<number, Bookmark> }>();
  for (const doc of docs) {
    for (const file of doc.files) {
      const entry = files.get(file.path) ?? { file, marks: new Map<number, Bookmark>() };
      entry.file = file;
      for (const mark of file.bookmarks) entry.marks.set(mark.line, mark);
      files.set(file.path, entry);
    }
  }
  const merged: BookmarksDoc = {
    ...docs.at(-1),
    files: [...files.values()].map(({ file, marks }) => ({
      ...file,
      bookmarks: [...marks.values()],
    })),
  };
  return JSON.stringify(merged, null, '\t');
};

/** `mergeBookmarks` over raw file texts, for the editor seam; a text that does not parse throws. */
export const mergeBookmarkTexts = (texts: readonly string[]): string =>
  mergeBookmarks(
    texts.map((text) => {
      const doc = parseBookmarks(text);
      if (typeof doc === 'string') throw new Error(`unmergeable bookmarks file: ${doc}`);
      return doc;
    }),
  );
