import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_SYNC_STATE,
  bookmarkKey,
  bookmarkSyncSummary,
  parseBookmarks,
  parseSyncState,
  planBookmarkSync,
  renderBookmarks,
  renderSyncState,
  type BookmarkCopy,
  type BookmarkPlan,
  type BookmarkSyncState,
  type BookmarksDoc,
} from '../src/editor/vscode-bookmarks.ts';

/**
 * The three-way merge `ide vscode sync` and its triggers run over every clone's
 * `.vscode/bookmarks.json`.
 *
 * Properties only. What matters is that a create, an update AND a delete made in one clone reach
 * every other, that the extension deleting an emptied file reads as a deletion, that a second run
 * changes nothing, and that a window older than the last sync cannot undo the other clones.
 */

type Marks = Record<string, [number, string?][]>;

/** As the extension writes it: `JSON.stringify(…, null, '\t')`. */
const doc = (files: Marks): BookmarksDoc => ({
  files: Object.entries(files).map(([path, marks]) => ({
    path,
    bookmarks: marks.map(([line, label]) => ({ line, column: 0, label: label ?? '' })),
  })),
});

let clock = 0;
const file = (clone: string, files: Marks, mtimeMs = ++clock): BookmarkCopy => {
  const d = doc(files);
  return { clone, kind: 'file', doc: d, text: renderBookmarks(d), mtimeMs };
};
const absent = (clone: string, mtimeMs = ++clock): BookmarkCopy => ({
  clone,
  kind: 'absent',
  mtimeMs,
});

const keys = (d: BookmarksDoc): Set<string> =>
  new Set(d.files.flatMap((f) => f.bookmarks.map((b) => bookmarkKey(f.path, b.line))));

const labelOf = (d: BookmarksDoc, path: string, line: number): unknown =>
  d.files.find((f) => f.path === path)?.bookmarks.find((b) => b.line === line)?.['label'];

/** What every clone holds after a plan is carried out, as the next run will read it. */
const after = (plan: BookmarkPlan, clones: readonly string[]): BookmarkCopy[] =>
  clones.map((clone) => (plan.text === undefined ? absent(clone, 0) : copyOf(clone, plan)));
const copyOf = (clone: string, plan: BookmarkPlan): BookmarkCopy => ({
  clone,
  kind: 'file',
  doc: plan.merged,
  text: plan.text ?? '',
  mtimeMs: 0,
});

/** A fleet of three in step on `start`, as a first sync leaves it. */
const inStep = (start: Marks): { state: BookmarkSyncState; plan: BookmarkPlan } => {
  const plan = planBookmarkSync(EMPTY_SYNC_STATE, [
    file('a', start),
    file('b', start),
    file('c', start),
  ]);
  return { state: plan.next, plan };
};

const START: Marks = { 'src/x.ts': [[3], [10, 'entry']], 'src/y.ts': [[1]] };

test('a first sync is a union of every copy', () => {
  const plan = planBookmarkSync(EMPTY_SYNC_STATE, [
    file('a', { 'src/x.ts': [[3]] }),
    file('b', { 'src/y.ts': [[7]] }),
    absent('c'),
  ]);
  assert.deepEqual(keys(plan.merged), new Set(['src/x.ts:3', 'src/y.ts:7']));
  assert.deepEqual(
    plan.clones.map((c) => c.action),
    ['write', 'write', 'create'],
  );
});

test('a bookmark created in one clone reaches every clone', () => {
  const { state } = inStep(START);
  const plan = planBookmarkSync(state, [
    file('a', { ...START, 'src/z.ts': [[5]] }),
    file('b', START),
    file('c', START),
  ]);
  assert.ok(keys(plan.merged).has('src/z.ts:5'));
  assert.deepEqual(
    plan.clones.map((c) => c.action),
    ['in-sync', 'write', 'write'],
  );
});

test('a bookmark deleted in one clone is deleted in every clone', () => {
  const { state } = inStep(START);
  const plan = planBookmarkSync(state, [
    file('a', START),
    file('b', { 'src/x.ts': [[10, 'entry']], 'src/y.ts': [[1]] }),
    file('c', START),
  ]);
  assert.ok(!keys(plan.merged).has('src/x.ts:3'));
  assert.deepEqual(plan.changes.deleted, ['src/x.ts:3']);
});

test('a bookmark relabelled in one clone is relabelled in every clone', () => {
  const { state } = inStep(START);
  const plan = planBookmarkSync(state, [
    file('a', START),
    file('b', START),
    file('c', { 'src/x.ts': [[3], [10, 'renamed']], 'src/y.ts': [[1]] }),
  ]);
  assert.equal(labelOf(plan.merged, 'src/x.ts', 10), 'renamed');
  assert.deepEqual(plan.changes.updated, ['src/x.ts:10']);
});

test('a missing file with a base is a clone that deleted everything, as the extension does', () => {
  const { state } = inStep(START);
  const plan = planBookmarkSync(state, [file('a', START), absent('b'), file('c', START)]);
  assert.equal(plan.text, undefined);
  assert.deepEqual(
    plan.clones.map((c) => c.action),
    ['delete', 'in-sync', 'delete'],
  );
});

