import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildBookmarks,
  type BookmarkChange,
  type BookmarksFile,
  type FolderSpec,
  type WantedBookmark,
} from '../bookmarks/brave.ts';
import { CliError } from '../exec.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import type { Hangar } from '../hangar.ts';
import { platform } from '../platform/index.ts';
import { processTable } from '../procs.ts';
import { roleUrl } from '../ports.ts';
import { blank, heading, note, ok, warn } from '../ui.ts';
import { tildify } from '../user-paths.ts';

/**
 * `hangar bookmarks sync` -- one folder per bookmarked port role on Brave's Bookmarks bar, one
 * link per clone.
 *
 * Which roles, and what the folder and the link's label are called, is `ports.roles[].bookmark`
 * in the config; nothing here knows what an Angular dev server or a Storybook is.
 *
 * **Brave must not be running, and this is the whole reason the command refuses.** The browser
 * holds its bookmarks in memory and rewrites the file from there, so an edit made behind its back
 * is silently overwritten the next time it saves -- a command that reported success and changed
 * nothing. `-n` is exempt because it writes nothing.
 */
export type BookmarksSyncOptions = {
  readonly dryRun?: boolean | undefined;
  readonly profile?: string | undefined;
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
 * Whether a Brave browser process is in `commands`. PURE.
 *
 * Only the main process counts: on macOS the helpers are `Brave Browser Helper …` and on Linux
 * they carry `--type=`, and a crash handler is a different binary again.
 */
export const braveIsRunning = (commands: Iterable<string>): boolean => {
  for (const command of commands) {
    if (command.includes(' --type=')) continue;
    if (/(?:MacOS\/Brave Browser|\/brave(?:-browser)?)(?: --|$)/.test(command)) return true;
  }
  return false;
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

const bookmarksPath = (profile: string): string => {
  if (profile === '' || /[\\/]/.test(profile) || profile === '..') {
    throw new CliError(`"${profile}" is not a Brave profile directory name`, 'Try Default.');
  }
  const base = platform().machineConfigDir;
  if (base === '') {
    throw new CliError(
      `no known place for Brave's profile on ${platform().id}`,
      'bookmarks sync supports macOS and Linux.',
    );
  }
  return join(base, 'BraveSoftware', 'Brave-Browser', profile, 'Bookmarks');
};

export const bookmarksSync = (hangar: Hangar, opts: BookmarksSyncOptions = {}): void => {
  const dryRun = opts.dryRun === true;
  const path = bookmarksPath(opts.profile ?? 'Default');
  const specs = bookmarkSpecs(discoverClones(hangar));
  if (specs.length === 0) {
    warn('no port role has a bookmark: key, so there is nothing to put in the browser');
    note('add `bookmark: { folder: …, label: … }` to a ports.roles[] entry');
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new CliError(
      `cannot read ${tildify(path)}`,
      'Start Brave once so it creates its profile, or name another one with --profile.',
    );
  }
  let file: BookmarksFile;
  try {
    file = JSON.parse(raw) as BookmarksFile;
  } catch {
    throw new CliError(`${tildify(path)} is not valid JSON`, 'Nothing was changed.');
  }

  heading(dryRun ? 'Would sync Brave bookmarks' : 'Syncing Brave bookmarks');
  note(tildify(path));
  const { next, changes } = buildBookmarks(file, specs, new Date(), randomUUID);
  if (changes.length === 0) {
    ok('already up to date');
    return;
  }
  for (const change of changes) note(describeChange(change));
  if (dryRun) return;

  if (braveIsRunning([...processTable().values()].map((row) => row.command))) {
    throw new CliError(
      'Brave is running, and it would overwrite the change from memory',
      'Quit Brave (Cmd-Q), run this again, then reopen it. `-n` shows the change without writing.',
    );
  }
  /*
   * A sibling file renamed over the original: Brave, or a second `bookmarks sync`, never sees a
   * half-written file. The three-space indent is the browser's own, which keeps the next diff
   * against its `.bak` down to what changed.
   */
  const staging = `${path}.hangar-tmp`;
  writeFileSync(staging, `${JSON.stringify(next, null, 3)}\n`, { mode: statSync(path).mode });
  renameSync(staging, path);
  blank();
  ok(`${String(changes.length)} change${changes.length === 1 ? '' : 's'} written`);
};
