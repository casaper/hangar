import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { cacheSubjectOf, freshnessOf, type Copy } from './dedupe.ts';
import type { Hangar } from './hangar.ts';
import { KEY_RE } from './jira.ts';

/**
 * The one record per Jira ticket, and the names that are symlinks to it.
 *
 * The per-ticket cache duplicates a ticket by design: the tracker skill gives a directory only
 * to the ticket the user ASKED about, so a ticket reached as a neighbour is written into the
 * asking ticket's directory, and a ticket worked on directly is cached twice. This module makes
 * `tmp/jira-tickets/ABC-1323.md` the single file every one of those names points at, as a
 * RELATIVE symlink: `../jira-tickets/ABC-1323.md` from any trunk directory. That is the one form
 * that resolves both in the hangar's own `tmp/` and through the absolute symlink a clone reaches
 * that directory by -- see `storeLinkTarget`, which is why it is not computed with `relative()`.
 *
 * **Two on-disk layouts are read, because the skill that writes them is tracked and
 * branch-versioned** -- a clone on an older branch writes the flat one, so both are live in one
 * fleet at once. `ticketNameOf` is the only place that knows either:
 *
 *     store   ABC-1349/ticket.md            ABC-1349/ticket_relation_ABC-1343.md
 *     flat    ABC-1349/ticket_ABC-1349.md   ABC-1349/ticket_ABC-1349_relates_to_ABC-1343.md
 *
 * In the store layout the trunk key is not in the filename at all -- `ticket.md` takes its key
 * from the DIRECTORY -- and a neighbour's name carries the KIND rather than the relation label,
 * because the direction belongs in the record and a filename can contradict it. A name is never
 * rewritten from one layout to the other, only re-pointed: the older skill asks for its own
 * spelling back, and a renamed file would send it fetching for ever.
 *
 * **The store record cannot carry `relation:`/`relatedTo:`, and that is a proof rather than a
 * preference.** Those two keys say which trunk a copy was reached from, and a ticket reachable
 * from two trunks would need one inode to hold two different `relatedTo:` values. So the store
 * record is the winning copy with those lines removed, and every copy is replaced by a link to
 * it -- which is what "one copy per ticket" costs: a relation copy loses the two keys the
 * skill's contract uses to mark it as a copy. Its FILENAME still says `_relates_to_`, and the
 * trunk's own `relations:` / `parent:` / `subtasks:` frontmatter still states the relation and
 * its label, so nothing is unrecoverable. It is printed every time it happens.
 *
 * Nothing in the skill reads a cached record -- `sync.mjs` has no `readFileSync` at all, and
 * its own SKILL.md says "never read a cached copy instead of syncing" -- so the stripped keys
 * cannot change what the skill does. Only what a reader sees.
 *
 * Two properties make this safe to run repeatedly:
 *
 * - A sync writes temp-file-then-rename, so a re-fetch REPLACES the inode and can never write
 *   through a link into the store. Where the skill writes into the store itself the rename
 *   lands on the file everything points at and nothing detaches; where it writes the flat
 *   layout it detaches one name, and the next merge folds it back with the fresher content
 *   becoming the store's. So the store is only ever as current as the last merge of a flat
 *   clone, which is why every freshness test here reads `fetched_at:` out of the file rather
 *   than trusting the path.
 * - The store record is itself a candidate when picking a winner, so a copy that was deleted
 *   since the last merge cannot make the store go backwards.
 */

/** The store holds ticket RECORDS only: one `ABC-1234.md` per key, no assets, no plans. */
export const storeRecordPath = (hangar: Hangar, key: string): string =>
  join(hangar.paths.jiraTickets, `${key}.md`);

