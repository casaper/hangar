import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import pc from 'picocolors';

import { adoptInto, type AdoptAction } from '../adopt.ts';
import { excludePath, EXCLUDE_BLOCK, missingExcludeLines } from '../clone-config.ts';
import { CliError } from '../exec.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import { fleetTmp, jiraStore, tildify } from '../paths.ts';
import {
  cloneTmpPath,
  isPrivateTmpEntry,
  linkTargetOf,
  shareableStoreEntries,
  strayPidFilesInStore,
  tmpIsSymlink,
} from '../tmp.ts';
import { cloneLabel, heading, note, ok, step, warn } from '../ui.ts';

/**
 * `orch-util tmp merge` -- put every clone's shareable `tmp/` content in one place.
 *
 * Each clone KEEPS its own `tmp/` directory and its own PID files in it. What moves is the
 * content that belongs to no clone in particular -- the per-ticket Jira cache, the PR
 * descriptions, whatever else the skills leave there -- which ends up in `<fleet>/tmp/<name>`
 * with a symlink at `clone_NN/tmp/<name>` in every clone. See `tmp.ts` for why the links go
 * one level down instead of `tmp/` itself being one.
 *
 * Three passes, in this order, and the order is what keeps it safe:
 *
 * 1. A clone whose whole `tmp` is a symlink to the store -- what an earlier version of this
 *    command produced -- gets its own directory back.
 * 2. The legacy `~/.claude/dvb-gn-jira` store is drained into the fleet store. FIRST, because
 *    every clone's `tmp/<KEY>` currently points into it: draining it before the links are
 *    rebuilt is what stops any of them dangling in between.
 * 3. Each clone's remaining real entries are adopted into the store, then every shareable
 *    store entry is linked back into every clone.
 *
 * Idempotent, and nothing is ever overwritten: byte-identical copies collapse to one and
 * anything that differs is kept beside the winner as `<name>.from-clone_NN` (see `adopt.ts`).
 * A running dev server is no obstacle -- its PID file is never read, moved or linked.
 */
export type TmpMergeOptions = { dryRun?: boolean | undefined };

type Counts = Map<string, number>;

const bump = (counts: Counts, kind: string): void => {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
};

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

/** A link this fleet maintains: into the store, or into the legacy store it replaces. */
const isOurLink = (target: string): boolean =>
  isInside(target, fleetTmp) || isInside(target, jiraStore);

/**
 * Pass 1: undo the whole-directory symlink an earlier version of this command created.
 *
 * The clone gets an empty real `tmp/` back; pass 3 fills it with links. Anything that was in
 * the shared directory stays in the shared directory -- it is the store now.
 */
const restoreOwnTmp = (clone: Clone, dryRun: boolean): boolean => {
  if (!tmpIsSymlink(clone)) return false;
  const tmp = cloneTmpPath(clone);
  warn(`tmp/ is a symlink to the store — giving ${clone.name} its own directory back`);
  note('The whole directory was shared by an earlier version; PID files belong to one clone.');
  if (!dryRun) {
    rmSync(tmp);
    mkdirSync(tmp, { recursive: true });
  }
  return true;
};

/** Pass 2: the legacy per-ticket store becomes part of the fleet store, then goes away. */
const drainLegacyStore = (dryRun: boolean, counts: Counts): string[] => {
  if (!existsSync(jiraStore)) return [];
  step(`${tildify(jiraStore)} → ${tildify(fleetTmp)}`);
  const moved: string[] = [];
  for (const entry of readdirSync(jiraStore)) {
    const actions = adoptInto(join(jiraStore, entry), fleetTmp, { label: 'jira-store', dryRun });
    report(actions, counts);
    moved.push(entry);
  }
  if (!dryRun) {
    try {
      rmdirSync(jiraStore);
      ok(`removed the empty ${tildify(jiraStore)}`);
    } catch {
      warn(`${tildify(jiraStore)} is not empty — left in place`);
    }
  }
  return moved;
};

const report = (actions: readonly AdoptAction[], counts: Counts): void => {
  for (const action of actions) {
    bump(counts, action.kind);
    if (action.kind === 'conflict' || action.kind === 'skipped') warn(action.message);
    else note(pc.dim(action.message));
  }
};

/**
 * Pass 3a: move a clone's own cache into the store.
 *
 * Returns the entry names it contributed, so a DRY RUN can still say what would be linked
 * back -- on a real run the store is simply read again.
 */
