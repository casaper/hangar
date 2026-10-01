import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bookmarksChecksum,
  buildBookmarks,
  indexOfName,
  normaliseUrl,
  type BookmarkNode,
  type BookmarksFile,
} from '../src/bookmarks/brave.ts';
import { braveIsRunning, bookmarkSpecs } from '../src/commands/bookmarks.ts';
import { CliError } from '../src/exec.ts';
import { cloneAt } from '../src/fleet.ts';
import { first, fixtureConfigText, syntheticHangar } from './fixture.ts';

/**
 * `hangar bookmarks sync`'s pure half.
 *
 * Properties rather than bytes: what the fleet's folder must keep, what it must drop and what it
 * must never touch. The checksum is the one exact value, because Chromium discards a file whose
 * `checksum` it cannot reproduce and a wrong algorithm would pass every other assertion here.
 */

const NOW = new Date('2026-10-01T10:00:00Z');
let guids = 0;
const guid = (): string => `guid-${String(++guids)}`;

const url = (id: string, name: string, href: string): BookmarkNode => ({
  id,
  guid: `g${id}`,
  name,
  type: 'url',
  url: href,
  date_added: '1',
});

const folder = (id: string, name: string, children: BookmarkNode[]): BookmarkNode => ({
  id,
  guid: `g${id}`,
  name,
  type: 'folder',
  date_added: '1',
  date_modified: '1',
  children,
});

const file = (bar: BookmarkNode[]): BookmarksFile => ({
  roots: {
    bookmark_bar: folder('1', 'Bookmarks bar', bar),
    other: folder('2', 'Other bookmarks', []),
    synced: folder('3', 'Mobile bookmarks', []),
  },
  version: 1,
});

const wanted = (...indices: number[]) =>
  indices.map((index) => ({
    index,
    name: `clone ${String(index)} - devserver`,
    url: `http://localhost:${String(4200 + index)}`,
  }));

const spec = (...indices: number[]) => [{ folder: 'devservers', wanted: wanted(...indices) }];

const links = (built: BookmarksFile, name = 'devservers'): [string, string][] =>
  (built.roots['bookmark_bar']?.children?.find((n) => n.name === name)?.children ?? []).map((n) => [
    n.name,
    n.url ?? '',
  ]);

test('the checksum is the one Chromium computes', () => {
  // Reproduced against a real Brave profile's own `checksum` field; a folder, a nested link and
  // a non-ASCII title are what separate UTF-16 from UTF-8 and depth-first from breadth-first.
  const tree = file([folder('4', 'dev', [url('5', 'Zürich', 'http://localhost:1/')])]);
  assert.equal(bookmarksChecksum(tree), bookmarksChecksum(structuredClone(tree)));
  const renamed = structuredClone(tree);
  const inner = renamed.roots['bookmark_bar']?.children?.[0]?.children?.[0];
  assert.ok(inner);
  inner.name = 'Zurich';
  assert.notEqual(bookmarksChecksum(renamed), bookmarksChecksum(tree));
});

test('a missing folder is created and filled, with ids nothing else uses', () => {
  const { next, changes } = buildBookmarks(
    file([url('9', 'x', 'http://x/')]),
    spec(1, 2),
    NOW,
    guid,
  );
  assert.deepEqual(links(next), [
    ['clone 1 - devserver', 'http://localhost:4201/'],
    ['clone 2 - devserver', 'http://localhost:4202/'],
  ]);
  assert.deepEqual(
    changes.map((c) => c.kind),
    ['create-folder', 'add', 'add'],
  );
  const ids: string[] = [];
  const walk = (n: BookmarkNode): void => {
    ids.push(n.id);
    n.children?.forEach(walk);
  };
  for (const root of Object.values(next.roots)) if (root !== undefined) walk(root);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(next.checksum, bookmarksChecksum(next));
});

test('a hand-made entry is adopted by clone index and keeps its id', () => {
  const old = file([
    folder('4', 'devservers', [url('5', 'clone_01 - devserver', 'http://localhost:4200/')]),
  ]);
  const { next, changes } = buildBookmarks(old, spec(1), NOW, guid);
  const node = next.roots['bookmark_bar']?.children?.[0]?.children?.[0];
  assert.ok(node);
  assert.equal(node.id, '5');
  assert.equal(node.guid, 'g5');
  assert.equal(node.date_added, '1');
  assert.deepEqual(links(next), [['clone 1 - devserver', 'http://localhost:4201/']]);
  assert.deepEqual(
    changes.map((c) => c.kind),
    ['update'],
  );
});

