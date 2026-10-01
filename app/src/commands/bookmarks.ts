import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- a type only; loaded on demand
import type { DatabaseSync } from 'node:sqlite';

import {
  buildBookmarks,
  type BookmarkChange,
  type BookmarksFile,
  type FolderSpec,
  type WantedBookmark,
} from '../bookmarks/chromium.ts';
import {
  applyFirefox,
  defaultFirefoxProfile,
  planFirefox,
  readFirefoxFolder,
} from '../bookmarks/firefox.ts';
import { CliError } from '../exec.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import type { Hangar } from '../hangar.ts';
import { platform } from '../platform/index.ts';
import { processTable } from '../procs.ts';
import { roleUrl } from '../ports.ts';
import { blank, heading, note, ok, warn } from '../ui.ts';
import { home, tildify } from '../user-paths.ts';

/**
 * `hangar bookmarks sync` -- one folder per bookmarked port role on the Bookmarks bar of Brave,
 * Chrome and Firefox, one link per clone.
 *
 * Which roles, and what the folder and the link's label are called, is `ports.roles[].bookmark`
 * in the config; nothing here knows what an Angular dev server or a Storybook is. A browser that
 * is not installed is skipped with a note, never an error.
 *
 * **A browser must not be running while its file is written, and this is the whole reason the
 * command refuses.** Brave and Chrome hold their bookmarks in memory and rewrite the file from
 * there, and Firefox holds `places.sqlite` open: an edit made behind either one's back is lost or
 * corrupts. `-n` is exempt because it writes nothing -- Firefox's is read from a COPY of the
 * database, so a dry run never opens the live one.
 *
 * **All or nothing**: every browser is read and planned first, and the running check covers every
 * browser that has something to write BEFORE the first of them is, so a refusal never leaves one
 * browser current and another stale.
 */
export const BROWSER_IDS = ['brave', 'chrome', 'firefox'] as const;
export type BrowserId = (typeof BROWSER_IDS)[number];

export type BookmarksSyncOptions = {
  readonly dryRun?: boolean | undefined;
  readonly profile?: string | undefined;
  readonly browser?: string | undefined;
};

const BROWSER_NAMES: Record<BrowserId, string> = {
  brave: 'Brave',
  chrome: 'Chrome',
  firefox: 'Firefox',
};

/**
 * The folders this fleet should have, from the clones' ports. PURE.
 *
 * A clone whose role has no URL (`url: null`) is left out rather than given a bare number, and
 * two roles naming one folder is refused: the folder is matched by clone index, so two roles in
 * it would each delete the other's links on every run.
 */
export const bookmarkSpecs = (clones: readonly Clone[]): FolderSpec[] => {
  const byFolder = new Map<string, { role: string; wanted: WantedBookmark[] }>();
  for (const clone of clones) {
    for (const entry of clone.ports) {
      const bookmark = entry.role.bookmark;
      const url = roleUrl(entry);
      if (bookmark === undefined || url === undefined) continue;
      let folder = byFolder.get(bookmark.folder);
      if (folder === undefined) {
        folder = { role: entry.role.id, wanted: [] };
        byFolder.set(bookmark.folder, folder);
      }
      if (folder.role !== entry.role.id) {
        throw new CliError(
          `ports.roles "${folder.role}" and "${entry.role.id}" both bookmark into the folder "${bookmark.folder}"`,
          'Give each role its own bookmark.folder.',
        );
      }
      folder.wanted.push({
        index: clone.index,
        name: `clone ${String(clone.index)} - ${bookmark.label}`,
        url,
      });
    }
  }
  return [...byFolder].map(([folder, { wanted }]) => ({ folder, wanted }));
};

/**
 * Which browsers a `--browser` value names. PURE. `all` and nothing are all three.
 */
export const selectBrowsers = (choice: string | undefined): BrowserId[] => {
  if (choice === undefined || choice === 'all') return [...BROWSER_IDS];
  const hit = BROWSER_IDS.find((id) => id === choice);
  if (hit === undefined) {
    throw new CliError(
      `unknown browser "${choice}"`,
      `Use one of: all, ${BROWSER_IDS.join(', ')}.`,
    );
  }
  return [hit];
};

/**
 * Whether a main process of `browser` is in `commands`. PURE.
 *
 * Only the main process counts. macOS helpers are `<name> Helper …` and carry `--type=`; Firefox's
 * children are `-contentproc` and `plugin-container`; a crash handler is a different binary.
 */
