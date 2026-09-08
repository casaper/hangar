import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { run, runOrThrow, type RunResult } from './exec.ts';

/**
 * The environment every git subprocess of this CLI runs in: one where no editor can open.
 *
 * `sync` drives a rebase to completion, and `git rebase --continue` opens an editor for the
 * commit message it is about to reuse. WHICH editor is a four-layer decision, and git reads the
 * environment before it reads any config -- measured on git 2.55:
 *
 * | invocation                               | `git var GIT_EDITOR` |
 * | ---------------------------------------- | -------------------- |
 * | nothing set (global `core.editor=vim`)   | `vim`                |
 * | `git -c core.editor=true`                | `true`               |
 * | `GIT_EDITOR=vim git -c core.editor=true` | **`vim`**            |
 * | `GIT_EDITOR=true git -c core.editor=vim` | `true`               |
 *
 * A config-level guard is not enough, and the third row is why: `-c core.editor=true` beats the
 * config files and loses to whatever the operator's shell exported, and `GIT_EDITOR=vim` in an
 * rc file is an ordinary thing to have. What that costs is a hang rather than an error -- vim
 * spawned against a captured pipe has its screen output discarded while it reads the keyboard
 * from `/dev/tty` directly, so the sync stops dead with nothing on screen and the clone's paused
 * agent never receives the closing message a `SYNC PAUSE` promises it. The environment is the
 * one layer nothing downstream can override, which is why the guard lives here.
 *
 * `GIT_SEQUENCE_EDITOR` alongside it: this CLI never wants a todo editor either, and the two
 * together are the whole of git's editor surface. Taken from `process.env` at CALL time -- a
 * module constant would freeze the environment as it stood at import.
 */
export const noEditorEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...base,
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
});

export type GitOptions = {
  /**
   * Hand the child this process's terminal instead of capturing it. What that buys is not the
   * output: it is that anything git launches which wants an answer -- a gpg pinentry, a prompt
   * from a hook -- is VISIBLE and can be answered, rather than blocking a pipe nobody is
   * watching. `stderr` is then no longer captured, so a caller using this reads its verdict off
   * git's own state.
   */
  readonly inherit?: boolean;
};

/**
 * Thin git wrappers. Everything here is read-only unless the name says otherwise, and every
 * call is scoped with `-C <repo>` -- the fleet rule is that a session never writes outside
 * its own clone, and passing an explicit repo path is what makes that auditable.
 */
export const git = (repo: string, args: readonly string[], opts: GitOptions = {}): RunResult =>
  run('git', ['-C', repo, ...args], {
    env: noEditorEnv(process.env),
    inherit: opts.inherit === true,
  });

export const gitOut = (repo: string, args: readonly string[]): string =>
  runOrThrow('git', ['-C', repo, ...args], { env: noEditorEnv(process.env) });

/** Trimmed stdout, or undefined when the command failed (missing ref, detached HEAD, ...). */
export const gitTry = (repo: string, args: readonly string[]): string | undefined => {
  const res = git(repo, args);
  return res.ok ? res.stdout.trim() : undefined;
};

/** What `currentBranch` answers when there is no branch. Compared against, so it is shared. */
export const DETACHED = '(detached HEAD)';

export const currentBranch = (repo: string): string =>
  // `||`, not `??`: on a detached HEAD the command SUCCEEDS and prints nothing, so the
  // empty string has to fall through too.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  gitTry(repo, ['branch', '--show-current']) || DETACHED;

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

/**
 * Git config a clone needs BECAUSE it is in the fleet, and that a re-clone loses.
 *
 * `checkout.defaultRemote=origin` is the whole list. Every clone carries every sibling as a
 * remote, so a branch that exists on more than one of them makes `git checkout <branch>`
 * ambiguous -- git refuses with "matched multiple (N) remote tracking branches" rather than
 * picking one, and the more clones the fleet has the more often that is any branch worth
 * checking out. Naming `origin` restores the single-remote behaviour without giving up the
 * sibling remotes that cherry-picking needs.
 *
 * Set LOCAL, in the clone's own `.git/config`: it is a consequence of this directory being a
 * fleet clone, and `--global` would apply it to every repo on the machine.
 */
export const FLEET_GIT_CONFIG = [['checkout.defaultRemote', 'origin']] as const;

/** The effective value, whichever scope it comes from, or undefined when unset. */
export const gitConfig = (repo: string, key: string): string | undefined =>
  gitTry(repo, ['config', '--get', key]);

/** Keys whose effective value is not what the fleet needs, with what they are instead. */
export const wrongFleetGitConfig = (repo: string): { key: string; want: string; is: string }[] =>
  FLEET_GIT_CONFIG.map(([key, want]) => ({
    key,
    want,
    is: gitConfig(repo, key) ?? '(unset)',
  })).filter(({ want, is }) => is !== want);