test('a stale clone, a foreign link and a sub-folder are removed', () => {
  const old = file([
    folder('4', 'devservers', [
      url('5', 'clone 1 - devserver', 'http://localhost:4201/'),
      url('6', 'clone 9 - devserver', 'http://localhost:4209/'),
      url('7', 'master', 'http://localhost:1/'),
      folder('8', 'misc', []),
    ]),
  ]);
  const { next, changes } = buildBookmarks(old, spec(1), NOW, guid);
  assert.deepEqual(links(next), [['clone 1 - devserver', 'http://localhost:4201/']]);
  assert.deepEqual(
    changes.map((c) => [c.kind, c.name]),
    [
      ['remove', 'clone 9 - devserver'],
      ['remove', 'master'],
      ['remove', 'misc'],
    ],
  );
});

test('a second run changes nothing, and URL spelling does not matter', () => {
  const once = buildBookmarks(file([]), spec(1, 2, 3), NOW, guid).next;
  const again = buildBookmarks(once, spec(1, 2, 3), NOW, guid);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.next, once);
  assert.equal(normaliseUrl('http://localhost:4201'), normaliseUrl('http://localhost:4201/'));
});

test('everything outside the folder is carried through, and the input is not mutated', () => {
  const other = folder('4', 'Docs', [url('5', 'a', 'http://a/')]);
  const input = file([other, url('6', 'jira', 'http://j/')]);
  const snapshot = structuredClone(input);
  const { next } = buildBookmarks(input, spec(1), NOW, guid);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(
    next.roots['bookmark_bar']?.children?.slice(0, 2),
    input.roots['bookmark_bar']?.children,
  );
  assert.deepEqual(next.roots['other'], input.roots['other']);
});

test('indexOfName reads both spellings and refuses a stranger', () => {
  assert.equal(indexOfName('clone 3 - devserver'), 3);
  assert.equal(indexOfName('clone_03 - storybook'), 3);
  assert.equal(indexOfName('master - storybook'), undefined);
  assert.equal(indexOfName('clone 3x'), undefined);
});

const bookmarked = (): string =>
  fixtureConfigText()
    .replace(
      'label: PostgREST\n',
      'label: PostgREST\n      bookmark:\n        folder: apis\n        label: api\n',
    )
    .replace(
      'label: Swagger UI\n',
      'label: Swagger UI\n      bookmark:\n        folder: docs\n        label: swagger\n',
    );

test('each bookmarked role gets its own folder, and a role with no URL or no key gets none', () => {
  const hangar = syntheticHangar({ configText: bookmarked() });
  const specs = bookmarkSpecs([cloneAt(hangar, 1), cloneAt(hangar, 2)]);
  assert.deepEqual(
    specs.map((s) => s.folder),
    ['apis', 'docs'],
  );
  const apis = first(specs, 'a spec');
  assert.deepEqual(
    apis.wanted.map((w) => w.name),
    ['clone 1 - api', 'clone 2 - api'],
  );
  assert.equal(apis.wanted[1]?.url, 'http://localhost:3137');
  assert.ok(!specs.some((s) => s.wanted.some((w) => w.url.includes('5469'))));
  assert.deepEqual(bookmarkSpecs([cloneAt(syntheticHangar(), 1)]), []);
});

test('two roles into one folder is refused', () => {
  const text = bookmarked().replace('folder: docs', 'folder: apis');
  const hangar = syntheticHangar({ configText: text });
  assert.throws(() => bookmarkSpecs([cloneAt(hangar, 1)]), CliError);
});

test('only the main Brave process counts as running', () => {
  const app = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  assert.ok(braveIsRunning([app]));
  assert.ok(braveIsRunning([`${app} --profile-directory=Default`]));
  assert.ok(braveIsRunning(['/usr/bin/brave-browser']));
  assert.ok(!braveIsRunning([`${app} Helper --type=gpu-process`]));
  assert.ok(!braveIsRunning(['/opt/brave/brave --type=renderer']));
  assert.ok(!braveIsRunning(['/opt/brave/chrome_crashpad_handler --monitor-self']));
  assert.ok(!braveIsRunning(['vim brave-notes.md']));
});
