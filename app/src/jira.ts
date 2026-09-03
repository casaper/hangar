import type { Clone } from './fleet.ts';
import { currentBranch, gitTry, remoteHeadBranch } from './git.ts';
import { atlassianUrl } from './paths.ts';

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
const KEY_IN_TEXT_RE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?![A-Za-z0-9])/g;

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

const firstIssueKey = (text: string): string | undefined => issueKeysIn(text)[0]?.key;

export const jiraUrl = (key: string): string => `${atlassianUrl}/browse/${key}`;

export type TicketGuess = {
  readonly key: string;
  /** How much to trust it: `branch` is authoritative, `commit` is a good guess. */
  readonly source: 'branch' | 'commit';
};

/**
 * Which ticket a clone is working on.
 *
 * The branch name is the real signal (`features/ABC-1337_...`), but plenty of branches here
 * carry no issue key at all, so the fallback is the most recent key mentioned in the commits
 * this branch has added on top of the default branch. That is per-clone and per-branch, which
 * is the whole point.
 *
 * NOT used as a fallback: the newest directory in `tmp/`. The per-ticket Jira cache is shared
 * across the whole fleet, so every clone's `tmp/` holds the same keys with the same mtimes --
 * it would return one identical answer for every clone while reading like a real finding.
 *
 * Never throws: "no ticket" is a normal answer.
 */
export const inferTicket = (
  clone: Clone,
  branch = currentBranch(clone.path),
): TicketGuess | undefined => {
  const fromBranch = firstIssueKey(branch);
  if (fromBranch !== undefined) return { key: fromBranch, source: 'branch' };

  const base = gitTry(clone.path, ['merge-base', `origin/${remoteHeadBranch(clone.path)}`, 'HEAD']);
  if (base === undefined) return undefined;
  // Subjects only, not bodies: subjects follow the repo's commit convention, whereas a body
  // is free prose and a much richer source of key-shaped noise.
  const subjects = gitTry(clone.path, ['log', '--format=%s', `${base}..HEAD`]) ?? '';
  const fromCommits = firstIssueKey(subjects);
  return fromCommits === undefined ? undefined : { key: fromCommits, source: 'commit' };
};
