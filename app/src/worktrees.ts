import { tildify } from './user-paths.ts';

/**
 * The extra `git worktree`s registered in a clone, read from `git worktree list --porcelain`.
 *
 * The fleet is full clones, never worktrees, but a repo's own review skill may check a branch out
 * as a detached worktree in a temp directory, run the checks there and remove it. A review that
 * crashes leaves the registration under `.git/worktrees/` pointing at a directory that is gone,
 * and git then refuses that branch elsewhere with "is already checked out at" a path nobody can
 * find. `doctor` reports it and names the prune; it never prunes, because a registration whose
 * directory is merely on an unmounted volume is not ours to drop.
 */
export type ExtraWorktree = {
  readonly path: string;
  /** `refs/heads/<name>` shortened, or `detached`. */
  readonly what: string;
  /** git's own reason when it considers the registration stale. */
  readonly prunable: string | undefined;
};

/** Every worktree but the first, which is the clone itself. Pure: given git's output. */
export const extraWorktrees = (porcelain: string): ExtraWorktree[] => {
  const blocks = porcelain
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((line) => line !== ''))
    .filter((lines) => lines.length > 0);
  return blocks.slice(1).flatMap((lines) => {
    const field = (name: string): string | undefined => {
      const line = lines.find((l) => l === name || l.startsWith(`${name} `));
      return line === undefined ? undefined : line.slice(name.length).trim();
    };
    const path = field('worktree');
    if (path === undefined) return [];
    const branch = field('branch');
    return [
      {
        path,
        what: branch === undefined ? 'detached' : branch.replace(/^refs\/heads\//, ''),
        prunable: field('prunable'),
      },
    ];
  });
};

export type WorktreeRow = { readonly ok: boolean; readonly detail: string };

/**
 * The doctor row for a clone's extra worktrees, or `undefined` when it has none -- the normal
 * state, which gets no row at all rather than a green one that says nothing.
 */
export const worktreeRow = (
  clonePath: string,
  extras: readonly ExtraWorktree[],
): WorktreeRow | undefined => {
  if (extras.length === 0) return undefined;
  const stale = extras.filter((w) => w.prunable !== undefined);
  if (stale.length > 0) {
    const paths = stale.map((w) => `${tildify(w.path)} (${w.what})`).join(', ');
    return {
      ok: false,
      detail:
        `stale worktree registration${stale.length === 1 ? '' : 's'}: ${paths} -- a review that ` +
        `did not clean up; \`git -C ${tildify(clonePath)} worktree prune\` drops ` +
        (stale.length === 1 ? 'it' : 'them'),
    };
  }
  const live = extras.map((w) => `${tildify(w.path)} (${w.what})`).join(', ');
  return { ok: true, detail: `${extras.length} extra worktree(s) in use: ${live}` };
};
