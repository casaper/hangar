import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bookmarksChecksum,
  buildBookmarks,
  indexOfName,
  normaliseUrl,
  type BookmarkNode,
  type BookmarksFile,
} from '../src/bookmarks/chromium.ts';
import {
  applyFirefox,
  defaultFirefoxProfile,
  firefoxUrlHash,
  originOf,
  planFirefox,
  readFirefoxFolder,
  reverseHost,
  type FirefoxLink,
} from '../src/bookmarks/firefox.ts';
import {
  bookmarkSpecs,
  browserIsRunning,
  chromiumUserDataDir,
  selectBrowsers,
} from '../src/commands/bookmarks.ts';
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
  const running = (...commands: string[]): boolean => browserIsRunning('brave', commands);
  assert.ok(running(app));
  assert.ok(running(`${app} --profile-directory=Default`));
  assert.ok(running('/usr/bin/brave-browser'));
  assert.ok(!running(`${app} Helper --type=gpu-process`));
  assert.ok(!running('/opt/brave/brave --type=renderer'));
  assert.ok(!running('/opt/brave/chrome_crashpad_handler --monitor-self'));
  assert.ok(!running('vim brave-notes.md'));
});

test('Chrome and Firefox are told apart from their helpers and from each other', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.ok(browserIsRunning('chrome', [chrome]));
  assert.ok(browserIsRunning('chrome', ['/opt/google/chrome/chrome']));
  assert.ok(!browserIsRunning('chrome', [`${chrome} Helper (Renderer) --type=renderer`]));
  assert.ok(!browserIsRunning('chrome', ['/opt/google/chrome/chrome_crashpad_handler']));
  assert.ok(!browserIsRunning('brave', [chrome]));
  const firefox = '/Applications/Firefox.app/Contents/MacOS/firefox';
  assert.ok(browserIsRunning('firefox', [firefox]));
  assert.ok(browserIsRunning('firefox', [`${firefox} -foreground`]));
  assert.ok(browserIsRunning('firefox', ['/usr/lib/firefox/firefox-bin']));
  assert.ok(!browserIsRunning('firefox', [`${firefox} -contentproc -isForBrowser`]));
  assert.ok(
    !browserIsRunning('firefox', ['/Applications/Firefox.app/Contents/MacOS/plugin-container']),
  );
});

test('--browser picks one browser, or all three, and refuses a stranger', () => {
  assert.deepEqual(selectBrowsers(undefined), ['brave', 'chrome', 'firefox']);
  assert.deepEqual(selectBrowsers('all'), ['brave', 'chrome', 'firefox']);
  assert.deepEqual(selectBrowsers('chrome'), ['chrome']);
  assert.throws(() => selectBrowsers('safari'), CliError);
});

test('Chrome keeps its profiles where the platform puts them, and Brave in one place', () => {
  assert.match(chromiumUserDataDir('chrome', 'darwin', '/c'), /\/c\/Google\/Chrome$/);
  assert.match(chromiumUserDataDir('chrome', 'linux', '/c'), /\/c\/google-chrome$/);
  assert.match(chromiumUserDataDir('brave', 'linux', '/c'), /BraveSoftware\/Brave-Browser$/);
});

const link = (id: number, title: string, url: string, position: number): FirefoxLink => ({
  id,
  title,
  url,
  placeId: id + 100,
  position,
});

test('Firefox: a hand-made link is adopted by clone index, strays go, a second run is empty', () => {
  const existing = [
    link(1, 'clone_01 - devserver', 'http://localhost:4200/', 0),
    link(2, 'clone 9 - devserver', 'http://localhost:4209/', 1),
    link(3, 'master', 'http://localhost:1/', 2),
  ];
  const plan = planFirefox(existing, { folder: 'devservers', wanted: wanted(1, 2) });
  assert.deepEqual(
    plan.changes.map((c) => [c.kind, c.name]),
    [
      ['update', 'clone 1 - devserver'],
      ['add', 'clone 2 - devserver'],
      ['remove', 'clone 9 - devserver'],
      ['remove', 'master'],
    ],
  );
  assert.equal(plan.steps[0]?.kind === 'update' && plan.steps[0].link.id, 1);
  const settled = [
    link(1, 'clone 1 - devserver', 'http://localhost:4201/', 0),
    link(2, 'clone 2 - devserver', 'http://localhost:4202/', 1),
  ];
  assert.deepEqual(
    planFirefox(settled, { folder: 'devservers', wanted: wanted(1, 2) }).changes,
    [],
  );
  assert.equal(
    planFirefox(undefined, { folder: 'devservers', wanted: wanted(1) }).createFolder,
    true,
  );
});