export const browserIsRunning = (browser: BrowserId, commands: Iterable<string>): boolean => {
  const main: Record<BrowserId, RegExp> = {
    brave: /(?:MacOS\/Brave Browser|\/brave(?:-browser)?)(?: --|$)/,
    chrome: /(?:MacOS\/Google Chrome|\/(?:google-chrome(?:-stable)?|chrome))(?: --|$)/,
    firefox: /(?:MacOS\/firefox|\/firefox(?:-bin|-esr)?)(?: |$)/,
  };
  for (const command of commands) {
    if (command.includes(' --type=') || command.includes(' -contentproc')) continue;
    if (main[browser].test(command)) return true;
  }
  return false;
};

/** The directory under the machine's config dir where a Chromium browser keeps its profiles. PURE. */
export const chromiumUserDataDir = (
  browser: 'brave' | 'chrome',
  platformId: string,
  base: string,
): string => {
  if (browser === 'brave') return join(base, 'BraveSoftware', 'Brave-Browser');
  return platformId === 'darwin' ? join(base, 'Google', 'Chrome') : join(base, 'google-chrome');
};

/** One line per change, for the dry run and the real one alike. */
export const describeChange = (change: BookmarkChange): string => {
  const verb: Record<BookmarkChange['kind'], string> = {
    'create-folder': 'create folder',
    add: 'add',
    update: 'update',
    remove: 'remove',
    reorder: 'reorder',
  };
  const tail = change.detail === '' ? '' : `  ${change.detail}`;
  return `${change.folder}: ${verb[change.kind]} ${change.name}${tail}`;
};

const checkProfileName = (profile: string, browser: string): void => {
  if (profile === '' || /[\\/]/.test(profile) || profile === '..') {
    throw new CliError(`"${profile}" is not a ${browser} profile directory name`, 'Try Default.');
  }
};

/** One browser, read and planned: what it would change and how to write it. */
type Prepared =
  | { readonly kind: 'skipped'; readonly browser: BrowserId; readonly reason: string }
  | {
      readonly kind: 'ready';
      readonly browser: BrowserId;
      readonly path: string;
      readonly changes: readonly BookmarkChange[];
      readonly write: () => Promise<void>;
    };

const prepareChromium = async (
  browser: 'brave' | 'chrome',
  specs: readonly FolderSpec[],
  profile: string | undefined,
): Promise<Prepared> => {
  const name = BROWSER_NAMES[browser];
  const dir = profile ?? 'Default';
  checkProfileName(dir, name);
  const { id, machineConfigDir } = platform();
  if (machineConfigDir === '') {
    return { kind: 'skipped', browser, reason: `no known profile location on ${id}` };
  }
  const path = join(chromiumUserDataDir(browser, id, machineConfigDir), dir, 'Bookmarks');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'skipped', browser, reason: `not installed (no ${tildify(path)})` };
    }
    throw new CliError(`cannot read ${tildify(path)}`, 'Check its permissions.');
  }
  let file: BookmarksFile;
  try {
    file = JSON.parse(raw) as BookmarksFile;
  } catch {
    throw new CliError(`${tildify(path)} is not valid JSON`, 'Nothing was changed.');
  }
  const { next, changes } = buildBookmarks(file, specs, new Date(), randomUUID);
  return {
    kind: 'ready',
    browser,
    path,
    changes,
    write: async () => {
      /*
       * A sibling file renamed over the original: the browser, or a second `bookmarks sync`,
       * never sees a half-written file. The three-space indent is the browser's own, which keeps
       * the next diff against its `.bak` down to what changed.
       */
      const staging = `${path}.hangar-tmp`;
      await writeFile(staging, `${JSON.stringify(next, null, 3)}\n`, {
        mode: (await stat(path)).mode,
      });
      await rename(staging, path);
    },
  };
};

/** `node:sqlite`, loaded on demand and without Node's one-line "experimental" notice. */
const loadSqlite = async (): Promise<{ DatabaseSync: typeof DatabaseSync }> => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called back through Reflect.apply
  const original = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (!text.includes('SQLite')) Reflect.apply(original, process, [warning, ...rest]);
  };
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
};

const firefoxProfilesBase = (): { base: string; profiles: string } => {
  const base =
    platform().id === 'darwin'
      ? join(platform().machineConfigDir, 'Firefox')
      : join(home, '.mozilla', 'firefox');
  return { base, profiles: platform().id === 'darwin' ? join(base, 'Profiles') : base };
};

