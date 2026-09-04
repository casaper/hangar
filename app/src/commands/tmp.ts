import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import pc from 'picocolors';

import { adoptInto, type AdoptAction } from '../adopt.ts';
import { excludePath, EXCLUDE_BLOCK, missingExcludeLines } from '../clone-config.ts';
import {
  duplicateSets,
  hardLinkDuplicates,
  hasJdupes,
  linkToWinner,
  sameTicketGroups,
} from '../dedupe.ts';
import {
  groupTicketRecords,
  isTicketRecordName,
  linkToStore,
  planGroup,
  storeContentFrom,
  writeStoreRecord,
} from '../jira-records.ts';
import { CliError } from '../exec.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import { fleetTmp, jiraTicketsDir, tildify } from '../paths.ts';
import {
  cloneTmpPath,
  isPrivateTmpEntry,
  linkTargetOf,
  shareableStoreEntries,
  strayPidFilesInStore,
  tmpIsSymlink,
} from '../tmp.ts';
import {
  blank,
  capturedProblems,
  captureOutput,
  cloneLabel,
  heading,
  note,
  ok,
  releaseCapture,
  step,
  warn,
  warnTransient,
} from '../ui.ts';

/**
 * `hangar tmp merge` -- put every clone's shareable `tmp/` content in one place.
 *
 * Each clone KEEPS its own `tmp/` directory and its own PID files in it. What moves is the
 * content that belongs to no clone in particular -- the per-ticket Jira cache, the PR
 * descriptions, whatever else the skills leave there -- which ends up in `<fleet>/tmp/<name>`
 * with a symlink at `clone_NN/tmp/<name>` in every clone. See `tmp.ts` for why the links go
 * one level down instead of `tmp/` itself being one.
 *
 * Two loops over the fleet, and the order between them is what keeps it safe -- every clone
 * contributes BEFORE any clone is linked, or a conflict copy created in the second clone would
 * reach every clone except the first:
 *
 * 1. Each clone contributes. A clone whose whole `tmp` is a symlink to the store -- what an
 *    earlier version of this command produced -- gets its own directory back (pass 1) and
 *    contributes nothing; otherwise its real entries are adopted into the store (pass 2a).
 * 2. Every shareable store entry is linked back into every clone (pass 2b).
 *
 * Idempotent, and nothing is ever overwritten: byte-identical copies collapse to one and
 * anything that differs is kept beside the winner as `<name>.from-clone_NN` (see `adopt.ts`).
 * A running dev server is no obstacle -- its PID file is never read, moved or linked.
 */
export type TmpMergeOptions = {
  dryRun?: boolean | undefined;
  /** Print nothing unless something needs a human -- for the `SessionEnd` hook. */
  quiet?: boolean | undefined;
};

type Counts = Map<string, number>;

const bump = (counts: Counts, kind: string): void => {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
};

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

/** A link this fleet maintains: one that points into the shared store. */
const isOurLink = (target: string): boolean => isInside(target, fleetTmp);

