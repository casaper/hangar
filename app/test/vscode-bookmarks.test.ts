import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mergeBookmarks,
  mergeBookmarkTexts,
  parseBookmarks,
  type BookmarksDoc,
} from '../src/editor/vscode-bookmarks.ts';

/**
 * The union `ide vscode sync` writes into every clone's `.vscode/bookmarks.json`.
 *
 * Properties only. What matters is that no clone's bookmark is lost, that a second sync changes
 * nothing, and that a clone with nothing to gain is left byte-identical -- otherwise every run
 * reports every clone rewritten and a window that needed no reload is told to reload.
 */

/** As the extension writes it: `JSON.stringify(…, null, '\t')`. */
const file = (files: Record<string, [number, string?][]>): string =>
  JSON.stringify(
    {
      files: Object.entries(files).map(([path, marks]) => ({
        path,
        bookmarks: marks.map(([line, label]) => ({ line, column: 0, label: label ?? '' })),
      })),
    },
    null,
    '\t',
  );

const fileIn = (text: string, path: string) => {
  const found = (parseBookmarks(text) as BookmarksDoc).files.find((f) => f.path === path);
  assert.ok(found, path);
  return found;
};

const marks = (text: string): Set<string> => {
  const doc = parseBookmarks(text) as BookmarksDoc;
  return new Set(doc.files.flatMap((f) => f.bookmarks.map((b) => `${f.path}:${String(b.line)}`)));
};

const a = file({ 'src/a.ts': [[3], [10, 'entry']], 'src/b.ts': [[1]] });
const b = file({ 'src/a.ts': [[10, 'renamed'], [42]], 'src/c.ts': [[7]] });
const c = file({ 'src/b.ts': [[1], [2]] });

test('every bookmark of every copy is in the union', () => {
  const merged = marks(mergeBookmarkTexts([a, b, c]));
  for (const copy of [a, b, c]) for (const mark of marks(copy)) assert.ok(merged.has(mark), mark);
});

test('a bookmark on the same file and line appears once', () => {
  const lines = fileIn(mergeBookmarkTexts([a, b]), 'src/a.ts').bookmarks.map((m) => m.line);
  assert.deepEqual(lines, [...new Set(lines)]);
});

test('the later copy wins a disagreement about one bookmark', () => {
  const mark = fileIn(mergeBookmarkTexts([a, b]), 'src/a.ts').bookmarks.find((m) => m.line === 10);
  assert.equal(mark?.['label'], 'renamed');
});

test('a second sync changes nothing', () => {
  const merged = mergeBookmarkTexts([a, b, c]);
  assert.equal(mergeBookmarkTexts([merged, merged]), merged);
  for (const copy of [a, b, c])
    assert.deepEqual(marks(mergeBookmarkTexts([merged, copy])), marks(merged));
});

test('the order the clones are read in does not change which bookmarks survive', () => {
  assert.deepEqual(marks(mergeBookmarkTexts([a, b, c])), marks(mergeBookmarkTexts([c, b, a])));
});

test('one copy merges to itself byte for byte, so a clone with nothing to gain stays in sync', () => {
  for (const copy of [a, b, c]) assert.equal(mergeBookmarkTexts([copy]), copy);
});

test('keys the extension may add are carried, not dropped', () => {
  const doc = { files: [{ path: 'x.ts', bookmarks: [{ line: 1, extra: true }], uri: 'u' }], v: 2 };
  assert.deepEqual(JSON.parse(mergeBookmarks([doc as unknown as BookmarksDoc])), doc);
});

test('a copy that is not a bookmarks file is refused, with a reason', () => {
  for (const bad of [
    '{',
    '[]',
    '{"files":{}}',
    '{"files":[{"path":1,"bookmarks":[]}]}',
    '{"files":[{"path":"x","bookmarks":[{"line":"3"}]}]}',
  ]) {
    assert.equal(typeof parseBookmarks(bad), 'string', bad);
  }
  assert.throws(() => mergeBookmarkTexts([a, '{']));
});
