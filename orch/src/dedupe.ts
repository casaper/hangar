import { createHash } from 'node:crypto';
import { linkSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { run } from './exec.ts';
import { issueKeysIn } from './jira.ts';

/**
 * Duplicate content in the shared `tmp/` store, and the two very different things it means.
 *
 * The Jira cache duplicates by design. `.claude/skills/jira-scope/SKILL.md` gives a directory
 * only to the ticket the user ASKED about, so a ticket fetched as someone else's relation is
 * written into that someone else's directory: `ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md`
 * is ABC-1323. **The last issue key in the name is what the file is about**; the keys before it
 * only say how it was reached.
 *
 * So "the same ticket" turns up under several names, and there are two cases:
 *
 * - **Byte-identical copies.** Real duplication, and safe to collapse into one inode, which is
 *   what `jdupes -L` does. Attachments are the ones that matter: a 4 MB screen recording
 *   fetched under two relation paths is the same file twice.
 * - **Copies that differ.** Reported, never touched -- see `nearDuplicates`. The skill's own
 *   template puts `relation:` and `relatedTo:` in a relation copy's frontmatter and omits them
 *   from the ticket's own file, and every copy carries its own `fetched:` timestamp, so two
 *   renderings of one ticket are REQUIRED to differ. Hard-linking them would mean picking one
 *   and destroying the other's relation metadata -- and the skill says in as many words:
 *   "the duplication between the two is intended ... Never dedupe them."
 *
 * Content matching is delegated to `jdupes` rather than reimplemented: size, then partial hash,
 * then full compare, and it treats already-linked files as non-duplicates so a second run does
 * nothing. `fdupes` is not an alternative -- it has no hard-link action at all.
 */

/** `jdupes` also refuses to consider these, but the reasons are worth stating here. */
const JDUPES_ARGS = [
  '-r', // the store is one directory per ticket
  '-q', // no progress meter into the command's output
  // PID files are per clone and never shared -- two clones' identical pid files becoming one
  // inode would make one clone's dev server the other's, which is the whole reason `tmp merge`
  // never carries them into the store in the first place.
  '-X',
  'noext:pid',
  '-A', // and no dotfiles: `.gitkeep`, `.DS_Store`
];

export type DuplicateSets = {
  /** Each set is a group of byte-identical paths, relative to the store. */
  readonly sets: readonly (readonly string[])[];
  readonly files: number;
  readonly bytes: number;
};

/** Whether `jdupes` is available at all -- without it the linking pass is skipped, not failed. */
export const hasJdupes = (): boolean => run('jdupes', ['--version']).ok;

/**
 * What `jdupes` would link, without linking it. `-M` prints the match sets and a summary.
 *
 * Blank lines separate the sets; the summary line is the one carrying "duplicate files".
 */
export const duplicateSets = (dir: string): DuplicateSets => {
  const res = run('jdupes', [...JDUPES_ARGS, '-M', dir]);
  const sets: string[][] = [];
  let current: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const line of res.stdout.split('\n')) {
    const summary = /^(\d+) duplicate files.*occupying ([\d.]+) (\w+)/.exec(line.trim());
    if (summary?.[1] !== undefined) {
      files = Number.parseInt(summary[1], 10);
      bytes = sizeToBytes(Number.parseFloat(summary[2] ?? '0'), summary[3] ?? 'bytes');
      continue;
    }
    if (line.trim() === '') {
      if (current.length > 0) sets.push(current);
      current = [];
      continue;
    }
    current.push(relative(dir, line));
  }
  if (current.length > 0) sets.push(current);
  return { sets, files, bytes };
};

const sizeToBytes = (value: number, unit: string): number => {
  const scale = { bytes: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit];
  return Math.round(value * (scale ?? 1));
};

/** Hard-link every byte-identical duplicate under `dir`. Idempotent. */
export const hardLinkDuplicates = (dir: string): { ok: boolean; error: string } => {
  const res = run('jdupes', [...JDUPES_ARGS, '-L', dir]);
  return { ok: res.ok, error: res.stderr.trim() };
};

export type CacheSubject = {
  /** The ticket the file is about: the LAST issue key in its name. */
  readonly key: string;
  /** The name that file would have in its own ticket's directory. */
  readonly canonical: string;
};

/**
 * What a cache file is about, from its name alone.
 *
 * `ticket_ABC-1325_relates_to_ABC-1323.md` -> ABC-1323, canonically `ticket_ABC-1323.md`.
 * `ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png` -> ABC-1191, canonically
 * `ticket_ABC-1191_asset_shot.png` -- so it matches the same attachment fetched directly.
 *
 * The kind prefix (`ticket_`, `plan_`, `pr_description_`) and everything after the last key
 * are kept, because they are what distinguishes one file about a ticket from another.
 */
export const cacheSubjectOf = (fileName: string): CacheSubject | undefined => {
  const keys = issueKeysIn(fileName);
  const first = keys[0];
  const last = keys.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return {
    key: last.key,
    canonical: fileName.slice(0, first.start) + last.key + fileName.slice(last.end),
  };
};

export type Copy = {
  readonly path: string;
  /** `ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md` -- enough to identify it in output. */
  readonly rel: string;
  readonly bytes: number;
  /** When this rendering was taken, as ms. */
  readonly at: number;
  readonly source: 'fetched' | 'updated' | 'mtime';
  /** Last write, from the filesystem -- what says whether someone is working on it NOW. */
  readonly mtime: number;
  /**
   * True when this copy lives in ANOTHER ticket's directory, i.e. it was fetched as a relation
   * and carries `relation:`/`relatedTo:` frontmatter.
   *
   * From the directory, not the filename: the skill's layout guarantees that a directory is
   * named for the ticket it is about, so `dirname !== subject` IS the definition. Parsing the
   * relation segment out of the name again would be a second, weaker parser of the same fact.
   */
  readonly relationCopy: boolean;
};

