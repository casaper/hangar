import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { CliError, run, runOrThrow, type RunResult } from './exec.ts';

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

/**
 * What every reflog entry this CLI writes is labelled with, so "when did anyone last touch this
 * clone" can tell a person's checkout from `sync --all`'s.
 *
 * Without it a fleet sync rebases every idle clone and makes each one look worked on that day,
 * which is exactly the clone `hangar jira-plan` should be able to call untouched. Measured on git
 * 2.56: `checkout` replaces its message with the label, `merge` and `rebase` prefix it
 * (`hangar: Fast-forward`, `hangar (start): checkout main`) -- see `isHangarReflogEntry`.
 */
export const HANGAR_REFLOG_ACTION = 'hangar';

/** The environment every git subprocess here runs in: no editor, and a labelled reflog. */
const hangarGitEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...noEditorEnv(base),
  GIT_REFLOG_ACTION: HANGAR_REFLOG_ACTION,
});

/** Whether a reflog subject (`%gs`) was written by this CLI. Pure. */
export const isHangarReflogEntry = (subject: string): boolean =>
  subject === HANGAR_REFLOG_ACTION ||
  subject.startsWith(`${HANGAR_REFLOG_ACTION}:`) ||
  subject.startsWith(`${HANGAR_REFLOG_ACTION} (`);

export type GitOptions = {
  /**
   * Hand the child this process's terminal instead of capturing it. What that buys is not the
   * output: it is that anything git launches which wants an answer -- a gpg pinentry, a prompt
   * from a hook -- is VISIBLE and can be answered, rather than blocking a pipe nobody is
   * watching. `stderr` is then no longer captured, so a caller using this reads its verdict off
   * git's own state.
   */
  readonly inherit?: boolean;
  /** Text for the child's stdin, e.g. `update-ref --stdin` instructions. */
  readonly input?: string;
};

/**
 * `-C <repo>`, and paths printed as they are.
 *
 * `core.quotePath` defaults to true, under which git prints a non-ASCII path as a C string in
 * double quotes: a conflicted `src/café.ts` comes out of `diff --name-only` as
 * `"src/caf\303\251.ts"`. Every reader here splits that output into paths and hands them back to
 * git or to `readFileSync`, where the quoted form names nothing -- so a conflict-marker check
 * would read "no markers" for a file it cannot open, and an integration would commit them. Turning
 * quoting off prints the bytes as they are; only a name with a control character, `"` or `\`
 * stays quoted. In argv rather than the environment, so it cannot clobber a
 * `GIT_CONFIG_COUNT` the operator exported.
 */
const gitArgv = (repo: string, args: readonly string[]): string[] => [
  '-C',
  repo,
  '-c',
  'core.quotePath=false',
  ...args,
];

/**
 * Thin git wrappers. Everything here is read-only unless the name says otherwise, and every
 * call is scoped with `-C <repo>` -- the fleet rule is that a session never writes outside
 * its own clone, and passing an explicit repo path is what makes that auditable.
 */
export const git = (repo: string, args: readonly string[], opts: GitOptions = {}): RunResult =>
  run('git', gitArgv(repo, args), {
    env: hangarGitEnv(process.env),
    inherit: opts.inherit === true,
    ...(opts.input === undefined ? {} : { input: opts.input }),
  });

export const gitOut = (repo: string, args: readonly string[]): string =>
  runOrThrow('git', gitArgv(repo, args), { env: hangarGitEnv(process.env) });

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

/**
 * Commits reachable from HEAD that no remote-tracking ref has -- work that exists only here.
 *
 * Not `syncState().ahead`, which compares with `@{upstream}` and answers 0 when there is none:
 * a branch never pushed, or one whose source branch the forge deleted on merge, would read as
 * having nothing to lose. A sibling clone's refs count too, but only a sibling fetched BY NAME
 * has any: `fetch --all` skips them (`SIBLING_REMOTE_CONFIG`), so an unfetched sibling reads as
 * absent, which is the safe direction.
 */