/**
 * The relative target a cached name must carry to reach its store record.
 *
 * **Deliberately not `relative(dirname(copy), storeRecordPath(...))`.** A cached name always sits
 * one level under a `tmp/` that holds the store beside it, so `../<store>/<KEY>.md` is the answer
 * from any trunk directory -- and it is the only answer that survives the way a clone reaches
 * that directory. `<clone>/tmp/ABC-1349` is an absolute symlink into the hangar's own `tmp/`, so
 * the link is created in the hangar's directory whatever path was used to name it, and `..` there
 * resolves to the hangar's `tmp/`. Computing it from the two absolute paths instead would answer
 * `../../../tmp/jira-tickets/ABC-1349.md` for a clone, which from the hangar's directory climbs
 * out to the filesystem root and reaches nothing.
 *
 * It is also what the tracker skill writes, so a name either side re-points is byte-identical and
 * neither keeps rewriting the other's.
 */
export const storeLinkTarget = (hangar: Hangar, key: string): string =>
  `../${basename(hangar.paths.jiraTickets)}/${key}.md`;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * The leading YAML frontmatter block, or undefined.
 *
 * Read from the head of the file only, never the body -- a ticket body quotes Jira comments,
 * which can contain anything including a line that looks like a key.
 */
export const frontmatterOf = (content: string): string | undefined =>
  FRONTMATTER_RE.exec(content)?.[1];

/**
 * The value of a TOP-LEVEL frontmatter key, unparsed and untrimmed of structure.
 *
 * Top-level only, and that matters twice: `relations:` entries carry their own indented
 * `relation:` key, and `parent:` carries an indented `id:`. An anchored `^` is what keeps the
 * two apart, so this never has to know the shape of the value it skipped.
 */
export const topLevelValue = (frontmatter: string, key: string): string | undefined =>
  new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter)?.[1]?.trim();

export const hasTopLevelKey = (frontmatter: string, key: string): boolean =>
  new RegExp(`^${key}:`, 'm').test(frontmatter);

/**
 * The indented block under a top-level key, split into entries.
 *
 * Enough of YAML for the three neighbourhood keys and nothing more: a block sequence of
 * mappings (`relations:`, `subtasks:`, `siblings:`) or one mapping (`parent:`), both of which
 * `jira-ticket-sync`'s hand-rolled emitter writes with two-space indentation and no anchors,
 * flow collections or multi-line scalars. A real parser is not worth a dependency in a package
 * that has none, and a wrong answer here is not silent: every caller treats an unparsable
 * block as "cannot tell" and falls back to fetching.
 */
export const blockEntries = (frontmatter: string, key: string): Record<string, string>[] => {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start === -1) return [];
  const inline = lines[start]?.slice(key.length + 1).trim() ?? '';
  // `key: []` / `key: {}` / `key:` with nothing under it are all "no entries", which is what
  // the emitter writes for an absent list or an absent parent.
  if (inline !== '') return [];

  const entries: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    const item = /^\s+-\s+(\S+):[ \t]*(.*)$/.exec(line);
    if (item?.[1] !== undefined) {
      current = { [item[1]]: (item[2] ?? '').trim() };
      entries.push(current);
      continue;
    }
    const pair = /^\s+(\S+):[ \t]*(.*)$/.exec(line);
    if (pair?.[1] === undefined) continue;
    // A mapping value with no `- ` ever seen is a single mapping, not a sequence: `parent:`.
    if (current === undefined) {
      current = {};
      entries.push(current);
    }
    current[pair[1]] = (pair[2] ?? '').trim();
  }
  return entries;
};

/**
 * Every `*_asset_<name>` file the body points at, as basenames.
 *
 * Both spellings, because both layouts are live. The store names an attachment after the ticket
 * that OWNS it -- `ABC-1191_asset_shot.png`, beside that ticket's own record -- so a record
 * shared between two trunks carries references that are correct from either. The flat layout
 * names it after the path it was reached BY, `ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png`,
 * which one shared record cannot get right for two trunks: a flat copy whose asset references
 * differ from the store record's is left as its own file, because linking it would give it image
 * links to files that are not in its directory. Tickets with no attachments have an empty set and
 * link freely, which is most.
 *
 * Missing the store spelling is not a quiet loss of precision: the cache hook checks that every
 * reference resolves beside the destination before it denies a fetch, so a pattern that matched
 * nothing would let it deny one having linked no attachments at all.
 */
