import { createHash } from 'node:crypto';

/**
 * The Chromium `Bookmarks` file, as far as keeping a folder of per-clone links in it needs.
 *
 * Everything here is PURE: the file's parsed JSON in, the next JSON and a list of what changed
 * out. Reading, the Brave-is-running refusal and the atomic write are `commands/bookmarks.ts`.
 *
 * Nodes keep every key this module does not name (`meta_info`, `date_last_used`, a sync
 * `guid`...), because the file belongs to the browser and a key dropped here is a key Brave
 * quietly loses.
 */

export type BookmarkNode = {
  id: string;
  guid?: string;
  name: string;
  type: 'url' | 'folder';
  url?: string;
  date_added?: string;
  date_modified?: string;
  children?: BookmarkNode[];
  [key: string]: unknown;
};

export type BookmarksFile = {
  checksum?: string;
  roots: Record<string, BookmarkNode | undefined>;
  [key: string]: unknown;
};

/** One bookmark a clone should have, in the folder the spec names. */
export type WantedBookmark = {
  readonly index: number;
  readonly name: string;
  readonly url: string;
};

export type FolderSpec = {
  /** The folder's name on the Bookmarks bar. */
  readonly folder: string;
  readonly wanted: readonly WantedBookmark[];
};

export type BookmarkChange = {
  readonly folder: string;
  readonly kind: 'create-folder' | 'add' | 'update' | 'remove' | 'reorder';
  readonly name: string;
  /** `4201 → 4301`-style detail, or empty. */
  readonly detail: string;
};

export type BuiltBookmarks = { readonly next: BookmarksFile; readonly changes: BookmarkChange[] };

/** The three roots, in the order Chromium feeds them to its checksum. */
const ROOT_ORDER = ['bookmark_bar', 'other', 'synced'] as const;

const md5Update = (hash: ReturnType<typeof createHash>, text: string, utf16: boolean): void => {
  hash.update(Buffer.from(text, utf16 ? 'utf16le' : 'utf8'));
};

const checksumNode = (hash: ReturnType<typeof createHash>, node: BookmarkNode): void => {
  md5Update(hash, node.id, false);
  md5Update(hash, node.name, true);
  if (node.type === 'url') {
    md5Update(hash, 'url', false);
    md5Update(hash, node.url ?? '', false);
    return;
  }
  md5Update(hash, 'folder', false);
  for (const child of node.children ?? []) checksumNode(hash, child);
};

/**
 * Chromium's own checksum over the three roots: id, title (UTF-16), type and, for a link, the
 * URL, depth first. A file whose `checksum` does not match what is in it is treated as damaged,
 * so a write that skipped this would be a write the browser throws away.
 */
export const bookmarksChecksum = (file: BookmarksFile): string => {
  const hash = createHash('md5');
  for (const key of ROOT_ORDER) {
    const root = file.roots[key];
    if (root !== undefined) checksumNode(hash, root);
  }
  return hash.digest('hex');
};

/** `13408799172000000`: microseconds since 1601-01-01, as the string Chromium stores. */
export const webkitTime = (at: Date): string =>
  String((BigInt(at.getTime()) + 11644473600000n) * 1000n);

/** `http://localhost:4201` and `http://localhost:4201/` are one URL; Chromium writes the second. */
export const normaliseUrl = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

/** The clone index in `clone 3 - devserver`, `clone_03 - storybook` and the like. */
export const indexOfName = (name: string): number | undefined => {
  const match = /^clone[ _]0*(\d+)\b/i.exec(name.trim());
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
};

const highestId = (node: BookmarkNode): number =>
  Math.max(
    Number.parseInt(node.id, 10) || 0,
    ...(node.children ?? []).map((child) => highestId(child)),
  );

const sameLinks = (a: readonly BookmarkNode[], b: readonly BookmarkNode[]): boolean =>
  a.length === b.length && a.every((node, i) => node === b[i]);

