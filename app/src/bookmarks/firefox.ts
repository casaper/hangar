// eslint-disable-next-line n/no-unsupported-features/node-builtins -- a type only; the module is loaded on demand
import type { DatabaseSync } from 'node:sqlite';

import { indexOfName, normaliseUrl, type BookmarkChange, type FolderSpec } from './chromium.ts';

/**
 * Firefox's half of `bookmarks sync`: `places.sqlite`, not a JSON file.
 *
 * Everything that decides what changes is PURE (`planFirefox`, the hash, the profile file's
 * parser); the SQL is two thin functions beside them. The wanted folders are the same
 * `FolderSpec`s Chromium's builder takes, and the changes the same `BookmarkChange`s, so the
 * command prints and counts both engines alike.
 *
 * Measured against a real profile (schema 86) rather than assumed: that schema has NO triggers, so
 * the application keeps `moz_places.foreign_count` and the bookmark positions itself and this code
 * must too; and `url_hash` is a function Firefox registers on its own connection, so a plain
 * SQLite cannot compute it and a wrong value makes Firefox miss the place it just bookmarked.
 * `firefoxUrlHash` reproduced all 24 rows of that profile exactly.
 */

/** A bookmark already in the folder. `url` is the place it points at. */
export type FirefoxLink = {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly placeId: number;
  readonly position: number;
};

export type FirefoxStep =
  | { readonly kind: 'keep'; readonly link: FirefoxLink; readonly position: number }
  | {
      readonly kind: 'update';
      readonly link: FirefoxLink;
      readonly position: number;
      readonly name: string;
      readonly url: string;
    }
  | {
      readonly kind: 'add';
      readonly position: number;
      readonly name: string;
      readonly url: string;
    };

export type FirefoxPlan = {
  readonly createFolder: boolean;
  readonly steps: readonly FirefoxStep[];
  readonly removes: readonly FirefoxLink[];
  readonly changes: readonly BookmarkChange[];
};

/**
 * What one folder must become, given the links it holds now (`undefined`: no such folder).
 * PURE, and the same adopt-by-clone-index rule as the Chromium builder: a survivor keeps its row,
 * everything that is not a wanted clone's link goes.
 */
export const planFirefox = (
  existing: readonly FirefoxLink[] | undefined,
  spec: FolderSpec,
): FirefoxPlan => {
  const before = existing ?? [];
  const changes: BookmarkChange[] = [];
  if (existing === undefined) {
    changes.push({ folder: spec.folder, kind: 'create-folder', name: spec.folder, detail: '' });
  }
  const claimed = new Set<FirefoxLink>();
  const steps: FirefoxStep[] = [];
  let position = 0;
  for (const want of [...spec.wanted].sort((a, b) => a.index - b.index)) {
    const url = normaliseUrl(want.url);
    const found = before.find((l) => !claimed.has(l) && indexOfName(l.title) === want.index);
    if (found === undefined) {
      steps.push({ kind: 'add', position, name: want.name, url });
      changes.push({ folder: spec.folder, kind: 'add', name: want.name, detail: url });
    } else {
      claimed.add(found);
      const was = normaliseUrl(found.url);
      if (found.title !== want.name || was !== url) {
        steps.push({ kind: 'update', link: found, position, name: want.name, url });
        changes.push({
          folder: spec.folder,
          kind: 'update',
          name: want.name,
          detail: was === url ? '' : `${was} → ${url}`,
        });
      } else {
        steps.push({ kind: 'keep', link: found, position });
      }
    }
    position++;
  }
  const removes = before.filter((l) => !claimed.has(l));
  for (const gone of removes) {
    changes.push({
      folder: spec.folder,
      kind: 'remove',
      name: gone.title,
      detail: normaliseUrl(gone.url),
    });
  }
  const moved = steps.some((s) => s.kind !== 'add' && s.link.position !== s.position);
  if (moved && changes.length === 0) {
    changes.push({ folder: spec.folder, kind: 'reorder', name: spec.folder, detail: '' });
  }
  return { createFolder: existing === undefined, steps, removes, changes };
};

/** Mozilla's `HashString`: rotate-left-5, xor, golden-ratio multiply, over the UTF-8 bytes. */
const hashString = (text: string): number => {
  let hash = 0;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash = Math.imul((((hash << 5) | (hash >>> 27)) ^ byte) >>> 0, 0x9e3779b9) >>> 0;
  }
  return hash;
};