const adoptCloneEntries = (clone: Clone, dryRun: boolean, counts: Counts): string[] => {
  const tmp = cloneTmpPath(clone);
  const contributed: string[] = [];
  for (const entry of readdirSync(tmp)) {
    const path = join(tmp, entry);
    if (entry === '.DS_Store') {
      note(pc.dim(`${entry}: junk, removing`));
      if (!dryRun) rmSync(path);
      continue;
    }
    if (isPrivateTmpEntry(clone, entry)) continue;

    // Handled here rather than by `adoptInto`, whose symlink branch decides by RESOLVING the
    // target: a link into the legacy store resolves to nothing once pass 2 has drained it, and
    // one into a store entry that pass 2 could not remove resolves to stale content beside a
    // fresh copy. By recorded target instead -- ours goes, a link somewhere else is the
    // developer's and is left alone -- and pass 3b puts ours back.
    const target = linkTargetOf(path);
    if (target !== undefined) {
      // Already exactly the link pass 3b would make: left alone, so a re-run does not delete
      // and recreate every link in the fleet -- which churns them for nothing and leaves a
      // window where a session looking for its ticket cache finds none.
      if (target === join(fleetTmp, entry)) continue;
      if (!isOurLink(target)) warn(`${entry}: symlink to ${tildify(target)} — left alone`);
      else if (!dryRun) rmSync(path);
      continue;
    }

    report(adoptInto(path, fleetTmp, { label: clone.name, dryRun }), counts);
    contributed.push(entry);
  }
  return contributed;
};

/**
 * Pass 3b: every shareable store entry gets a symlink in this clone.
 *
 * `lstat`, not `existsSync`: a dangling link has to be replaced (and reads as absent to
 * `existsSync`), while a real file or directory left behind by a skipped adoption has to be
 * left where it is -- `symlinkSync` would throw EEXIST on it either way.
 */
type LinkOptions = {
  /** What pass 3a moved out of this clone -- still on disk during a dry run. */
  readonly movedAway: ReadonlySet<string>;
  /** True for a clone whose `tmp` is being replaced wholesale -- see `restoreOwnTmp`. */
  readonly tmpWillBeEmpty: boolean;
  readonly dryRun: boolean;
};

const linkStoreEntries = (
  clone: Clone,
  entries: readonly string[],
  { movedAway, tmpWillBeEmpty, dryRun }: LinkOptions,
): { linked: number; already: number } => {
  const tmp = cloneTmpPath(clone);
  let linked = 0;
  let already = 0;
  for (const name of entries) {
    const path = join(tmp, name);
    const wanted = join(fleetTmp, name);
    const target = linkTargetOf(path);
    if (target === wanted) {
      already += 1;
      continue;
    }
    // Both exemptions are dry-run-only, and both are the command's own preview showing up as
    // an obstacle: an entry pass 3a reported as moving to the store is still sitting here, and
    // a clone whose `tmp` symlink has not actually been replaced yet can still see every store
    // entry through it. On a real run the name is free -- and a name that is NOT free is a
    // skipped adoption, which must be left exactly where it is.
    const mine = movedAway.has(name) || tmpWillBeEmpty;
    if (target === undefined && existsSync(path) && !(dryRun && mine)) {
      warn(`${name}: a real file or directory is in the way — not linked`);
      continue;
    }
    linked += 1;
    if (!dryRun) {
      if (target !== undefined) rmSync(path);
      symlinkSync(wanted, path);
    }
  }
  return { linked, already };
};