/**
 * Pass 1: undo the whole-directory symlink an earlier version of this command created.
 *
 * The clone gets an empty real `tmp/` back; pass 2 fills it with links. Anything that was in
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

const report = (actions: readonly AdoptAction[], counts: Counts): void => {
  for (const action of actions) {
    bump(counts, action.kind);
    if (action.kind === 'conflict' || action.kind === 'skipped') warn(action.message);
    else note(pc.dim(action.message));
  }
};

/**
 * Pass 2a: move a clone's own cache into the store.
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
    // target: a link into a store entry that pass 2a could not remove resolves to stale content
    // beside a fresh copy. By recorded target instead -- ours goes, a link somewhere else is the
    // developer's and is left alone -- and pass 2b puts ours back.
    const target = linkTargetOf(path);
    if (target !== undefined) {
      // Already exactly the link pass 2b would make: left alone, so a re-run does not delete
      // and recreate every link in the fleet -- which churns them for nothing and leaves a
      // window where a session looking for its ticket cache finds none.
      if (target === join(fleetTmp, entry)) {
        // Unless what it points at is gone. Deleting a store entry -- reviewing a
        // `.from-clone_NN` conflict copy, throwing away a note that has served its purpose --
        // otherwise leaves this link dangling in every clone for ever, since pass 2b only ever
        // iterates entries the store still HAS.
        if (existsSync(target)) continue;
        note(pc.dim(`${entry}: link to a store entry that is gone, removing`));
        if (!dryRun) rmSync(path);
        continue;
      }
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
 * Pass 2b: every shareable store entry gets a symlink in this clone.
 *
 * `lstat`, not `existsSync`: a dangling link has to be replaced (and reads as absent to
 * `existsSync`), while a real file or directory left behind by a skipped adoption has to be
 * left where it is -- `symlinkSync` would throw EEXIST on it either way.
 */
