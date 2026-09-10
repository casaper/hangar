import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CONFLICT_MARKER } from './adopt.ts';

/**
 * Where a pull request's title and body come from, and how we know they still describe the branch.
 *
 * A reviewer-facing description is not something a deterministic CLI can write, so `pr create` does
 * not try: the repo's own agent writes one into the shared `tmp/` store and this module FINDS it.
 * That split is the same one `resolve-conflicts.ts` makes for merge conflicts, and for the same
 * reason -- the CLI owns the mechanism and the judgement belongs to something that can read a diff.
 *
 * ## The name is matched, never constructed
 *
 * Hangar manages any repo, so the filename convention cannot be hardcoded: this fleet has used
 * `pr-ABC-1323.md` at the top level and `ABC-1323/pr_description_ABC-1323.md` in the ticket's own
 * directory, and the next hangar will use neither. So both shapes are matched by PATTERN, keyed on
 * the issue key `inferTicket` already derives from the branch, and a hangar whose agent writes a
 * third shape needs no change here as long as the name starts with `pr` and names the ticket.
 *
 * Only two places are looked in, rather than walking the store: the top level, and the directory
 * named for the key. The store here holds a couple of hundred ticket directories, and a full walk
 * to find one file would be paid on every invocation.
 *
 * **The root the caller passes is the CLONE's own `tmp/`, not the hangar's.** Every entry under a
 * clone's `tmp/` is a symlink into the shared store, so that root reaches everything the store
 * holds -- but a ticket directory the clone's own agent created during the session that is still
 * running is a REAL directory there and has not been merged into the store yet. `tmp merge` runs
 * at `SessionEnd`, which is strictly after the moment somebody wants a pull request for the branch
 * they have just had described.
 *
 * ## A keyless description is found and DISTRUSTED
 *
 * A branch with no issue key in its name is legal and gets a flat, branch-independent filename --
 * which is exactly the problem, because `tmp/` is shared across every clone and last-writer-wins.
 * The file found that way belongs to whichever clone wrote it last, and nothing in the name says
 * which. It is still offered, because refusing would leave a chore branch no route through this
 * command at all, but it is marked `trusted: false` so the caller can put the path and the title in
 * front of a human before anything is published.
 *
 * `.from-<clone>` conflict copies are skipped outright. `tmp merge` writes one when two clones
 * disagree about an entry, so it is by construction the copy that did NOT win, and picking it up
 * silently would publish the losing half of a conflict.
 *
 * ## Freshness is one comparison, and the store is why it is needed
 *
 * The description's mtime against the branch tip's committer timestamp. Older means the file
 * predates commits it therefore cannot describe -- a pull request that reads as complete and is
 * missing whatever landed since. With one clone that would be an edge case; with a shared,
 * last-writer-wins store and six clones it is the normal way this goes wrong.
 */
export type DescriptionCandidate = {
  readonly path: string;
  readonly mtimeMs: number;
  /** Whether the NAME ties this file to one branch. False for the keyless fallback. */
  readonly trusted: boolean;
};

/**
 * `pr…<KEY>….md`, case-insensitively on the fixed parts and exactly on the key.
 *
 * The key is exact because it is the only part of the name that makes the file this branch's:
 * matching `abc-1323` against `ABC-1323` would be a kindness with no upside, since `inferTicket`
 * reads the key out of the branch with a case-sensitive pattern in the first place.
 */
export const descriptionNameRe = (key: string): RegExp =>
  new RegExp(`^pr.*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.md$`, 'i');

/** The flat fallback for a branch whose name carries no issue key. */
export const KEYLESS_NAME_RE = /^pr.*description.*\.md$/i;

/** A `tmp merge` conflict copy -- the half that lost. Never a candidate. */
export const isConflictCopy = (name: string): boolean => name.includes(CONFLICT_MARKER);

/**
 * The newest of the files found.
 *
 * Every candidate in one search has the same `trusted`, because a keyed search and the keyless
 * fallback are different searches -- so recency is the only thing left to rank on, and it is the
 * right one: the store is rewritten in place by whichever clone regenerated last.
 */
export const pickDescription = (
  candidates: readonly DescriptionCandidate[],
): DescriptionCandidate | undefined => [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

const filesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const candidateAt = (path: string, trusted: boolean): DescriptionCandidate | undefined => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { path, mtimeMs: stat.mtimeMs, trusted } : undefined;
  } catch {
    // A dangling link into the store is not a description. `tmp merge` leaves none, but a
    // half-finished one interrupted mid-move can.
    return undefined;
  }
};

/**
 * Every description file in the shared store that could be this branch's.
 *
 * `statSync` rather than `lstatSync` on purpose: every entry under a clone's own `tmp/` is a
 * symlink into this store, and the store's own entries are real files -- so following the link is
 * what makes the same search work from either side.
 */
export const descriptionsIn = (tmpDir: string, key: string | undefined): DescriptionCandidate[] => {
  if (key === undefined) {
    return filesIn(tmpDir)
      .filter((name) => KEYLESS_NAME_RE.test(name) && !isConflictCopy(name))
      .flatMap((name) => candidateAt(join(tmpDir, name), false) ?? []);
  }
  const named = descriptionNameRe(key);
  const top = filesIn(tmpDir)
    .filter((name) => named.test(name) && !isConflictCopy(name))
    .flatMap((name) => candidateAt(join(tmpDir, name), true) ?? []);
  const inTicketDir = filesIn(join(tmpDir, key))
    .filter((name) => /^pr.*\.md$/i.test(name) && !isConflictCopy(name))
    .flatMap((name) => candidateAt(join(tmpDir, key, name), true) ?? []);
  return [...top, ...inTicketDir];
};

export type PrText = {
  /** The first `# ` heading, minus the marker. `''` when the file has none. */
  readonly title: string;
  /** Everything after that heading. The whole file when there is no heading. */
  readonly body: string;
};

/**
 * The file's first `# ` line is the title and the rest is the body.
 *
 * That is the split the description is WRITTEN to -- the heading exists so the title can be lifted
 * out of the file and pasted into the form's own field, which is the manual step this command
 * replaces. So this reads a convention rather than imposing one.
 *
 * A file with no heading yields an empty title and its whole content as the body, and the caller
 * refuses: inventing a title from the first sentence would publish a guess, and a title is the one
 * field of a pull request nobody can avoid reading.
 */
export const splitDescription = (content: string): PrText => {
  const lines = content.split('\n');
  const at = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (at === -1) return { title: '', body: content.trim() };
  return {
    title: (lines[at] ?? '').replace(/^#\s+/, '').trim(),
    body: lines
      .slice(at + 1)
      .join('\n')
      .trim(),
  };
};

export type DescriptionState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'stale'; readonly file: DescriptionCandidate; readonly tipMs: number }
  | { readonly kind: 'fresh'; readonly file: DescriptionCandidate };

/**
 * Whether the description was written after the commit it has to describe.
 *
 * `tipMs` is milliseconds, so a caller reading `git log -1 --format=%ct` -- which is SECONDS --
 * multiplies on the way in. Both are epoch numbers of the same shape, which is exactly the
 * mistake worth naming: a seconds value compared against an mtime makes every file look fresh.
 */
export const descriptionState = (
  file: DescriptionCandidate | undefined,
  tipMs: number,
): DescriptionState => {
  if (file === undefined) return { kind: 'missing' };
  return file.mtimeMs >= tipMs ? { kind: 'fresh', file } : { kind: 'stale', file, tipMs };
};