export type SameTicketGroup = {
  readonly key: string;
  readonly canonical: string;
  /** Freshest first. */
  readonly copies: readonly Copy[];
  /** Every copy is already one inode -- nothing to do. */
  readonly linked: boolean;
  /** Same bytes, separate inodes -- `jdupes` territory. */
  readonly identical: boolean;
  /** Differing Markdown, which `resolve` can collapse onto the freshest copy. */
  readonly resolvable: boolean;
  /**
   * A copy was written moments ago, so a live session may be mid-refresh.
   *
   * Collapsing then would replace a file being written with the other copy's content. Both
   * shared directories already work this way -- "anything a live session may still be writing
   * is left where it is and reported" -- and this pass is the one that had no such rule.
   */
  readonly busy: boolean;
};

/** Long enough to cover a `jira-cache.mjs` fetch and the writes that follow it. */
const RECENT_MS = 120_000;

const filesUnder = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith('.') && !name.endsWith('.pid'))
    .flatMap((name) => {
      const path = join(dir, name);
      try {
        return statSync(path).isDirectory() ? filesUnder(path) : [path];
      } catch {
        return [];
      }
    });
};

const hashOf = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const readHead = (path: string): string => {
  try {
    return readFileSync(path, 'utf8').slice(0, 4096);
  } catch {
    return '';
  }
};

const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** `+0200` is ISO 8601 basic but not the format `Date` is specified to accept -- normalise it. */
const parseStamp = (value: string): number | undefined => {
  const at = Date.parse(value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(at) ? undefined : at;
};

/**
 * When a cache file's rendering was taken.
 *
 * `fetched:` is the answer: the skill's template mandates it on every file it writes and calls
 * it "what tells the user whether they are looking at today's ticket or last week's". Jira's
 * own `updated:` is only a fallback -- it is written on a ticket's OWN file and left off the
 * relation copies, so it cannot rank the two against each other, and it can be older than the
 * ticket state a later fetch captured. Read out of the leading frontmatter block only, never
 * the body, which quotes comments that can contain anything.
 */
export const freshnessOf = (path: string): { at: number; source: Copy['source'] } => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readHead(path))?.[1] ?? '';
  for (const source of ['fetched', 'updated'] as const) {
    const raw = new RegExp(`^${source}:\\s*(.+)$`, 'm').exec(frontmatter)?.[1];
    const at = raw === undefined ? undefined : parseStamp(raw);
    if (at !== undefined) return { at, source };
  }
  return { at: mtimeOf(path), source: 'mtime' };
};

/**
 * Every file in the store that shares a ticket with another, grouped.
 *
 * The comparison is **by ticket id first** -- `cacheSubjectOf`, so the last key in the name
 * wins -- **and then by content**. The id groups `ABC-1323/ticket_ABC-1323.md` with
 * `ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md`; the content decides what can be done with
 * them. The kind prefix and the tail stay part of the group key, because `plan_ABC-1317.md` and
 * `ticket_ABC-1317.md` are both about ABC-1317 without being the same document.
 */
export const sameTicketGroups = (dir: string): SameTicketGroup[] => {
  const groups = new Map<string, { key: string; paths: string[] }>();
  for (const path of filesUnder(dir)) {
    const subject = cacheSubjectOf(basename(path));
    if (subject === undefined) continue;
    const group = groups.get(subject.canonical) ?? { key: subject.key, paths: [] };
    group.paths.push(path);
    groups.set(subject.canonical, group);
  }

  const found: SameTicketGroup[] = [];
  for (const [canonical, { key, paths }] of groups) {
    if (paths.length < 2) continue;
    const copies: Copy[] = paths
      .map((path) => {
        const { at, source } = freshnessOf(path);
        const stat = statSync(path);
        return {
          path,
          rel: `${basename(dirname(path))}/${basename(path)}`,
          bytes: stat.size,
          at,
          source,
          mtime: stat.mtimeMs,
          relationCopy: basename(dirname(path)) !== key,
        };
      })
      .sort((a, b) => b.at - a.at || a.rel.localeCompare(b.rel));
    const identical = new Set(paths.map(hashOf)).size === 1;
    const now = Date.now();
    found.push({
      key,
      canonical,
      copies,
      linked: new Set(paths.map((path) => statSync(path).ino)).size === 1,
      identical,
      resolvable: !identical && paths.every((path) => path.endsWith('.md')),
      busy: copies.some((copy) => now - copy.mtime < RECENT_MS),
    });
  }
  return found.sort((a, b) => a.canonical.localeCompare(b.canonical));
};

/**
 * Point `loser` at `winner`'s content, as a hard link.
 *
 * Link-then-rename, so the path is never briefly missing and a session reading the cache sees
 * either the old file or the new link. `renameSync` over an existing name is atomic on POSIX.
 */
export const linkToWinner = (winner: string, loser: string): void => {
  const staging = `${loser}.linking-${String(process.pid)}`;
  try {
    linkSync(winner, staging);
    renameSync(staging, loser);
  } catch (error) {
    try {
      rmSync(staging);
    } catch {
      // Nothing staged, or already gone -- the original is untouched either way.
    }
    throw error;
  }
};