type LinkOptions = {
  /** What pass 2a moved out of this clone -- still on disk during a dry run. */
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
    // an obstacle: an entry pass 2a reported as moving to the store is still sitting here, and
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

/**
 * A `SessionEnd` hook runs this in every clone, which is the whole reason `--quiet` exists:
 * the routine outcome -- a brand-new ticket directory adopted, one a re-sync detached linked
 * back -- is what the hook is FOR, and a hook that announces it at the end of every session is
 * one nobody reads. So quiet mode holds the entire narration and prints it only if a `warn` or
 * a `fail` was raised: a conflict copy, a name that could not be linked, a record whose
 * frontmatter disagrees with its filename, a stray PID file. Silence about work, never about a
 * problem.
 *
 * A throw prints what was held regardless -- a swallowed narration is exactly the context
 * needed to read the error.
 */
export const tmpMerge = (opts: TmpMergeOptions): void => {
  const dryRun = opts.dryRun === true;
  if (opts.quiet !== true) {
    runMerge(dryRun);
    return;
  }
  captureOutput();
  try {
    runMerge(dryRun);
  } catch (error) {
    releaseCapture(true);
    throw error;
  }
  releaseCapture(capturedProblems() > 0);
};

const runMerge = (dryRun: boolean): void => {
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

  syncJiraStore(dryRun);
  dedupeStore(dryRun);

  // --- report ------------------------------------------------------------------------
  blank();
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

const MAX_LISTED = 8;

const kb = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;

/**
 * Collapse byte-identical files in the store into one inode, and report the same-ticket copies
 * that differ.
 *
 * One ticket reaches the store under several names -- `ticket_ABC-1325_relates_to_ABC-1323.md`
 * IS ABC-1323 -- so the cache holds real duplicates and near-duplicates side by side. Only the
 * first kind can be hard-linked; `dedupe.ts` has why the second kind must not be, and why
 * `jdupes` does the content matching.
 */
const dedupeStore = (dryRun: boolean): void => {
  heading('Duplicate content in the store');
  if (!hasJdupes()) {
    warn('jdupes is not installed — identical files were left as separate copies');
    note('`brew install jdupes`. fdupes is not an alternative: it has no hard-link action.');
  } else {
    const { sets, files, bytes } = duplicateSets(fleetTmp);
    if (files === 0) {
      ok('no byte-identical files to link');
    } else {
      for (const set of sets.slice(0, MAX_LISTED)) {
        const [anchor, ...rest] = set;
        note(pc.dim(`${anchor ?? '?'} = ${rest.join(', ')}`));
      }
      if (sets.length > MAX_LISTED) note(pc.dim(`… and ${String(sets.length - MAX_LISTED)} more`));
      const what = `${String(files)} file(s) in ${String(sets.length)} set(s)`;
      if (dryRun) {
        ok(`${what} would be hard-linked, freeing ${kb(bytes)}`);
      } else {
        const res = hardLinkDuplicates(fleetTmp);
        if (res.ok) ok(`hard-linked ${what}, freeing ${kb(bytes)}`);
        else warn(`jdupes could not link them: ${res.error || 'unknown error'}`);
      }
    }
  }

  resolveSameTicketCopies(dryRun);
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** LOCAL time, not UTC: it is read next to a `fetched:` line the skill writes with an offset. */
const stamp = (ms: number): string => {
  const at = new Date(ms);
  return (
    `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
};

/**
 * `tmp/jira-tickets/<KEY>.md` -- one record per ticket, every cached name a hard link to it.
 *
 * The per-ticket cache holds a ticket once per investigation that reached it: its own
 * `tmp/ABC-1234/ticket_ABC-1234.md`, plus a copy in every trunk that named it as a parent or a
 * relation. This pass makes all of those one inode. `jira-records.ts` has why the store record
 * cannot keep `relation:`/`relatedTo:` (one inode, two possible `relatedTo:` values) and why
 * stripping them is safe -- `sync.mjs` never reads a cached record.
 *
 * It replaces the old freshest-wins collapse for ticket records, and that is the point rather
 * than a side effect: under that rule a relation copy could win, and a ticket's own record then
 * read as though it hung off another ticket. ABC-1259 and ABC-1323 are both in that state on disk
 * right now. Here a ticket's own record wins regardless of age, so the state is unreachable.
 */
const syncJiraStore = (dryRun: boolean): void => {
  const groups = groupTicketRecords(ticketRecordPaths());
  if (groups.length === 0) return;

  heading(`One record per ticket in ${tildify(jiraTicketsDir)}`);
  if (!dryRun) mkdirSync(jiraTicketsDir, { recursive: true });

  let records = 0;
  let links = 0;
  for (const group of groups) {
    const action = planGroup(group);
    if (action === undefined) continue;
    if (action.kind === 'busy') {
      // Transient by construction: this pass replaces content, so a copy that may still be
      // being written is left for the next run -- which the `SessionEnd` hook will make.
      warnTransient(`${group.key}: a copy was written in the last two minutes — left alone`);
      note(pc.dim('A session may be mid-refresh; this pass replaces content. Run again.'));
      continue;
    }

    for (const record of action.mismatched) {
      warn(`${record.rel}: frontmatter says ${record.statedKey ?? '(nothing)'} — not linked`);
      note(pc.dim('The name and the record disagree; neither is safe to make the one record.'));
    }

    const { stripped } = action;
    if (action.write) {
      records += 1;
      const from = action.from.path.startsWith(jiraTicketsDir)
        ? 'the store record'
        : action.from.rel;
      const when = action.from.source === 'fetched' ? '' : pc.dim(` (${action.from.source})`);
      step(`${group.key}: record from ${from}${when}`);
      if (stripped.length > 0) {
        note(
          pc.dim(
            `${stripped.join(' and ')} removed — named ${action.from.relatedTo ?? 'a trunk'} as the` +
              ' trunk it was reached from, and one record cannot name one trunk',
          ),
        );
      }
      if (!dryRun) writeStoreRecord(group.key, storeContentFrom(action.from.content).content);
    }

    for (const copy of action.link) {
      links += 1;
      note(pc.dim(`${copy.rel} → link${dryRun ? ' would be made' : 'ed'}`));
      if (dryRun) continue;
      try {
        linkToStore(group.key, copy.path);
      } catch (error) {
        warn(`${copy.rel}: could not link — ${(error as Error).message}`);
      }
    }

    // Attachment references are trunk-specific, so a copy that names different asset files
    // cannot share content with the record without acquiring image links to files that are not
    // in its directory.
    for (const copy of action.keepOwn) {
      warn(`${copy.rel}: references other attachment filenames — kept as its own file`);
    }
  }

  if (records === 0 && links === 0) note(pc.dim('every ticket already has one record'));
  else
    ok(
      `${String(records)} record(s) ${dryRun ? 'to write' : 'written'}, ` +
        `${String(links)} name(s) ${dryRun ? 'to link' : 'linked'}`,
    );
};

/** Every ticket record in the store, the record store itself excluded -- it is not a copy. */
const ticketRecordPaths = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (path === jiraTicketsDir) continue;
      let isDir: boolean;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(path);
      else if (isTicketRecordName(basename(path))) found.push(path);
    }
  };
  walk(fleetTmp);
  return found;
};

/**
 * The half no content matcher can see: one ticket cached twice with DIFFERENT content.
 *
 * `jdupes` matches bytes, and these do not match — a relation copy carries its own
 * `relation:`/`relatedTo:` frontmatter and its own `fetched:` time, so two renderings of one
 * ticket are never identical. Grouped by ticket id first and content second (see
 * `sameTicketGroups`), the **freshest rendering wins** and the others become hard links to it.
 *
 * That is a deliberate override of the `jira-scope` skill's "the duplication between the two is
 * intended … Never dedupe them", asked for explicitly: one file per ticket, the newest fetch.
 * What it costs is worth knowing — when the winner is a relation copy, the ticket's own file
 * inherits that copy's `relation:`/`relatedTo:` frontmatter, which then reads as though the
 * ticket's own record hangs off the other ticket. It is said out loud when it happens, and `-n`
 * shows every choice before any of it is done.
 *
 * Markdown only. A differing pair of ASSETS under one name is a re-download that went wrong,
 * not a fresher rendering, and picking a winner there could keep a truncated file.
 */
const resolveSameTicketCopies = (dryRun: boolean): void => {
  const groups = sameTicketGroups(fleetTmp).filter(
    // Ticket RECORDS belong to `syncJiraStore` above, which picks a winner by a stronger rule
    // (a ticket's own record beats a relation copy regardless of age) and links every name to
    // one store file. What is left here is the rest of the per-ticket cache -- `plan_<KEY>.md`,
    // `pr_description_<KEY>.md` -- where freshest-wins is the whole of the right answer.
    (g) => !g.linked && !g.identical && g.canonical !== `ticket_${g.key}.md`,
  );
  if (groups.length === 0) return;
  blank();

  for (const group of groups) {
    const [winner, ...losers] = group.copies;
    if (winner === undefined) continue;
    if (group.busy) {
      warn(`${group.key}: a copy was written in the last two minutes — left alone`);
      note(pc.dim('A session may be mid-refresh; collapsing now would overwrite it. Run again.'));
      continue;
    }
    if (!group.resolvable) {
      warn(`${group.key}: ${group.copies.map((c) => c.rel).join(' · ')} differ — left alone`);
      note(
        pc.dim(
          'Not Markdown: a differing asset under one name is a bad download, not a newer' +
            ' rendering, so neither copy is preferred.',
        ),
      );
      continue;
    }
    const when = `${stamp(winner.at)}${winner.source === 'fetched' ? '' : ` (${winner.source})`}`;
    step(`${group.key}: newest is ${winner.rel} — ${when}`);
    for (const loser of losers) {
      const gap = Math.round((winner.at - loser.at) / 60_000);
      const older = gap > 0 ? `${String(gap)} min older` : 'same time, lost on name order';
      note(pc.dim(`${loser.rel} (${older}) → hard link${dryRun ? ' would be made' : 'ed'}`));
      if (!dryRun) {
        try {
          linkToWinner(winner.path, loser.path);
        } catch (error) {
          warn(`${loser.rel}: could not link — ${(error as Error).message}`);
        }
      }
    }
    // The one consequence the developer cannot see in the output above.
    if (winner.relationCopy) {
      note(
        pc.dim(
          `${group.key}'s own file now carries the relation frontmatter of the winning copy — ` +
            're-fetch it if that matters.',
        ),
      );
    }
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
