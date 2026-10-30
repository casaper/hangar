import type { Clone } from './fleet.ts';
import { tryDefaultBranch } from './config/default-branch.ts';
import { currentBranch, DETACHED, gitTry } from './git.ts';
import type { Hangar } from './hangar.ts';
import { render } from './template.ts';

/**
 * Issue keys: recognising one, and inferring which ticket a clone is on.
 *
 * The per-ticket cache itself is not this module's business any more. It is one kind of entry
 * in the shared `tmp/` store like any other, and `hangar tmp merge` links it -- see
 * `tmp.ts`. A key-scoped linker lived here until then and shared only `tmp/<KEY>` directories,
 * which left `pr-*.md` and everything else the skills cache unshared.
 */
export const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * A key embedded in text, with `_` treated as a SEPARATOR rather than part of a word.
 *
 * Not `\b`: `_` is a word character, so `\bABC-1323\b` matches neither
 * `fixes/ABC-1323_playwright_json` nor `ticket_ABC-1323.md` -- which is every branch name this
 * repo produces and every filename the Jira cache writes. The branch was silently never used
 * as a ticket signal, and `status` said "from a commit on this branch, not from the branch
 * name" while the key sat in the branch name. The lookarounds exclude only letters and digits,
 * so a key may abut `_`, `/`, `-`, `.` or a space.
 */
export const KEY_IN_TEXT_RE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?![A-Za-z0-9])/g;

/**
 * Prefixes that look exactly like an issue key but never are. Without this, `UTF-8`,
 * `SHA-256` or `ISO-8601` in a commit subject produces a confident link to a ticket that
 * does not exist -- worse than saying nothing.
 */
const NOT_ISSUE_PREFIXES = new Set([
  'UTF',
  'ISO',
  'SHA',
  'RFC',
  'CVE',
  'HTTP',
  'AES',
  'RSA',
  'ES',
  'IEC',
  'ANSI',
  'CSS',
  'HTML',
  'IPV',
  'MD',
  'X',
]);

/**
 * Every issue key in `text`, in order, with the false positives above removed.
 *
 * Exported because a cache FILENAME carries several: `ticket_ABC-1278_parent_ABC-1032.md` names
 * the directory's ticket and then the one the file is actually about. See `cacheSubjectOf`.
 */
export const issueKeysIn = (text: string): { key: string; start: number; end: number }[] => {
  const found: { key: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(KEY_IN_TEXT_RE)) {
    const key = match[0];
    if (NOT_ISSUE_PREFIXES.has(key.split('-')[0] ?? '')) continue;
    found.push({ key, start: match.index, end: match.index + key.length });
  }
  return found;
};

/**
 * The first key in `text` this hangar's tracker could own: with `tracker.keyPrefixes` set, a key
 * under any other prefix is skipped rather than returned. The schema calls the prefixes a
 * whitelist, and the bar has always honoured them -- so without this, `browse ticket` could open
 * a ticket for a branch whose bar field was blank.
 */
const firstTrackedKey = (hangar: Hangar, text: string): string | undefined => {
  const prefixes = hangar.config.tracker.keyPrefixes ?? [];
  return issueKeysIn(text).find(
    ({ key }) => prefixes.length === 0 || prefixes.includes(key.split('-')[0] ?? ''),
  )?.key;
};

/**
 * The web URL for an issue key, or `undefined` when this hangar has no tracker.
 *
 * `undefined` rather than a URL missing its host, and that is the whole reason it is optional:
 * `tracker.baseUrl` is optional in the schema (with `kind: none` there is nothing to link to),
 * and rendering `{baseUrl}` away would produce `/browse/ABC-1337` -- a link that looks like a
 * link. The caller says "no tracker configured" instead.
 *
 * It was `${atlassianUrl}/browse/${key}`, one organisation's Jira as a module constant. The
 * template is `tracker.issueUrlTemplate`, which every other tracker can spell.
 */
export const issueUrl = (hangar: Hangar, key: string): string | undefined => {
  const tracker = hangar.config.tracker;
  if (tracker.kind === 'none' || tracker.baseUrl === undefined) return undefined;
  return render(
    tracker.issueUrlTemplate,
    { baseUrl: tracker.baseUrl.replace(/\/$/, ''), key },
    'tracker.issueUrlTemplate',
  );
};

