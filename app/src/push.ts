import type { Clone } from './fleet.ts';
import { CliError } from './exec.ts';
import { git, gitTry } from './git.ts';

/**
 * Where a branch stands against origin, and what pushing it would mean.
 *
 * Only two of the five ever push: `missing` (origin has no such branch) and `ahead` (origin has
 * it, without the latest commits). Both are a fast-forward by construction. `behind` and
 * `diverged` would need a pull or a force, and a force is never this module's to choose.
 */
export type PushPlan = 'missing' | 'ahead' | 'up-to-date' | 'behind' | 'diverged';

export type OriginState = {
  readonly plan: PushPlan;
  /** Commits HEAD has that origin's branch lacks -- every commit, when it is missing. */
  readonly ahead: number;
  readonly behind: number;
};

/** The plan, from what git said. PURE. */
export const pushPlan = (facts: {
  readonly onOrigin: boolean;
  readonly ahead: number;
  readonly behind: number;
}): PushPlan => {
  if (!facts.onOrigin) return 'missing';
  if (facts.ahead > 0 && facts.behind > 0) return 'diverged';
  if (facts.ahead > 0) return 'ahead';
  if (facts.behind > 0) return 'behind';
  return 'up-to-date';
};

/** Whether the plan is one a push carries out. */
export const pushes = (plan: PushPlan): boolean => plan === 'missing' || plan === 'ahead';

/** One line saying what a push would do, or why it would not. PURE. */
export const describePush = (branch: string, state: OriginState): string => {
  const commits = (n: number): string => `${String(n)} commit${n === 1 ? '' : 's'}`;
  switch (state.plan) {
    case 'missing':
      return `push ${branch} to origin, which does not have it yet (${state.ahead === 0 ? 'no commits of its own yet' : commits(state.ahead)})`;
    case 'ahead':
      return `push ${commits(state.ahead)} on ${branch} that origin does not have`;
    case 'up-to-date':
      return `origin already has ${branch} as it is here`;
    case 'behind':
      return `origin has ${commits(state.behind)} on ${branch} that this clone does not -- nothing to push`;
    case 'diverged':
      return `${branch} has diverged from origin (${commits(state.ahead)} here, ${commits(state.behind)} there)`;
  }
};

/**
 * Ask origin, fetch the branch, then read where it stands. Fetched first, on a dry run too: a stale
 * remote-tracking ref is exactly the wrong answer here, calling a branch pushed an hour ago
 * unpushed -- or, worse, pushed when its last commits are local. Only `refs/remotes` moves.
 */
export const originState = (clone: Clone, branch: string): OriginState => {
  // Origin is ASKED, and its answer is the only one taken. A branch gone from origin (merged with
  // close-source-branch) leaves a stale `origin/<branch>` behind, which read as "up to date" --
  // nothing pushed, and `pr create` then opened a pull request from a branch origin no longer
  // has. `--exit-code` makes "no such branch" exit 2 in any locale; any other failure is origin
  // not answering, and a push decided on a stale ref is what this function exists to prevent.
  const asked = git(clone.path, [
    'ls-remote',
    '--exit-code',
    '--heads',
    'origin',
    `refs/heads/${branch}`,
  ]);
  if (!asked.ok && asked.code !== 2) {
    throw new CliError(
      `${clone.name}: could not ask origin about ${branch}`,
      asked.stderr.trim() || 'git ls-remote failed without saying why.',
    );
  }
  const onOrigin = asked.ok;
  if (onOrigin) {
    const fetched = git(clone.path, ['fetch', '--quiet', 'origin', branch]);
    if (!fetched.ok) {
      throw new CliError(
        `${clone.name}: could not fetch ${branch} from origin`,
        fetched.stderr.trim(),
      );
    }
  }
  const counted = onOrigin
    ? gitTry(clone.path, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`])
    : gitTry(clone.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
  const [a, b] = (counted ?? '0 0').split(/\s+/).map((n) => Number.parseInt(n, 10));
  const ahead = Number.isFinite(a) ? (a ?? 0) : 0;
  const behind = onOrigin && Number.isFinite(b) ? (b ?? 0) : 0;
  return { plan: pushPlan({ onOrigin, ahead, behind }), ahead, behind };
};

/**
 * `git push -u origin <branch>` -- never forced, so git itself refuses anything but a
 * fast-forward even if the state read above went stale in between. On the terminal, because a
 * repo's own `pre-push` hook or an ssh passphrase may want it; git's own message says why it
 * failed.
 */
export const pushBranch = (clone: Clone, branch: string): void => {
  const res = git(clone.path, ['push', '--quiet', '-u', 'origin', branch], { inherit: true });
  if (!res.ok)
    throw new CliError(`${clone.name}: git did not push ${branch}`, 'Nothing else was done.');
};