const FLAT_ASSET = 'ticket_[A-Z][A-Z0-9]*-\\d+(?:_[a-z_]+_[A-Z][A-Z0-9]*-\\d+)*';
const STORE_ASSET = '[A-Z][A-Z0-9]*-\\d+';

export const assetRefsIn = (content: string): Set<string> =>
  new Set(
    content.match(new RegExp(`(?:${FLAT_ASSET}|${STORE_ASSET})_asset_[^\\s)\`]+`, 'g')) ?? [],
  );

/**
 * The kinds a neighbour link is named for, and the store's own trunk name.
 *
 * These are the tracker skill's vocabulary, not this CLI's -- it collapses every label Jira can
 * hand back ("is blocked by", "Relates To", "clones") onto one of these, so the direction is
 * read out of the record rather than out of a filename that could disagree with it.
 */
const NEIGHBOUR_KINDS = 'parent|subtask|sibling|relation';
const STORE_TRUNK_NAME = 'ticket.md';
const STORE_NEIGHBOUR_RE = new RegExp(`^ticket_(?:${NEIGHBOUR_KINDS})_([A-Z][A-Z0-9]+-\\d+)\\.md$`);

export type TicketName = {
  /** The ticket this FILE contains -- never the trunk it was reached from. */
  readonly key: string;
  /** The trunk's own record, which beats a neighbour at any age. */
  readonly ownRecord: boolean;
  readonly layout: 'store' | 'flat';
};

/**
 * What a cached filename says it is, or `undefined` when it is not a ticket record at all.
 *
 * **The one owner of that question**, and it takes the containing DIRECTORY as well as the name
 * because the store layout's `ticket.md` carries no key. Three callers ask it -- the record walk,
 * the grouping, and the freshest-wins collapse that must leave records alone -- and they used to
 * spell the test independently. That is the failure this signature exists to make impossible: the
 * store pass reads its own predicate, so a name it stops recognising makes the pass silently do
 * nothing rather than fail.
 *
 * The four shapes cannot collide. A kind is a lowercase word and an issue key is uppercase, so
 * `ticket_parent_ABC-1032.md` is unambiguously a store neighbour, while the flat layout's
 * neighbour always carries two keys and its own record always carries one and no kind.
 */
export const ticketNameOf = (dirName: string, fileName: string): TicketName | undefined => {
  if (fileName === STORE_TRUNK_NAME)
    return KEY_RE.test(dirName) ? { key: dirName, ownRecord: true, layout: 'store' } : undefined;

  const neighbour = STORE_NEIGHBOUR_RE.exec(fileName)?.[1];
  if (neighbour !== undefined) return { key: neighbour, ownRecord: false, layout: 'store' };

  // The flat layout, where the last issue key in the name is what the file contains and
  // everything before it only says how it was reached.
  const subject = cacheSubjectOf(fileName);
  if (subject === undefined) return undefined;
  if (subject.canonical !== `ticket_${subject.key}.md`) return undefined;
  return { key: subject.key, ownRecord: subject.key === dirName, layout: 'flat' };
};

export type TicketRecord = {
  readonly path: string;
  /** `ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md` -- enough to identify it in output. */
  readonly rel: string;
  /** The ticket this file is about, from `ticketNameOf` -- its name, or its directory. */
  readonly key: string;
  /** `id:` or `key:` from the frontmatter -- the file's own claim about what it is. */
  readonly statedKey: string | undefined;
  /** Reached sideways rather than being this trunk's own record. See `readRecord`. */
  readonly isRelationCopy: boolean;
  /** The trunk it was reached from, when it says so -- the value of `relatedTo:`. */
  readonly relatedTo: string | undefined;
  readonly at: number;
  readonly source: Copy['source'];
  readonly mtime: number;
  /** Already a symlink carrying exactly `storeLinkTarget` -- so nothing needs re-pointing. */
  readonly linksToStore: boolean;
  readonly assetRefs: ReadonlySet<string>;
  readonly content: string;
};