/**
 * Make each spec's folder on the Bookmarks bar hold exactly its wanted links.
 *
 * A link already in the folder is matched BY CLONE INDEX rather than by name, so the entries a
 * person made by hand (`clone_01 - storybook`) are renamed and re-pointed in place and keep their
 * `id`, `guid` and `date_added`, instead of being deleted and re-added as strangers. Anything in
 * the folder that is not a wanted clone's link is removed -- including a second link for the same
 * clone, a sub-folder and a hand-made one-off -- because "the folder is exactly the fleet" is the
 * property worth having, and a folder that keeps strays is one nobody can trust to be current.
 *
 * Every other folder on the bar, and everything outside it, is carried through untouched, and
 * the input is not mutated.
 */
export const buildBookmarks = (
  file: BookmarksFile,
  specs: readonly FolderSpec[],
  now: Date,
  newGuid: () => string,
): BuiltBookmarks => {
  const next = structuredClone(file);
  const bar = next.roots['bookmark_bar'];
  if (bar === undefined) throw new Error('the Bookmarks file has no bookmark_bar root');
  bar.children ??= [];
  const changes: BookmarkChange[] = [];
  const stamp = webkitTime(now);
  let nextId = Math.max(...ROOT_ORDER.map((key) => highestId(next.roots[key] ?? bar))) + 1;
  const freshId = (): string => String(nextId++);

  for (const spec of specs) {
    let folder = bar.children.find((n) => n.type === 'folder' && n.name === spec.folder);
    if (folder === undefined) {
      folder = {
        id: freshId(),
        guid: newGuid(),
        name: spec.folder,
        type: 'folder',
        date_added: stamp,
        date_modified: stamp,
        children: [],
      };
      bar.children.push(folder);
      changes.push({ folder: spec.folder, kind: 'create-folder', name: spec.folder, detail: '' });
    }
    const before = folder.children ?? [];
    const claimed = new Set<BookmarkNode>();
    const result: BookmarkNode[] = [];
    let touched = false;

    for (const want of [...spec.wanted].sort((a, b) => a.index - b.index)) {
      const wantUrl = normaliseUrl(want.url);
      const found = before.find(
        (n) => n.type === 'url' && !claimed.has(n) && indexOfName(n.name) === want.index,
      );
      if (found === undefined) {
        result.push({
          id: freshId(),
          guid: newGuid(),
          name: want.name,
          type: 'url',
          url: wantUrl,
          date_added: stamp,
          date_last_used: '0',
        });
        changes.push({ folder: spec.folder, kind: 'add', name: want.name, detail: wantUrl });
        touched = true;
        continue;
      }
      claimed.add(found);
      if (found.name !== want.name || normaliseUrl(found.url ?? '') !== wantUrl) {
        const was = normaliseUrl(found.url ?? '');
        found.name = want.name;
        found.url = wantUrl;
        changes.push({
          folder: spec.folder,
          kind: 'update',
          name: want.name,
          detail: was === wantUrl ? '' : `${was} → ${wantUrl}`,
        });
        touched = true;
      }
      result.push(found);
    }

    for (const node of before) {
      if (claimed.has(node)) continue;
      changes.push({
        folder: spec.folder,
        kind: 'remove',
        name: node.name,
        detail: node.type === 'url' ? normaliseUrl(node.url ?? '') : 'folder',
      });
      touched = true;
    }
    const kept = before.filter((n) => claimed.has(n));
    const keptInOrder = result.filter((n) => claimed.has(n));
    if (!touched && !sameLinks(kept, keptInOrder)) {
      changes.push({ folder: spec.folder, kind: 'reorder', name: spec.folder, detail: '' });
      touched = true;
    }
    folder.children = result;
    if (touched) folder.date_modified = stamp;
  }

  if (changes.length > 0) next.checksum = bookmarksChecksum(next);
  return { next, changes };
};