const prepareFirefox = async (
  specs: readonly FolderSpec[],
  profile: string | undefined,
): Promise<Prepared> => {
  const browser = 'firefox';
  if (platform().id === 'unsupported') {
    return { kind: 'skipped', browser, reason: 'no known profile location on this platform' };
  }
  const { base, profiles } = firefoxProfilesBase();
  let dir: string | undefined;
  if (profile !== undefined) {
    checkProfileName(profile, 'Firefox');
    dir = join(profiles, profile);
  } else if (existsSync(join(base, 'profiles.ini'))) {
    dir = defaultFirefoxProfile(readFileSync(join(base, 'profiles.ini'), 'utf8'), base);
  }
  const path = dir === undefined ? undefined : join(dir, 'places.sqlite');
  if (path === undefined || !existsSync(path)) {
    return {
      kind: 'skipped',
      browser,
      reason: `not installed (no profile with a places.sqlite under ${tildify(base)})`,
    };
  }
  const { DatabaseSync } = await loadSqlite();

  // The dry run reads a copy -- database, journal and shared memory alike -- so it never opens the
  // file a running Firefox holds, and cannot disturb it.
  const scratch = mkdtempSync(join(tmpdir(), 'hangar-places-'));
  let changes: BookmarkChange[];
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix))
        copyFileSync(path + suffix, join(scratch, `places.sqlite${suffix}`));
    }
    const db = new DatabaseSync(join(scratch, 'places.sqlite'), { readOnly: true });
    try {
      changes = specs.flatMap(
        (spec) => planFirefox(readFirefoxFolder(db, spec.folder), spec).changes,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    kind: 'ready',
    browser,
    path,
    changes,
    write: () => {
      const db = new DatabaseSync(path);
      try {
        applyFirefox(db, specs, Date.now());
      } finally {
        db.close();
      }
      return Promise.resolve();
    },
  };
};

export const bookmarksSync = async (
  hangar: Hangar,
  opts: BookmarksSyncOptions = {},
): Promise<void> => {
  const dryRun = opts.dryRun === true;
  const chosen = selectBrowsers(opts.browser);
  const specs = bookmarkSpecs(discoverClones(hangar));
  if (specs.length === 0) {
    warn('no port role has a bookmark: key, so there is nothing to put in a browser');
    note('add `bookmark: { folder: …, label: … }` to a ports.roles[] entry');
    return;
  }

  // Every browser is read and planned at once; printing is in table order afterwards, so the
  // output does not depend on which read finished first.
  const prepared = await Promise.all(
    chosen.map((browser) =>
      browser === 'firefox'
        ? prepareFirefox(specs, opts.profile)
        : prepareChromium(browser, specs, opts.profile),
    ),
  );

  heading(dryRun ? 'Would sync bookmarks' : 'Syncing bookmarks');
  for (const item of prepared) {
    const name = BROWSER_NAMES[item.browser];
    if (item.kind === 'skipped') {
      note(`${name}: skipped, ${item.reason}`);
      continue;
    }
    blank();
    note(`${name}  ${tildify(item.path)}`);
    if (item.changes.length === 0) ok(`${name}: already up to date`);
    for (const change of item.changes) note(describeChange(change));
  }
  const ready = prepared.flatMap((item) => (item.kind === 'ready' ? [item] : []));
  if (ready.length === 0) {
    throw new CliError('no browser to update', 'None of Brave, Chrome or Firefox has a profile.');
  }
  const pending = ready.filter((item) => item.changes.length > 0);
  if (dryRun || pending.length === 0) return;

  const commands = [...processTable().values()].map((row) => row.command);
  const running = pending.filter((item) => browserIsRunning(item.browser, commands));
  if (running.length > 0) {
    throw new CliError(
      `${running.map((item) => BROWSER_NAMES[item.browser]).join(' and ')} ${running.length === 1 ? 'is' : 'are'} running, and would overwrite the change`,
      'Quit it (Cmd-Q), run this again, then reopen it. Nothing was written to any browser. `-n` shows the change without writing.',
    );
  }
  await Promise.all(pending.map((item) => item.write()));
  const total = pending.reduce((sum, item) => sum + item.changes.length, 0);
  blank();
  ok(
    `${String(total)} change${total === 1 ? '' : 's'} written to ${pending.map((item) => BROWSER_NAMES[item.browser]).join(', ')}`,
  );
};