/**
 * Read one record, or `undefined` when it cannot be read -- a dangling link included.
 *
 * **`isRelationCopy` comes from two different places, and they never both apply to one file.**
 * In the store layout the NAME is authoritative: a neighbour link resolves to that ticket's own
 * record, which carries no `relation:` key at all, so frontmatter alone would call every
 * neighbour an own record and hand `pickWinner` the wrong pool. In the flat layout the
 * FRONTMATTER is authoritative: a flat neighbour is a distinct file with its own `relation:`,
 * written by a skill this CLI does not control.
 */
const readRecord = (
  path: string,
  name: TicketName,
  wantTarget: string,
): TicketRecord | undefined => {
  let content: string;
  let stat: ReturnType<typeof statSync>;
  try {
    content = readFileSync(path, 'utf8');
    stat = statSync(path);
  } catch {
    return undefined;
  }
  const frontmatter = frontmatterOf(content) ?? '';
  const { at, source } = freshnessOf(path);
  return {
    path,
    rel: `${basename(dirname(path))}/${basename(path)}`,
    key: name.key,
    statedKey: topLevelValue(frontmatter, 'id') ?? topLevelValue(frontmatter, 'key'),
    isRelationCopy:
      name.layout === 'store' ? !name.ownRecord : hasTopLevelKey(frontmatter, 'relation'),
    relatedTo: topLevelValue(frontmatter, 'relatedTo'),
    at,
    source,
    mtime: stat.mtimeMs,
    linksToStore: linkTargetOf(path) === wantTarget,
    assetRefs: assetRefsIn(content),
    content,
  };
};

/**
 * Cached names whose symlink reaches nothing.
 *
 * `readRecord` cannot see these -- reading through a dangling link throws, so they drop out of
 * the grouping and would be repaired by nothing and reported by nobody. There is nothing to
 * re-point them at either: the record they named is gone, so the answer is a re-sync, and this is
 * what lets the command say so instead of reporting a clean run.
 */
const linkTargetOf = (path: string): string | undefined => {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
};

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    // The name itself is gone, which is not this pass's business.
    return false;
  }
};

export const danglingStoreLinks = (paths: readonly string[]): string[] =>
  paths.filter((path) => {
    if (!isSymlink(path)) return false;
    try {
      // `statSync` follows, so it is exactly the question "does this link reach a file".
      statSync(path);
      return false;
    } catch {
      return true;
    }
  });

export type TicketGroup = {
  readonly key: string;
  /** The store record, when one already exists -- itself a winner candidate. */
  readonly stored: TicketRecord | undefined;
  /** Freshest first, the store record excluded. */
  readonly copies: readonly TicketRecord[];
  /** A copy whose `id:` disagrees with its filename: never linked, always reported. */
  readonly mismatched: readonly TicketRecord[];
};

/**
 * Group the store's ticket records by key.
 *
 * `paths` are the cache files as they sit under `<fleet>/tmp/<TRUNK>/`; the store's own
 * directory is not among them -- it is read separately, because it is a candidate for winning
 * rather than a copy to be linked.
 */
export const groupTicketRecords = (hangar: Hangar, paths: readonly string[]): TicketGroup[] => {
  const byKey = new Map<string, TicketRecord[]>();
  const mismatched = new Map<string, TicketRecord[]>();
  for (const path of paths) {
    const name = ticketNameOf(basename(dirname(path)), basename(path));
    if (name === undefined) continue;
    const record = readRecord(path, name, storeLinkTarget(hangar, name.key));
    if (record === undefined) continue;
    // The NAME is still the grouping key -- assets have no frontmatter and `plan_ABC-1317.md`
    // must not group with a ticket record -- but a file that STATES a different id is either
    // hand-renamed or the parser lost, and either way it must not become another ticket's one
    // record.
    const bucket =
      record.statedKey !== undefined && record.statedKey !== name.key ? mismatched : byKey;
    bucket.set(name.key, [...(bucket.get(name.key) ?? []), record]);
  }

  const keys = new Set([...byKey.keys(), ...mismatched.keys()]);
  return [...keys].sort().map((key) => {
    // The store record is the ticket's own by construction, whatever its frontmatter says.
    const stored = readRecord(
      storeRecordPath(hangar, key),
      { key, ownRecord: true, layout: 'store' },
      storeLinkTarget(hangar, key),
    );
    const copies = (byKey.get(key) ?? []).sort((a, b) => b.at - a.at || a.rel.localeCompare(b.rel));
    return { key, stored, copies, mismatched: mismatched.get(key) ?? [] };
  });
};

