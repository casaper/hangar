import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Clone } from './fleet.ts';
import { currentBranch, gitTry, remoteHeadBranch } from './git.ts';
import { atlassianUrl, jiraStore } from './paths.ts';

/**
 * The shared per-ticket Jira cache, and inferring which ticket a clone is on.
 *
 * `<store>/<KEY>/` is the real directory; each clone's `tmp/<KEY>` is a symlink into it, so
 * a ticket fetched in one clone is immediately there for every other. This needs no change
 * to the tracked tooling: `.claude/skills/jira-scope/jira-cache.mjs` hardcodes
 * `<git toplevel>/tmp/<KEY>` but only ever does a recursive mkdir on it, which follows a
 * symlink.
 *
 * `tmp/` ITSELF IS NEVER LINKED. It also holds the dev-server PID files, and
 * `dev/run-with-pid.mjs` refuses a name that is already live -- a shared `tmp/` would let
 * only one clone run a dev server at a time, and would let `pids.mjs --kill` reach into
 * another clone. Only the per-ticket `tmp/<KEY>` directories are linked.
 */
export const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const KEY_IN_TEXT_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

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

const firstIssueKey = (text: string): string | undefined => {
  for (const match of text.matchAll(KEY_IN_TEXT_RE)) {
    const key = match[0];
    if (!NOT_ISSUE_PREFIXES.has(key.split('-')[0] ?? '')) return key;
  }
  return undefined;
};

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

export type LinkAction = {
  readonly clone: string;
  readonly key: string;
  readonly message: string;
  readonly kind: 'linked' | 'already' | 'adopted' | 'conflict' | 'warning';
};

const sameFile = (a: string, b: string): boolean => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

/** Every key worth linking: everything already in the store, plus every real ticket dir. */
export const discoverKeys = (clones: readonly Clone[]): string[] => {
  const keys = new Set<string>();
  try {
    for (const entry of readdirSync(jiraStore)) if (KEY_RE.test(entry)) keys.add(entry);
  } catch {
    // No store yet -- the first link creates it.
  }
  for (const clone of clones) {
    try {
      for (const entry of readdirSync(join(clone.path, 'tmp'))) {
        if (KEY_RE.test(entry)) keys.add(entry);
      }
    } catch {
      // A clone with no tmp/ yet contributes nothing.
    }
  }
  return [...keys].sort();
};

/**
 * Make `tmp/<KEY>` a symlink into the shared store in every clone, adopting a real directory
 * in place. Idempotent, and it never deletes a differing file: a conflicting copy is kept
 * beside the winner as `<name>.from-<clone>` and reported.
 */
export const linkKey = (clones: readonly Clone[], key: string, dryRun: boolean): LinkAction[] => {
  const actions: LinkAction[] = [];
  const storeDir = join(jiraStore, key);
  if (!dryRun) mkdirSync(storeDir, { recursive: true });

  for (const clone of clones) {
    const tmp = join(clone.path, 'tmp');
    const dir = join(tmp, key);
    if (!dryRun) mkdirSync(tmp, { recursive: true });

    const link = existsSync(dir) || isSymlink(dir);
    if (isSymlink(dir)) {
      const target = readlinkSync(dir);
      actions.push(
        target === storeDir
          ? { clone: clone.name, key, kind: 'already', message: 'already linked' }
          : {
              clone: clone.name,
              key,
              kind: 'warning',
              message: `symlink points elsewhere (${target}) -- left untouched`,
            },
      );
      continue;
    }

    if (link && statSync(dir).isDirectory()) {
      actions.push({ clone: clone.name, key, kind: 'adopted', message: 'adopting real dir' });
      for (const name of readdirSync(dir)) {
        const from = join(dir, name);
        const to = join(storeDir, name);
        if (!existsSync(to)) {
          actions.push({ clone: clone.name, key, kind: 'adopted', message: `move ${name}` });
          if (!dryRun) renameSync(from, to);
        } else if (sameFile(from, to)) {
          actions.push({
            clone: clone.name,
            key,
            kind: 'adopted',
            message: `${name} identical to store -- dropping the clone copy`,
          });
          if (!dryRun) unlinkSync(from);
        } else {
          actions.push({
            clone: clone.name,
            key,
            kind: 'conflict',
            message: `${name} differs -- keeping store, saving clone copy as ${name}.from-${clone.name}`,
          });
          if (!dryRun) renameSync(from, `${to}.from-${clone.name}`);
        }
      }
      if (!dryRun) {
        try {
          rmdirSync(dir);
        } catch {
          actions.push({
            clone: clone.name,
            key,
            kind: 'warning',
            message: 'directory not empty after adoption -- not linked',
          });
          continue;
        }
      }
    }

    if (dryRun || !existsSync(dir)) {
      actions.push({ clone: clone.name, key, kind: 'linked', message: 'linking' });
      if (!dryRun) symlinkSync(storeDir, dir);
    }
  }
  return actions;
};

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** True when `tmp/<KEY>` is a symlink into the shared store. */
export const isKeyLinked = (clone: Clone, key: string): boolean => {
  const dir = join(clone.path, 'tmp', key);
  return isSymlink(dir) && readlinkSync(dir) === join(jiraStore, key);
};
