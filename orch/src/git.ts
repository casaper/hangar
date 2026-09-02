import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { run, runOrThrow, type RunResult } from './exec.ts';

/**
 * Thin git wrappers. Everything here is read-only unless the name says otherwise, and every
 * call is scoped with `-C <repo>` -- the fleet rule is that a session never writes outside
 * its own clone, and passing an explicit repo path is what makes that auditable.
 */
export const git = (repo: string, args: readonly string[], inherit = false): RunResult =>
  run('git', ['-C', repo, ...args], inherit ? { inherit: true } : {});

export const gitOut = (repo: string, args: readonly string[]): string =>
  runOrThrow('git', ['-C', repo, ...args]);

/** Trimmed stdout, or undefined when the command failed (missing ref, detached HEAD, ...). */
export const gitTry = (repo: string, args: readonly string[]): string | undefined => {
  const res = git(repo, args);
  return res.ok ? res.stdout.trim() : undefined;
};

export const currentBranch = (repo: string): string =>
  // `||`, not `??`: on a detached HEAD the command SUCCEEDS and prints nothing, so the
  // empty string has to fall through too.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  gitTry(repo, ['branch', '--show-current']) || '(detached HEAD)';

export const isGitRepo = (repo: string): boolean =>
  gitTry(repo, ['rev-parse', '--git-dir']) !== undefined;

/** ASCII unit separator: safe inside a commit subject, unlike any printable delimiter. */
const UNIT_SEP = String.fromCharCode(31);

export type CommitInfo = {
  readonly sha: string;
  readonly date: string;
  readonly committer: string;
  readonly subject: string;
};

export const lastCommit = (repo: string): CommitInfo | undefined => {
  const raw = gitTry(repo, ['log', '-1', '--format=%h%x1f%cs%x1f%cn%x1f%s']);
  if (raw === undefined) return undefined;
  const [sha = '', date = '', committer = '', subject = ''] = raw.split(UNIT_SEP);
  return { sha, date, committer, subject };
};

export type SyncState = {
  readonly upstream: string | undefined;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: number;
  readonly untracked: number;
};

/**
 * Ahead/behind against the branch's own remote-tracking ref. Never fetches -- the caller
 * decides that, so a status report can say "not fetched" instead of quietly comparing
 * against a stale ref.
 */
export const syncState = (repo: string): SyncState => {
  const upstream = gitTry(repo, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream !== undefined) {
    const counts = gitTry(repo, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    const [b = '0', a = '0'] = (counts ?? '0 0').split(/\s+/);
    behind = Number.parseInt(b, 10);
    ahead = Number.parseInt(a, 10);
  }
  const status = gitTry(repo, ['status', '--porcelain=v1']) ?? '';
  const lines = status === '' ? [] : status.split('\n');
  return {
    upstream,
    ahead,
    behind,
    dirty: lines.filter((l) => !l.startsWith('??')).length,
    untracked: lines.filter((l) => l.startsWith('??')).length,
  };
};

export const isDirty = (repo: string): boolean => {
  const s = syncState(repo);
  return s.dirty > 0 || s.untracked > 0;
};

export const remotes = (repo: string): Map<string, string> => {
  const out = gitTry(repo, ['remote', '-v']) ?? '';
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
    if (match?.[1] && match[2]) map.set(match[1], match[2]);
  }
  return map;
};

/** The repo's default branch, from origin/HEAD, falling back to master. */
export const remoteHeadBranch = (repo: string): string => {
  const ref = gitTry(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  return ref?.replace('refs/remotes/origin/', '') ?? 'master';
};

export const conflictedFiles = (repo: string): string[] => {
  const out = gitTry(repo, ['diff', '--name-only', '--diff-filter=U']) ?? '';
  return out === '' ? [] : out.split('\n');
};

/**
 * Whichever multi-step operation the repo is stopped in the middle of, if any.
 *
 * The STATE DIRECTORY is what decides this, exactly as git's own status does -- not
 * `REBASE_HEAD`. That ref is written when a rebase stops at a conflict and is gone again
 * once the step is staged, so a repo sitting resolved-but-not-continued -- the state a
 * killed `orch-util sync` leaves behind, and the one this check exists to catch -- has a
 * populated `rebase-merge/` and no `REBASE_HEAD` at all.
 */
export const inProgressOperation = (repo: string): 'rebase' | 'merge' | undefined => {
  const gitPath = (name: string): string | undefined => {
    const resolved = gitTry(repo, ['rev-parse', '--git-path', name]);
    if (resolved === undefined) return undefined;
    return isAbsolute(resolved) ? resolved : join(repo, resolved);
  };
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const path = gitPath(name);
    if (path !== undefined && existsSync(path)) return 'rebase';
  }
  const mergeHead = gitPath('MERGE_HEAD');
  if (mergeHead !== undefined && existsSync(mergeHead)) return 'merge';
  return undefined;
};