test('a missing file with no base deletes nothing', () => {
  const { state } = inStep(START);
  const plan = planBookmarkSync(state, [file('a', START), file('b', START), absent('new')]);
  assert.deepEqual(keys(plan.merged), keys(doc(START)));
  assert.deepEqual(plan.clones.at(-1)?.action, 'create');
});

test('the clone that changed most recently wins a delete-vs-update conflict', () => {
  const { state } = inStep(START);
  const relabel: Marks = { 'src/x.ts': [[3], [10, 'renamed']], 'src/y.ts': [[1]] };
  const remove: Marks = { 'src/x.ts': [[3]], 'src/y.ts': [[1]] };
  const deleteWins = planBookmarkSync(state, [file('a', relabel, 1), file('b', remove, 2)]);
  assert.ok(!keys(deleteWins.merged).has('src/x.ts:10'));
  const updateWins = planBookmarkSync(state, [file('a', relabel, 2), file('b', remove, 1)]);
  assert.equal(labelOf(updateWins.merged, 'src/x.ts', 10), 'renamed');
});

test('a second run over the result changes nothing and writes nothing', () => {
  const { state } = inStep(START);
  const first = planBookmarkSync(state, [
    file('a', { ...START, 'src/z.ts': [[5]] }),
    file('b', { 'src/y.ts': [[1]] }),
    absent('c'),
  ]);
  const second = planBookmarkSync(first.next, after(first, ['a', 'b', 'c']));
  assert.equal(second.text, first.text);
  assert.ok(second.clones.every((c) => c.action === 'in-sync'));
  assert.deepEqual(second.changes, { created: [], updated: [], deleted: [] });
});

test('a clone with nothing to gain is left byte-identical', () => {
  const only = file('a', START);
  const plan = planBookmarkSync(EMPTY_SYNC_STATE, [only]);
  assert.equal(plan.text, only.kind === 'file' ? only.text : '');
  assert.equal(plan.clones[0]?.action, 'in-sync');
});

test('a window older than the last sync cannot bring back what that sync deleted', () => {
  const { state } = inStep(START);
  // b deletes x:3; a and c are rewritten without it.
  const deletion = planBookmarkSync(state, [
    file('a', START),
    file('b', { 'src/x.ts': [[10, 'entry']], 'src/y.ts': [[1]] }),
    file('c', START),
  ]);
  // a's window was open throughout: its next toggle writes its OLD set back, plus y:9.
  const stale = planBookmarkSync(deletion.next, [
    file('a', { ...START, 'src/y.ts': [[1], [9]] }),
    copyOf('b', deletion),
    copyOf('c', deletion),
  ]);
  assert.ok(!keys(stale.merged).has('src/x.ts:3'), 'the deletion stands');
  assert.deepEqual(
    stale.stale.map((s) => s.clone),
    ['a'],
  );
  assert.equal(stale.clones.find((c) => c.clone === 'a')?.action, 'write');
  // Told once: re-adding that line after a reload is a real create the next time.
  const readded = planBookmarkSync(stale.next, [
    file('a', { 'src/x.ts': [[3], [10, 'entry']], 'src/y.ts': [[1]] }),
    copyOf('b', stale),
    copyOf('c', stale),
  ]);
  assert.deepEqual(readded.stale, []);
  assert.ok(keys(readded.merged).has('src/x.ts:3'));
});

test('a skipped copy is neither read nor written, and keeps its base', () => {
  const { state } = inStep(START);
  const plan = planBookmarkSync(state, [
    file('a', { 'src/q.ts': [[1]] }),
    { clone: 'b', kind: 'skip', why: 'not JSON' },
  ]);
  assert.ok(!plan.clones.some((c) => c.clone === 'b'));
  assert.deepEqual(plan.next.clones['b'], state.clones['b']);
  assert.ok(bookmarkSyncSummary(plan, false).some((line) => line.includes('not JSON')));
});

test('keys the extension may add are carried, not dropped', () => {
  const d = { files: [{ path: 'x.ts', bookmarks: [{ line: 1, extra: true }], uri: 'u' }], v: 2 };
  const text = JSON.stringify(d, null, '\t');
  const plan = planBookmarkSync(EMPTY_SYNC_STATE, [
    { clone: 'a', kind: 'file', doc: d as unknown as BookmarksDoc, text, mtimeMs: 1 },
  ]);
  assert.equal(plan.text, text);
});

test('the state file round-trips, and an unreadable one degrades to a union', () => {
  const { state } = inStep(START);
  assert.deepEqual(parseSyncState(renderSyncState(state)), state);
  assert.deepEqual(parseSyncState('{'), EMPTY_SYNC_STATE);
  assert.deepEqual(parseSyncState(undefined), EMPTY_SYNC_STATE);
});

test('nothing to report means nothing printed', () => {
  const { plan } = inStep(START);
  assert.deepEqual(bookmarkSyncSummary(plan, false), []);
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
});
