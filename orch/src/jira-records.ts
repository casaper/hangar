import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { cacheSubjectOf, freshnessOf, type Copy } from './dedupe.ts';
import { jiraTicketsDir } from './paths.ts';

/**
 * The one record per Jira ticket, and the names that are hard links to it.
 *
 * The per-ticket cache duplicates a ticket by design: `jira-scope` gives a directory only to
 * the ticket the user ASKED about, so a ticket reached as a relation is written into the
 * asking ticket's directory. `ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md` is ABC-1323, and a
 * ticket worked on directly is ABC-1323 twice. This module makes
 * `tmp/jira-tickets/ABC-1323.md` the single file both names point at.
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
 * - `sync.mjs` writes temp-file-then-rename, so a re-fetch REPLACES the inode. A sync can
 *   never write through a link into the store; it detaches one name, and the next merge links
 *   it back with the fresher content becoming the store's. That is also why the store is only
 *   ever as current as the last merge, and why every freshness test here reads `fetched_at:`
 *   out of the file rather than trusting the path.
 * - The store record is itself a candidate when picking a winner, so a copy that was deleted
 *   since the last merge cannot make the store go backwards.
 */

/** The store holds ticket RECORDS only: one `ABC-1234.md` per key, no assets, no plans. */
export const storeRecordPath = (key: string): string => join(jiraTicketsDir, `${key}.md`);

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
 * These are TRUNK-SPECIFIC: ABC-1191 reached from ABC-1323 renders its screenshots as
 * `ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png`, both in the inline `![](...)` links and
 * in the Attachments list. So one shared record cannot carry correct attachment references for
 * two different trunks, and a copy whose asset references differ from the store record's is
 * left as its own file -- linking it would give it image links to files that are not in its
 * directory. Tickets with no attachments have an empty set and link freely, which is most.
 */
export const assetRefsIn = (content: string): Set<string> =>
  new Set(
    content.match(/ticket_[A-Z][A-Z0-9]*-\d+(?:_[a-z_]+_[A-Z][A-Z0-9]*-\d+)*_asset_[^\s)`]+/g) ??
      [],
  );

export type TicketRecord = {
  readonly path: string;
  /** `ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md` -- enough to identify it in output. */
  readonly rel: string;
  /** The ticket this file is about, from the LAST issue key in its name. */
  readonly key: string;
  /** `id:` or `key:` from the frontmatter -- the file's own claim about what it is. */
  readonly statedKey: string | undefined;
  /** True when `relation:` is present: the copy says itself that it was reached sideways. */
  readonly isRelationCopy: boolean;
  /** The trunk it was reached from, when it says so -- the value of `relatedTo:`. */
  readonly relatedTo: string | undefined;
  readonly at: number;
  readonly source: Copy['source'];
  readonly mtime: number;
  readonly ino: number;
  readonly assetRefs: ReadonlySet<string>;
  readonly content: string;
};

const readRecord = (path: string, key: string): TicketRecord | undefined => {
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
    key,
    statedKey: topLevelValue(frontmatter, 'id') ?? topLevelValue(frontmatter, 'key'),
    isRelationCopy: hasTopLevelKey(frontmatter, 'relation'),
    relatedTo: topLevelValue(frontmatter, 'relatedTo'),
    at,
    source,
    mtime: stat.mtimeMs,
    ino: stat.ino,
    assetRefs: assetRefsIn(content),
    content,
  };
};

/** True for a cache file that is a ticket RECORD -- not a plan, a PR description or an asset. */
export const isTicketRecordName = (fileName: string): boolean => {
  const subject = cacheSubjectOf(fileName);
  if (subject === undefined) return false;
  return subject.canonical === `ticket_${subject.key}.md`;
};

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
export const groupTicketRecords = (paths: readonly string[]): TicketGroup[] => {
  const byKey = new Map<string, TicketRecord[]>();
  const mismatched = new Map<string, TicketRecord[]>();
  for (const path of paths) {
    const name = basename(path);
    const subject = cacheSubjectOf(name);
    if (subject === undefined || !isTicketRecordName(name)) continue;
    const record = readRecord(path, subject.key);
    if (record === undefined) continue;
    // The filename parser is still the grouping key -- assets have no frontmatter and
    // `plan_ABC-1317.md` must not group with `ticket_ABC-1317.md` -- but a file that STATES a
    // different id is either hand-renamed or the parser lost, and either way it must not
    // become another ticket's one record.
    const bucket =
      record.statedKey !== undefined && record.statedKey !== subject.key ? mismatched : byKey;
    bucket.set(subject.key, [...(bucket.get(subject.key) ?? []), record]);
  }

  const keys = new Set([...byKey.keys(), ...mismatched.keys()]);
  return [...keys].sort().map((key) => {
    const stored = readRecord(storeRecordPath(key), key);
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

  const storedIno = group.stored?.ino;
  // Already one inode with a store record whose content is staying put: nothing to do.
  const link = group.copies.filter(same).filter((record) => write || record.ino !== storedIno);
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
export const writeStoreRecord = (key: string, content: string): void => {
  const target = storeRecordPath(key);
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
 * Replace `copy` with a hard link to the store record.
 *
 * Link-then-rename, so the path is never briefly missing: a session reading the cache sees
 * either the old file or the new link, never nothing.
 */
export const linkToStore = (key: string, copy: string): void => {
  const staging = `${copy}.linking-${String(process.pid)}`;
  try {
    linkSync(storeRecordPath(key), staging);
    renameSync(staging, copy);
  } catch (error) {
    try {
      rmSync(staging);
    } catch {
      // Nothing staged -- the copy is untouched.
    }
    throw error;
  }
};
