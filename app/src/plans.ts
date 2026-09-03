import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, utimesSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run } from './exec.ts';
import { discoverClones, type Clone } from './fleet.ts';
import { fleetPlans, tildify, userPlans } from './paths.ts';
import { firstMentionOf, planFilesEverMentioned } from './sessions.ts';

/**
 * The shared plan archive, and the dates that go in front of the filenames.
 *
 * Plans cannot simply be pointed at one shared directory: Claude Code resolves
 * `plansDirectory` against the project root and then requires the result to stay inside it
 * even after following symlinks, so every clone keeps its own real `.claude/plans` and this
 * module moves finished plans into `<fleet>/plans` instead.
 *
 * Dating them is harder than it looks. An earlier consolidation copied 157 plans into
 * `~/.claude/dvb-gn-plans` WITHOUT preserving timestamps, so all of them report the same
 * birthtime and mtime to the second; and Claude Code rewrites a plan atomically, which resets
 * birthtime on the files it is still working on. So `stat` alone is not a trustworthy source,
 * and the date is resolved from four signals in order of reliability.
 */

/** `2026-06-05_-_name.md`, matching the 149 files that already carry a prefix. */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})(?:_-_|-)/;
const STAMP_SEP = '_-_';

export const isStamped = (name: string): boolean => STAMP_RE.test(name);

export const stemOf = (name: string): string => name.replace(STAMP_RE, '');

export const stampedName = (day: string, stem: string): string => `${day}${STAMP_SEP}${stem}`;

/** A local calendar day, so a plan written at 00:30 is not dated the day before. */
export const isoDay = (when: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
};

const dayFromName = (name: string): string | undefined => STAMP_RE.exec(name)?.[1];

const hashOf = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

export type PlanFile = {
  readonly path: string;
  /** Where it came from, for reporting and for the `.from-<source>` conflict suffix. */
  readonly source: string;
  readonly name: string;
  readonly stem: string;
  readonly hash: string;
  readonly birthMs: number;
  readonly mtimeMs: number;
};

export const planFilesIn = (dir: string, source: string): PlanFile[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: PlanFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const path = join(dir, entry);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      files.push({
        path,
        source,
        name: entry,
        stem: stemOf(entry),
        hash: hashOf(path),
        birthMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Unreadable is not collectable.
    }
  }
  return files;
};

/**
 * A clone's plan directories. Normally just `.claude/plans`, but a session started in a
 * subdirectory (`angular/`) can resolve the project root there and create a second one, which
 * is worth collecting and worth reporting.
 */
export const planDirsIn = (clone: Clone): string[] => {
  const root = join(clone.path, '.claude', 'plans');
  const nested = run('find', [
    clone.path,
    '-maxdepth',
    '4',
    '-type',
    'd',
    '-path',
    '*/.claude/plans',
    '-not',
    '-path',
    '*/node_modules/*',
  ]);
  const found = nested.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== root);
  return [...(existsSync(root) ? [root] : []), ...found];
};

export type PlanSource = { readonly dir: string; readonly label: string };

/** Everywhere a fleet plan can currently be, in the order the archive should prefer. */
export const planSources = (): PlanSource[] => {
  const sources: PlanSource[] = [];
  for (const clone of discoverClones()) {
    for (const dir of planDirsIn(clone)) {
      sources.push({ dir, label: dir.endsWith(join('.claude', 'plans')) ? clone.name : dir });
    }
  }
  if (existsSync(userPlans)) sources.push({ dir: userPlans, label: tildify(userPlans) });
  return sources;
};

/**
 * Timestamps that mean "this file was bulk-copied", not "this is when the plan was written".
 *
 * Detected rather than hardcoded: a copy stamps birthtime and mtime identically, and stamps
 * many files with the same second. One plan can legitimately have birthtime == mtime (written
 * once, never edited); ten sharing the very same second cannot.
 */
const BULK_COPY_MIN_FILES = 10;

export const bulkCopySeconds = (files: readonly PlanFile[]): Set<number> => {
  const counts = new Map<number, number>();
  for (const file of files) {
    if (Math.trunc(file.birthMs / 1000) !== Math.trunc(file.mtimeMs / 1000)) continue;
    const second = Math.trunc(file.mtimeMs / 1000);
    counts.set(second, (counts.get(second) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= BULK_COPY_MIN_FILES).map(([s]) => s));
};

export type DatedPlan = { readonly day: string; readonly from: string };

/** The date to put in front of a plan, and which signal produced it. */
export const resolveDay = (
  files: readonly PlanFile[],
  bulk: ReadonlySet<number>,
  scanTranscripts: boolean,
): DatedPlan | undefined => {
  const fromName = files.map((f) => dayFromName(f.name)).find((day) => day !== undefined);
  if (fromName !== undefined) return { day: fromName, from: 'filename' };

  const stats = files
    .flatMap((f) => [f.birthMs, f.mtimeMs])
    .filter((ms) => ms > 0 && !bulk.has(Math.trunc(ms / 1000)));
  if (stats.length > 0) return { day: isoDay(new Date(Math.min(...stats))), from: 'stat' };

  if (scanTranscripts) {
    for (const file of files) {
      const mention = firstMentionOf(file.name);
      if (mention !== undefined) return { day: isoDay(mention), from: 'transcript' };
    }
  }
  return undefined;
};

/** True when a fleet session has ever mentioned this plan file -- the attribution signal. */
export const fleetAttribution = (): ReadonlySet<string> => planFilesEverMentioned();

/**
 * Set the resolved date as the file's mtime, so it survives in the archive. Without this, a
 * plan that arrived carrying a bulk-copy timestamp would need the transcript scan again on
 * every later `stamp` run.
 */
export const setMtimeToDay = (path: string, day: string): void => {
  const when = new Date(`${day}T12:00:00`);
  if (Number.isNaN(when.getTime())) return;
  try {
    utimesSync(path, when, when);
  } catch {
    // A failed timestamp is cosmetic; the filename already carries the date.
  }
};

/** Move within the archive (or into it), never across a filesystem in practice. */
export const moveInto = (from: string, to: string): void => {
  renameSync(from, to);
};

export const archiveNames = (): Set<string> => {
  try {
    return new Set(readdirSync(fleetPlans));
  } catch {
    return new Set();
  }
};

export const conflictName = (name: string, source: string): string =>
  `${basename(name, '.md')}.from-${source}.md`;