/** `moz_places.url_hash`: the scheme's hash in the top 16 bits, the whole URL's below. PURE. */
export const firefoxUrlHash = (url: string): number => {
  const colon = url.indexOf(':');
  const prefix = (hashString(url.slice(0, colon < 0 ? 0 : colon)) & 0xffff) >>> 0;
  return prefix * 2 ** 32 + hashString(url);
};

/** `localhost` → `tsohlacol.`, the reversed host with a trailing dot that `rev_host` stores. */
export const reverseHost = (url: string): string => {
  const host = new URL(url).hostname;
  return `${host.split('').reverse().join('')}.`;
};

/** Where `moz_origins` files a URL: `http://` and `localhost:4201`, the port included. */
export const originOf = (url: string): { prefix: string; host: string } => {
  const parsed = new URL(url);
  return { prefix: `${parsed.protocol}//`, host: parsed.host };
};

/**
 * The profile directory Firefox itself starts, from `profiles.ini`. PURE.
 *
 * The `[Install…] Default=` entry wins: it names the profile this INSTALLATION uses, and on a
 * machine that has met more than one Firefox the `Default=1` flag points at a legacy profile
 * nobody opens (measured: it named `default`, the install named `default-release`). A path with
 * `IsRelative=0` is already absolute.
 */
export const defaultFirefoxProfile = (ini: string, base: string): string | undefined => {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of ini.split(/\r?\n/)) {
    const header = /^\[(.+)\]\s*$/.exec(line.trim());
    if (header?.[1] !== undefined) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current !== undefined && eq > 0)
      current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const resolve = (path: string, relative: boolean): string =>
    relative ? `${base}/${path}` : path;
  for (const [name, values] of sections) {
    const dir = values.get('Default');
    if (name.startsWith('Install') && dir !== undefined) return resolve(dir, true);
  }
  for (const [name, values] of sections) {
    const path = values.get('Path');
    if (name.startsWith('Profile') && path !== undefined && values.get('Default') === '1') {
      return resolve(path, values.get('IsRelative') !== '0');
    }
  }
  return undefined;
};

type Row = Record<string, string | number | bigint | Uint8Array | null>;

const toolbarId = (db: DatabaseSync): number => {
  const row = db.prepare("SELECT id FROM moz_bookmarks WHERE guid = 'toolbar_____'").get() as
    Row | undefined;
  if (typeof row?.['id'] !== 'number') throw new Error('places.sqlite has no bookmarks toolbar');
  return row['id'];
};

/** The links in the toolbar folder named `folder`, or `undefined` when there is no such folder. */
export const readFirefoxFolder = (db: DatabaseSync, folder: string): FirefoxLink[] | undefined => {
  const parent = db
    .prepare('SELECT id FROM moz_bookmarks WHERE parent = ? AND type = 2 AND title = ?')
    .get(toolbarId(db), folder) as Row | undefined;
  if (typeof parent?.['id'] !== 'number') return undefined;
  const rows = db
    .prepare(
      `SELECT b.id, b.title, b.position, b.fk, p.url
         FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk
        WHERE b.parent = ? AND b.type = 1 ORDER BY b.position`,
    )
    .all(parent['id']) as Row[];
  return rows.map((r) => ({
    id: Number(r['id']),
    title: String(r['title'] ?? ''),
    url: String(r['url']),
    placeId: Number(r['fk']),
    position: Number(r['position']),
  }));
};

const GUID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Firefox's twelve-character URL-safe GUID. */
export const firefoxGuid = (random: () => number = Math.random): string =>
  Array.from({ length: 12 }, () => GUID_ALPHABET[Math.floor(random() * 64)]).join('');

/**
 * Apply every spec to an open, writable database inside ONE transaction, and report what changed.
 * It re-reads the folders itself rather than trusting an earlier plan: the file may have moved
 * between the dry-run read and now.
 */