export const tmpMerge = (opts: TmpMergeOptions): void => {
  const dryRun = opts.dryRun === true;
  const clones = discoverClones();
  if (clones.length === 0) throw new CliError('no clones found');

  heading(
    `Sharing every clone's tmp/ cache through ${tildify(fleetTmp)}${dryRun ? pc.dim(' (dry run)') : ''}`,
  );
  note('PID files stay in the clone that wrote them — they are never moved, linked or read.');
  if (!dryRun) mkdirSync(fleetTmp, { recursive: true });

  const counts: Counts = new Map();
  // What the store will hold: what it holds now, plus everything the passes below move into
  // it. Tracked as a set so a dry run -- which moves nothing -- can still say what would be
  // linked back into each clone.
  const projected = new Set<string>(existsSync(fleetTmp) ? readdirSync(fleetTmp) : []);
  for (const entry of drainLegacyStore(dryRun, counts)) projected.add(entry);

  // Every clone contributes BEFORE any clone is linked. One pass per clone would link the
  // first clone before the second had contributed, so a `<name>.from-clone_02` conflict copy
  // created in the second clone would reach every clone except the first -- and the fix would
  // be "run it again", which is the kind of thing nobody discovers.
  const contributed = new Map<string, Set<string>>();
  const restoredTmp = new Set<string>();
  /** Which clones offer each name -- how a dry run can see a conflict that has not happened. */
  const contributors = new Map<string, string[]>();
  for (const clone of clones) {
    heading(`${cloneLabel(clone)} ${pc.dim(tildify(cloneTmpPath(clone)))}`);
    // A clone being given its own tmp/ back contributes nothing: what it can currently see
    // through that symlink IS the store. Reading it as the clone's own would offer the store's
    // files back to the store -- and on a dry run the link is still in place, so it would
    // report exactly that.
    const restored = restoreOwnTmp(clone, dryRun);
    if (restored) restoredTmp.add(clone.name);
    const tmp = cloneTmpPath(clone);
    if (!existsSync(tmp) && !dryRun) mkdirSync(tmp, { recursive: true });
    const mine = new Set<string>();
    if (!restored && existsSync(tmp)) {
      for (const entry of adoptCloneEntries(clone, dryRun, counts)) {
        mine.add(entry);
        projected.add(entry);
        contributors.set(entry, [...(contributors.get(entry) ?? []), clone.name]);
      }
    }
    if (mine.size === 0 && !restored) note(pc.dim('nothing of its own to share'));
    contributed.set(clone.name, mine);
  }

  // `adoptInto` decides identical-or-conflicting by what is ON DISK, and a dry run has moved
  // nothing -- so two clones offering the same name both look like a clean move. The names are
  // enough to say a decision is coming, which beats a real run producing a `.from-clone_NN`
  // file the preview never mentioned.
  if (dryRun) {
    for (const [name, who] of contributors) {
      if (who.length < 2) continue;
      warn(`${name}: offered by ${who.join(' and ')}`);
      note('Identical copies collapse to one; if they differ the loser is kept beside it.');
    }
  }

  const entries = shareableStoreEntries(dryRun ? [...projected] : readdirSync(fleetTmp));
  heading(
    `${String(entries.length)} shared ${entries.length === 1 ? 'entry' : 'entries'} → a symlink in every clone's own tmp/`,
  );
  for (const clone of clones) {
    const { linked, already } = linkStoreEntries(clone, entries, {
      movedAway: contributed.get(clone.name) ?? new Set<string>(),
      tmpWillBeEmpty: restoredTmp.has(clone.name),
      dryRun,
    });
    const detail = [
      linked > 0 ? `${String(linked)} ${dryRun ? 'to link' : 'linked'}` : undefined,
      already > 0 ? pc.dim(`${String(already)} already`) : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(', ');
    ok(`${cloneLabel(clone)} ${detail === '' ? pc.dim('nothing to link') : detail}`);
    excludeCloneLocalMd(clone, dryRun);
  }

  // --- report ------------------------------------------------------------------------
  console.log('');
  const summary =
    counts.size === 0
      ? 'nothing to move'
      : [...counts].map(([kind, n]) => `${String(n)} ${kind}`).join(', ');
  ok(`${summary}${dryRun ? ' (dry run)' : ''}`);
  if ((counts.get('conflict') ?? 0) > 0) {
    note(
      'A conflict is kept beside the winner as `<name>.from-clone_NN` and linked into every ' +
        'clone like anything else — review the pair and delete the loser.',
    );
  }

  const strays = strayPidFilesInStore();
  if (strays.length > 0) {
    warn(`pid files in ${tildify(fleetTmp)}: ${strays.join(', ')}`);
    note('Never put there by this command — a clone whose whole tmp/ was the store wrote them.');
  }
};

/** The exclude file still has to hide `CLAUDE.local.md`; `tmp/` is covered by `.gitignore`. */
const excludeCloneLocalMd = (clone: Clone, dryRun: boolean): void => {
  const path = excludePath(clone);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const missing = missingExcludeLines(current);
  if (missing.length === 0) return;
  if (dryRun) {
    note(`.git/info/exclude would gain ${missing.join(', ')}`);
    return;
  }
  writeFileSync(path, current + EXCLUDE_BLOCK, 'utf8');
  ok(`.git/info/exclude hides ${missing.join(', ')}`);
};