test("Firefox: the URL hash, reversed host and origin follow Firefox's own forms", () => {
  // Two rows of a real profile (schema 86); the hash is the one thing a plain SQLite cannot make.
  assert.equal(firefoxUrlHash('https://www.mozilla.org/about/'), 47357608426557);
  assert.equal(firefoxUrlHash('https://www.mozilla.org/contribute/'), 47357364218428);
  assert.equal(reverseHost('http://localhost:4201/'), 'tsohlacol.');
  assert.deepEqual(originOf('http://localhost:4201/'), {
    prefix: 'http://',
    host: 'localhost:4201',
  });
});

test('Firefox: the installation default beats the legacy Default=1 profile', () => {
  const ini = [
    '[Profile1]',
    'Name=default',
    'IsRelative=1',
    'Path=Profiles/aaa.default',
    'Default=1',
    '',
    '[Install2656FF1E876E9973]',
    'Default=Profiles/bbb.default-release',
    'Locked=1',
  ].join('\n');
  assert.equal(defaultFirefoxProfile(ini, '/ff'), '/ff/Profiles/bbb.default-release');
  assert.equal(
    defaultFirefoxProfile(ini.split('[Install')[0] ?? '', '/ff'),
    '/ff/Profiles/aaa.default',
  );
  assert.equal(defaultFirefoxProfile('', '/ff'), undefined);
});

test('Firefox: applying keeps places, counts and positions consistent, and is idempotent', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE moz_origins (id INTEGER PRIMARY KEY, prefix TEXT NOT NULL, host TEXT NOT NULL,
      frecency INTEGER NOT NULL, recalc_frecency INTEGER NOT NULL DEFAULT 0, alt_frecency INTEGER,
      recalc_alt_frecency INTEGER NOT NULL DEFAULT 0, UNIQUE (prefix, host));
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
      rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL,
      typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER,
      guid TEXT, foreign_count INTEGER DEFAULT 0 NOT NULL, url_hash INTEGER DEFAULT 0 NOT NULL,
      origin_id INTEGER, recalc_frecency INTEGER NOT NULL DEFAULT 0, recalc_alt_frecency INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
      parent INTEGER, position INTEGER, title LONGVARCHAR, keyword_id INTEGER, folder_type TEXT,
      dateAdded INTEGER, lastModified INTEGER, guid TEXT, syncStatus INTEGER NOT NULL DEFAULT 0,
      syncChangeCounter INTEGER NOT NULL DEFAULT 1);
    INSERT INTO moz_bookmarks (id, type, parent, position, title, guid) VALUES (1, 2, 0, 0, 'toolbar', 'toolbar_____');
  `);
  const specs = [{ folder: 'devservers', wanted: wanted(1, 2) }];
  assert.equal(applyFirefox(db, specs, 1_700_000_000_000).length, 3);
  assert.deepEqual(applyFirefox(db, specs, 1_700_000_001_000), []);
  const rows = readFirefoxFolder(db, 'devservers');
  assert.deepEqual(
    rows?.map((r) => [r.title, r.url, r.position]),
    [
      ['clone 1 - devserver', 'http://localhost:4201/', 0],
      ['clone 2 - devserver', 'http://localhost:4202/', 1],
    ],
  );
  // Narrow the folder to clone 2: clone 1's link and its place's count go, clone 2's stay.
  applyFirefox(db, [{ folder: 'devservers', wanted: wanted(2) }], 1_700_000_002_000);
  const counts = db.prepare('SELECT url, foreign_count AS n FROM moz_places ORDER BY url').all();
  assert.deepEqual(
    counts.map((c) => [c['url'], c['n']]),
    [
      ['http://localhost:4201/', 0],
      ['http://localhost:4202/', 1],
    ],
  );
  assert.equal(readFirefoxFolder(db, 'devservers')?.[0]?.position, 0);
  const place = db
    .prepare('SELECT url_hash, rev_host FROM moz_places WHERE url = ?')
    .get('http://localhost:4202/');
  assert.ok(place);
  assert.equal(place['url_hash'], firefoxUrlHash('http://localhost:4202/'));
  assert.equal(place['rev_host'], 'tsohlacol.');
  db.close();
});