/**
 * The copy whose content the store record should hold.
 *
 * A ticket's OWN record wins over a relation copy regardless of age. They are not two
 * renderings of one thing: the relation copy carries strictly extra, trunk-specific keys, so
 * preferring it is how a ticket's own record ends up reading as though it hangs off another
 * ticket -- which is exactly what happened to ABC-1259 and ABC-1323 under the old freshest-wins
 * rule. Age only ranks peers.
 */
export const pickWinner = (group: TicketGroup): TicketRecord | undefined => {
  const candidates = [...group.copies, ...(group.stored === undefined ? [] : [group.stored])];
  const own = candidates.filter((record) => !record.isRelationCopy);
  const pool = own.length > 0 ? own : candidates;
  return pool.reduce<TicketRecord | undefined>(
    (best, record) => (best === undefined || record.at > best.at ? record : best),
    undefined,
  );
};

/**
 * The winning content as the store must hold it: the two trunk-specific keys removed.
 *
 * Only ever the top-level pair inside the frontmatter block. `relations:` survives (the `^`
 * anchor plus the colon keeps it apart from `relation:`), and so does every indented
 * `relation:` inside it -- the neighbourhood list is what makes the stripped keys recoverable
 * in the first place.
 */
export const storeContentFrom = (content: string): { content: string; stripped: string[] } => {
  const frontmatter = frontmatterOf(content);
  if (frontmatter === undefined) return { content, stripped: [] };
  const stripped: string[] = [];
  const kept = frontmatter
    .split(/\r?\n/)
    .filter((line) => {
      if (!/^(relation|relatedTo):/.test(line)) return true;
      stripped.push(line.split(':')[0] ?? line);
      return false;
    })
    .join('\n');
  if (stripped.length === 0) return { content, stripped };
  return { content: content.replace(frontmatter, kept), stripped };
};

/** Long enough to cover a `sync.mjs` fetch and the writes that follow it. */
export const RECENT_MS = 120_000;

export type StoreAction =
  | { readonly kind: 'busy'; readonly key: string }
  | {
      readonly kind: 'record';
      readonly key: string;
      readonly from: TicketRecord;
      readonly write: boolean;
      readonly stripped: readonly string[];
      readonly link: readonly TicketRecord[];
      readonly keepOwn: readonly TicketRecord[];
      readonly mismatched: readonly TicketRecord[];
    };

/**
 * What the store pass would do to one group, decided without touching the disk.
 *
 * Split out from the writing so `-n` and the real run cannot disagree, which is the property
 * that matters most in a command whose whole job is replacing one file's content with
 * another's.
 */