export const unpushedCommits = (repo: string): number => {
  const count = gitTry(repo, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
  return count === undefined ? 0 : Number.parseInt(count, 10) || 0;
};

/** One HEAD reflog entry: when, in epoch ms, and its subject (`%gs`). */
export type ReflogEntry = { readonly atMs: number; readonly subject: string };

/** The newest `limit` HEAD reflog entries, newest first. Empty when there is no reflog. */
export const headReflog = (repo: string, limit = 200): ReflogEntry[] => {
  const raw = gitTry(repo, [
    'log',
    '-g',
    '--date=unix',
    `-n${String(limit)}`,
    '--format=%gd%x1f%gs',
    'HEAD',
  ]);
  if (raw === undefined || raw === '') return [];
  return raw.split('\n').flatMap((line) => {
    const [selector = '', subject = ''] = line.split(UNIT_SEP);
    const at = /\{(\d+)\}$/.exec(selector)?.[1];
    return at === undefined ? [] : [{ atMs: Number.parseInt(at, 10) * 1000, subject }];
  });
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
 * remote, so a branch that exists on origin and on a sibling fetched by name makes
 * `git checkout <branch>` ambiguous -- git refuses with "matched multiple (N) remote tracking
 * branches" rather than picking one. Naming `origin` restores the single-remote behaviour
 * without giving up the sibling remotes that cherry-picking needs.
 *
 * Set LOCAL, in the clone's own `.git/config`: it is a consequence of this directory being a
 * fleet clone, and `--global` would apply it to every repo on the machine.
 */
export const FLEET_GIT_CONFIG = [['checkout.defaultRemote', 'origin']] as const;

/**
 * Config every SIBLING remote carries, as `remote.<sibling>.<key>`.
 *
 * `skipFetchAll` makes `git fetch --all`, `git remote update` and the maintenance prefetch skip
 * the remote, while `git fetch <sibling>` still fetches it. Without it, every `fetch --all` in a
 * 16-clone fleet walks 16 remotes, and the siblings' refs are about half of a clone's
 * remote-tracking refs, filling every branch picker. Fetching a sibling is occasional, so it is
 * done by naming one: `git fetch <clone>`, or the fetch key's `--all`, which names each of them.
 */
export const SIBLING_REMOTE_CONFIG = [['skipFetchAll', 'true']] as const;

/**
 * The argv of a pruning fetch from exactly these remotes, in order. PURE.
 *
 * Remotes are always NAMED, never `--all`: `--all` skips every sibling, so it would quietly
 * drop one that a caller asked for.
 */
export const fetchArgs = (remoteNames: readonly [string, ...string[]]): string[] =>
  remoteNames.length === 1
    ? ['fetch', '--prune', remoteNames[0]]
    : ['fetch', '--prune', '--multiple', ...remoteNames];

/** The sibling remotes this repo HAS that are missing a `SIBLING_REMOTE_CONFIG` value. */
export const loudSiblingRemotes = (repo: string, siblingNames: readonly string[]): string[] => {
  const present = remotes(repo);
  // ONE `git config` for every remote, rather than one per sibling per key: `doctor --all` asks
  // this of every clone, which per sibling per key is 240 spawns for one row on sixteen clones.
  // git prints the section and the variable name lowercased and the remote's own name as
  // written, and the last value wins, as `--get` would answer.
  const config = new Map<string, string>();
  for (const line of (gitTry(repo, ['config', '--get-regexp', '^remote\\.']) ?? '').split('\n')) {
    const space = line.indexOf(' ');
    if (line !== '')
      config.set(space < 0 ? line : line.slice(0, space), space < 0 ? '' : line.slice(space + 1));
  }
  return siblingNames.filter(
    (name) =>
      present.has(name) &&
      SIBLING_REMOTE_CONFIG.some(
        ([key, want]) => config.get(`remote.${name}.${key.toLowerCase()}`) !== want,
      ),
  );
};

/**
 * Write `SIBLING_REMOTE_CONFIG` for one sibling remote, and drop that remote's tracking refs.
 *
 * The refs are dropped because nothing refreshes or prunes them once `fetch --all` skips the
 * remote, and a stale one misleads both ways. `unpushedCommits` and `remove-clone` read it as
 * "this commit exists elsewhere" after the sibling has dropped the commit; `hangar-rewrite`
 * reads only the refs that exist as "published", so it can never see more than a by-name fetch
 * brought in. Dropping makes the first two stricter, and leaves the third as blind as it already
 * was for a sibling not fetched since its last commit. A later `git fetch <sibling>` brings
 * fresh refs back.
 *
 * **A ref a local branch tracks is kept**: dropping it would leave that branch's upstream
 * "gone", and with it `@{upstream}`, `git status` and `hangar status`'s ahead/behind answer.
 *
 * `--no-deref`: the remote's `HEAD` symref and the branch it points at would otherwise be two
 * updates of one ref, which `update-ref --stdin` refuses as a whole.
 */
export const quietSiblingRemote = (
  repo: string,
  name: string,
): { set: string[]; dropped: number; failed: string[] } => {
  const set: string[] = [];
  const failed: string[] = [];
  for (const [key, value] of SIBLING_REMOTE_CONFIG) {
    const full = `remote.${name}.${key}`;
    if (git(repo, ['config', '--local', full, value]).ok) set.push(`${full}=${value}`);
    else failed.push(full);
  }
  const lines = (output: string | undefined): string[] =>
    (output ?? '').split('\n').filter((line) => line !== '');
  const upstreams = new Set(
    lines(gitTry(repo, ['for-each-ref', '--format=%(upstream)', 'refs/heads/'])),
  );
  const refs = lines(
    gitTry(repo, ['for-each-ref', '--format=%(refname)', `refs/remotes/${name}/`]),
  ).filter((ref) => !upstreams.has(ref));
  if (refs.length === 0) return { set, dropped: 0, failed };
  const deleted = git(repo, ['update-ref', '--no-deref', '--stdin'], {
    input: refs.map((ref) => `delete ${ref}\n`).join(''),
  });
  if (!deleted.ok) failed.push(`refs/remotes/${name}/*`);
  return { set, dropped: deleted.ok ? refs.length : 0, failed };
};

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
 * Mark resolved paths as no longer unmerged, leaving their content UNSTAGED.
 *
 * A conflicted `stash apply` leaves its paths unmerged until something stages them, and
 * `conflictedFiles` keeps naming them however well the markers were resolved. Staging alone
 * would hand the developer a fully staged file they never staged; `reset -- <paths>` straight
 * after puts the index entry back to HEAD's, which is what an unstaged change is. Measured on
 * git 2.56: `add` then `reset -q -- p` takes `UU p` to ` M p` with the content untouched.
 */
export const settleResolved = (repo: string, paths: readonly string[]): boolean => {
  if (paths.length === 0) return true;
  return git(repo, ['add', '--', ...paths]).ok && git(repo, ['reset', '-q', '--', ...paths]).ok;
};

/**
 * The paths `status --porcelain=v1 -z` names that can still be opened: staged, unstaged and
 * untracked, each once, in git's order. PURE.
 *
 * `-z` reverses a rename's fields -- `R  <new>\0<old>\0` -- so the old path is a second field to
 * consume, never a row. A path deleted in the index or the tree has nothing to open.
 */
export const parsePorcelainPaths = (raw: string): string[] => {
  const fields = raw.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? '';
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i += 1;
    if (xy.includes('D')) continue;
    const path = field.slice(3);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
};

/**
 * What `C-b C-e` offers first: every changed file of the tree that is still there.
 *
 * Never through `gitOut`: it trims, and the first entry's leading space is half its status --
 * ` M app/x.ts` became `pp/x.ts`.
 */
export const changedFiles = (repo: string): string[] => {
  const res = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!res.ok) throw new CliError(`git status failed in ${repo}`, res.stderr.trim());
  return parsePorcelainPaths(res.stdout);
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
 * The stash entry carrying this label, found by its MESSAGE, never by position.
 *
 * `stash@{0}` is whatever was pushed last, and between a sync's push and its restore a hook, a
 * paused agent's tool call or a person may have pushed another -- popping by position then hands
 * back somebody else's work and leaves this run's in the list. The label carries a timestamp, so
 * it names one entry.
 */
export const stashRefLabelled = (repo: string, label: string | undefined): string | undefined =>
  label === undefined
    ? undefined
    : stashList(repo).find((entry) => entry.message.endsWith(label))?.ref;

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