/**
 * Write every fleet key into the clone's own `.git/config`.
 *
 * `git config --local <key> <value>`, not `git config set`: the subcommand form needs git 2.46
 * and this one has worked forever. Reports what it wrote and what it could not, rather than
 * silently dropping a failed write from the list -- a repair that says nothing is the failure
 * mode `doctor` exists to avoid.
 */
export const setFleetGitConfig = (repo: string): { set: string[]; failed: string[] } => {
  const set: string[] = [];
  const failed: string[] = [];
  for (const [key, value] of FLEET_GIT_CONFIG) {
    if (git(repo, ['config', '--local', key, value]).ok) set.push(`${key}=${value}`);
    else failed.push(key);
  }
  return { set, failed };
};

/**
 * The repo's default branch as GIT reports it, or `undefined` when it does not know.
 *
 * `origin/HEAD` is the repo's own answer and the only one worth having: `master` is this repo's
 * default branch, plenty of others use `main`, and a few use neither. It is a LOCAL ref, though.
 * `git clone` writes it, `git remote set-head` writes it, and since git 2.45 a `git fetch` fills
 * it in when it is MISSING (verified on the 2.55 this machine has) -- but nothing updates it
 * once it exists, so a clone whose remote later moved its default branch keeps answering with
 * the old one, and an older git leaves it unset for good. `setRemoteHeadAuto` is how a caller
 * asks origin to settle it.
 *
 * **Commands do not call this.** They ask `config/default-branch.ts`, which answers from
 * `forge.defaultBranch` -- one value for the whole hangar, detected through here exactly once
 * and then written to the config. There used to be a `remoteHeadBranch` beside this that fell
 * back to the literal `master`; it is gone, because a wrong branch name is the one thing here
 * that fails silently.
 */
export const defaultBranchFromGit = (repo: string): string | undefined => {
  const ref = gitTry(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  return ref?.replace('refs/remotes/origin/', '');
};

/**
 * Ask origin which branch its HEAD points at and record it in `refs/remotes/origin/HEAD`.
 *
 * A network call, and the only write in this file that is not scoped to a branch -- it touches
 * one remote-tracking symref and nothing a working tree can see. Returns what it resolved, so a
 * caller need not re-read it.
 */
export const setRemoteHeadAuto = (repo: string): string | undefined => {
  if (!git(repo, ['remote', 'set-head', 'origin', '--auto']).ok) return undefined;
  return defaultBranchFromGit(repo);
};

/**
 * True when `ref` names a commit here.
 *
 * `^{commit}` on purpose: a ref that exists but is not a commit is no use as a rebase or merge
 * base, and `--verify --quiet` turns "no such ref" into a clean non-zero rather than noise.
 */
export const refExists = (repo: string, ref: string): boolean =>
  gitTry(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined;

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
 * killed `hangar sync` leaves behind, and the one this check exists to catch -- has a
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

/**
 * The label `hangar sync` stashes uncommitted work under, and the string everything else
 * recognises it by.
 *
 * It lives here rather than in `sync.ts` because two commands need the same answer from
 * opposite ends: `sync` writes the label, and `status` reports an entry still carrying it as
 * work a sync failed to give back. Fleet-specific knowledge in a plumbing module has one
 * precedent already, `FLEET_GIT_CONFIG`, for the same reason.
 */
export const SYNC_STASH_LABEL = 'hangar-sync';

export type StashEntry = {
  /** `stash@{0}` — the reflog selector, which is what `git stash` commands take. */
  readonly ref: string;
  /** The stash subject, e.g. `On my-branch: hangar-sync 2026-09-02T15:40:00.000Z`. */
  readonly message: string;
  /** Relative age, for a human: `12 minutes ago`. */
  readonly age: string;
};

/**
 * The stash list, parsed.
 *
 * NUL-separated because a stash message is free text that can contain anything, colons and
 * tabs included -- splitting on a printable delimiter would mis-parse the very entries this
 * exists to report. An empty stash list exits 0 with no output, so `?? ''` is the normal
 * case and not an error path.
 */
export const stashList = (repo: string): StashEntry[] => {
  const out = gitTry(repo, ['stash', 'list', '--format=%gd%x00%gs%x00%cr']) ?? '';
  if (out === '') return [];
  return out.split('\n').flatMap((line) => {
    const [ref, message, age] = line.split('\0');
    if (ref === undefined || message === undefined) return [];
    return [{ ref, message, age: age ?? 'unknown age' }];
  });
};

/**
 * Stash entries `hangar sync` created and did not manage to give back.
 *
 * On every path that finishes, sync either drops its stash or says out loud that it kept one.
 * So an entry here is either a sync that died between the stash and the restore, or one whose
 * re-apply needed conflict resolution -- and in both cases uncommitted work is sitting
 * somewhere the working tree does not show it.
 */
export const syncStashes = (repo: string): StashEntry[] =>
  stashList(repo).filter((entry) => entry.message.includes(SYNC_STASH_LABEL));