export const planGroup = (group: TicketGroup): StoreAction | undefined => {
  const winner = pickWinner(group);
  if (winner === undefined) return undefined;

  const { content, stripped } = storeContentFrom(winner.content);
  const write = group.stored?.content !== content;
  const refs = assetRefsIn(content);
  const same = (record: TicketRecord): boolean =>
    record.assetRefs.size === refs.size && [...record.assetRefs].every((ref) => refs.has(ref));

  // A copy already carrying the store's relative target needs nothing done to it, and that is
  // true even when the record itself is being rewritten: `writeStoreRecord` replaces the store's
  // inode, and a symlink names a PATH, so every name pointing there picks the new content up by
  // itself. A hard link would have had to be remade, which is why this once asked about inodes.
  const link = group.copies.filter(same).filter((record) => !record.linksToStore);
  const keepOwn = group.copies.filter((record) => !same(record));

  // Silence, not a report, when the group is already in the shape this pass wants. Checked
  // BEFORE the busy guard below, because linking a copy gives it the store record's fresh
  // mtime -- so a second run within the window would otherwise call every group busy and tell
  // the developer a session might be mid-refresh, about writes this command had just made.
  //
  // `keepOwn` deliberately does NOT make a settled group report. A copy kept out because its
  // attachment names belong to another trunk stays that way for ever, and the names are the
  // skill's to change, not this command's -- so saying it on every merge would be a warning
  // that is red in normal operation and therefore read by nobody. It is said the run the
  // decision is actually made, alongside the links, and then goes quiet. A `mismatched` copy is
  // different: a filename and a record that disagree is an anomaly somebody has to resolve.
  const settled = !write && link.length === 0;
  if (settled && group.mismatched.length === 0) return undefined;

  // A copy written moments ago means a session may be mid-refresh, and this pass REPLACES
  // content. Both shared directories already work this way. Only where there is something to
  // replace: a group that is merely being reported on is not waiting for anything.
  const now = Date.now();
  if (!settled && [...group.copies, winner].some((record) => now - record.mtime < RECENT_MS)) {
    return { kind: 'busy', key: group.key };
  }

  return {
    kind: 'record',
    key: group.key,
    from: winner,
    write,
    stripped,
    link,
    keepOwn,
    mismatched: group.mismatched,
  };
};

/** Write the store record, replacing rather than editing so no link is ever written through. */
export const writeStoreRecord = (hangar: Hangar, key: string, content: string): void => {
  const target = storeRecordPath(hangar, key);
  const staging = `${target}.writing-${String(process.pid)}`;
  try {
    writeFileSync(staging, content, 'utf8');
    renameSync(staging, target);
  } catch (error) {
    try {
      rmSync(staging);
    } catch {
      // Nothing staged, or already gone -- the store record is untouched either way.
    }
    throw error;
  }
};

/**
 * Replace `copy` with a relative symlink to the store record.
 *
 * Link-then-rename, so the path is never briefly missing: a session reading the cache sees
 * either the old file or the new link, never nothing.
 *
 * **The link is verified before it is put in place.** `storeLinkTarget` is relative by
 * necessity, and a relative target is only correct while the assumption behind it holds -- that
 * the name sits one level under a `tmp/` with the store beside it. Resolving the staged link and
 * comparing it with the record is what turns a broken assumption into a refusal here rather than
 * a cache full of links that quietly reach nothing.
 *
 * **A filesystem that cannot make the link leaves the name exactly as it is**, and the caller
 * reports that it could not be pointed at the store -- the same shape as `linkToWinner`. Writing
 * a byte copy instead was tried and is wrong twice over: the name already holds a readable
 * record, so nothing is rescued, and a copy can never satisfy this pass. It is not a symlink, so
 * the next run puts it back in the link list, copies it again, and reports it again -- for ever.
 * A warning that is red in normal operation is read by nobody, which is the same reason
 * `keepOwn` is reported the run it is decided and then goes quiet.
 */
export const linkToStore = (hangar: Hangar, key: string, copy: string): void => {
  const record = storeRecordPath(hangar, key);
  const target = storeLinkTarget(hangar, key);
  const staging = `${copy}.linking-${String(process.pid)}`;
  try {
    // A staging name left behind by a killed run is stale by definition.
    rmSync(staging, { force: true });
    symlinkSync(target, staging);
    if (realpathSync(staging) !== realpathSync(record))
      throw new Error(`${target} does not reach ${record} from ${dirname(copy)}`);
    renameSync(staging, copy);
  } catch (error) {
    try {
      rmSync(staging, { force: true });
    } catch {
      // Nothing staged -- the copy is untouched.
    }
    throw error;
  }
};