export type TicketGuess = {
  readonly key: string;
  /**
   * How much to trust it: `binding` was set on purpose, `branch` is authoritative, `commit` is a
   * good guess.
   */
  readonly source: 'binding' | 'branch' | 'commit';
};

/** What a branch's ticket binding holds when its work deliberately belongs to no ticket. */
export const NO_TICKET = 'none';

/** A ticket, a branch bound to no ticket on purpose, or nothing found. */
export type TicketInference = TicketGuess | typeof NO_TICKET | undefined;

export const ticketKeyOf = (ticket: TicketInference): string | undefined =>
  ticket === undefined || ticket === NO_TICKET ? undefined : ticket.key;

/**
 * What a binding's raw value means: a key, {@link NO_TICKET}, or `undefined` for unset or
 * unreadable. A value that is neither is ignored rather than trusted, so a typo falls through to
 * the branch name instead of linking to a ticket that does not exist.
 */
export const bindingMeaning = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (trimmed === undefined) return undefined;
  if (trimmed === NO_TICKET) return NO_TICKET;
  return KEY_RE.test(trimmed) ? trimmed : undefined;
};

/**
 * The branch's ticket binding, `git config branch.<branch>.<tracker.branchConfigKey>`.
 *
 * The convention is the managed repo's and works without a hangar: it is how a branch whose name
 * carries no key -- or whose work belongs to no ticket at all -- says which. Hangar only reads it,
 * and only when the config names the variable; the key is optional with no default, because the
 * variable's name is the repo's choice.
 */
export const ticketBinding = (hangar: Hangar, repo: string, branch: string): string | undefined => {
  const tracker = hangar.config.tracker;
  if (tracker.kind === 'none' || tracker.branchConfigKey === undefined) return undefined;
  if (branch === '' || branch === DETACHED || branch === 'HEAD') return undefined;
  return bindingMeaning(
    gitTry(repo, ['config', '--get', `branch.${branch}.${tracker.branchConfigKey}`]),
  );
};

/**
 * Which ticket a clone is working on.
 *
 * In order: the branch's binding (see `ticketBinding`), then the branch name
 * (`features/ABC-1337_...`), then the earliest key mentioned in the non-merge commits this branch
 * has added on top of the default branch, since plenty of branches carry no issue key at all. Every
 * step is per-clone and per-branch, which is the whole point. A binding of {@link NO_TICKET}
 * stops the search: the branch says on purpose that it has no ticket, and a key in one of its
 * commits must not overrule that.
 *
 * NOT used as a fallback: the newest directory in `tmp/`. The per-ticket Jira cache is shared
 * across the whole fleet, so every clone's `tmp/` holds the same keys with the same mtimes --
 * it would return one identical answer for every clone while reading like a real finding.
 *
 * Never throws: "no ticket" is a normal answer.
 */
export const inferTicket = (clone: Clone, branch = currentBranch(clone.path)): TicketInference => {
  const bound = ticketBinding(clone.hangar, clone.path, branch);
  if (bound === NO_TICKET) return NO_TICKET;
  if (bound !== undefined) return { key: bound, source: 'binding' };

  const fromBranch = firstTrackedKey(clone.hangar, branch);
  if (fromBranch !== undefined) return { key: fromBranch, source: 'branch' };

  // The non-throwing, non-networking form on purpose: this function's contract is that "no
  // ticket" is a normal answer, and it is reachable from paths that must not fail.
  const defaultBranch = tryDefaultBranch(clone.hangar);
  if (defaultBranch === undefined) return undefined;
  const base = gitTry(clone.path, ['merge-base', `origin/${defaultBranch}`, 'HEAD']);
  if (base === undefined) return undefined;
  // Subjects only, not bodies: subjects follow the repo's commit convention, whereas a body
  // is free prose and a much richer source of key-shaped noise. Merges are skipped because
  // "Merge branch 'features/ABC-1338_...'" names the branch merged IN; the earliest commit wins
  // because a branch is cut for its first ticket. The repo's own resolver picks the same way.
  const subjects =
    gitTry(clone.path, ['log', '--no-merges', '--reverse', '--format=%s', `${base}..HEAD`]) ?? '';
  const fromCommits = firstTrackedKey(clone.hangar, subjects);
  return fromCommits === undefined ? undefined : { key: fromCommits, source: 'commit' };
};