export const applyFirefox = (
  db: DatabaseSync,
  specs: readonly FolderSpec[],
  nowMs: number,
): BookmarkChange[] => {
  const now = nowMs * 1000;
  const all: BookmarkChange[] = [];
  const hasTombstones =
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'moz_bookmarks_deleted'").get() !==
    undefined;
  db.exec('BEGIN IMMEDIATE');
  try {
    const toolbar = toolbarId(db);

    const placeFor = (url: string): number => {
      const hash = firefoxUrlHash(url);
      const hit = db
        .prepare('SELECT id FROM moz_places WHERE url_hash = ? AND url = ?')
        .get(hash, url) as Row | undefined;
      const placeId = hit === undefined ? undefined : Number(hit['id']);
      if (placeId !== undefined) {
        db.prepare('UPDATE moz_places SET foreign_count = foreign_count + 1 WHERE id = ?').run(
          placeId,
        );
        return placeId;
      }
      const { prefix, host } = originOf(url);
      db.prepare(
        `INSERT OR IGNORE INTO moz_origins (prefix, host, frecency, recalc_frecency, recalc_alt_frecency)
         VALUES (?, ?, 1, 0, 1)`,
      ).run(prefix, host);
      const origin = db
        .prepare('SELECT id FROM moz_origins WHERE prefix = ? AND host = ?')
        .get(prefix, host) as Row;
      const inserted = db
        .prepare(
          `INSERT INTO moz_places (url, title, rev_host, visit_count, hidden, typed, frecency, guid,
                                   foreign_count, url_hash, origin_id, recalc_frecency, recalc_alt_frecency)
           VALUES (?, NULL, ?, 0, 0, 0, -1, ?, 1, ?, ?, 1, 1)`,
        )
        .run(url, reverseHost(url), firefoxGuid(), hash, Number(origin['id']));
      return Number(inserted.lastInsertRowid);
    };

    const release = (link: FirefoxLink): void => {
      db.prepare(
        'UPDATE moz_places SET foreign_count = max(foreign_count - 1, 0) WHERE id = ?',
      ).run(link.placeId);
    };

    for (const spec of specs) {
      const existing = readFirefoxFolder(db, spec.folder);
      const plan = planFirefox(existing, spec);
      if (plan.changes.length === 0) continue;
      all.push(...plan.changes);

      let folderId: number;
      if (plan.createFolder) {
        const position = Number(
          (
            db
              .prepare('SELECT count(*) AS c FROM moz_bookmarks WHERE parent = ?')
              .get(toolbar) as Row
          )['c'],
        );
        folderId = Number(
          db
            .prepare(
              `INSERT INTO moz_bookmarks (type, parent, position, title, dateAdded, lastModified, guid)
               VALUES (2, ?, ?, ?, ?, ?, ?)`,
            )
            .run(toolbar, position, spec.folder, now, now, firefoxGuid()).lastInsertRowid,
        );
      } else {
        folderId = Number(
          (
            db
              .prepare('SELECT id FROM moz_bookmarks WHERE parent = ? AND type = 2 AND title = ?')
              .get(toolbar, spec.folder) as Row
          )['id'],
        );
      }

      for (const gone of plan.removes) {
        const row = db
          .prepare('SELECT guid, syncStatus FROM moz_bookmarks WHERE id = ?')
          .get(gone.id) as Row | undefined;
        db.prepare('DELETE FROM moz_bookmarks WHERE id = ?').run(gone.id);
        release(gone);
        if (hasTombstones && row?.['syncStatus'] === 2) {
          db.prepare(
            'INSERT OR REPLACE INTO moz_bookmarks_deleted (guid, dateRemoved) VALUES (?, ?)',
          ).run(String(row['guid']), now);
        }
      }
      for (const step of plan.steps) {
        if (step.kind === 'add') {
          db.prepare(
            `INSERT INTO moz_bookmarks (type, fk, parent, position, title, dateAdded, lastModified, guid)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(placeFor(step.url), folderId, step.position, step.name, now, now, firefoxGuid());
        } else if (step.kind === 'update') {
          let fk = step.link.placeId;
          if (normaliseUrl(step.link.url) !== step.url) {
            release(step.link);
            fk = placeFor(step.url);
          }
          db.prepare(
            `UPDATE moz_bookmarks SET title = ?, fk = ?, position = ?, lastModified = ?,
                    syncChangeCounter = syncChangeCounter + 1 WHERE id = ?`,
          ).run(step.name, fk, step.position, now, step.link.id);
        } else if (step.link.position !== step.position) {
          db.prepare(
            `UPDATE moz_bookmarks SET position = ?, lastModified = ?,
                    syncChangeCounter = syncChangeCounter + 1 WHERE id = ?`,
          ).run(step.position, now, step.link.id);
        }
      }
      db.prepare(
        `UPDATE moz_bookmarks SET lastModified = ?, syncChangeCounter = syncChangeCounter + 1
          WHERE id IN (?, ?)`,
      ).run(now, folderId, toolbar);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return all;
};
