import { tryDefaultBranch } from '../config/default-branch.ts';
import { CliError } from '../exec.ts';
import { currentBranch, DETACHED } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { describePush, originState, pushBranch, pushes } from '../push.ts';
import { confirm, note, ok, step, warn } from '../ui.ts';
import { forgeClone } from './pr.ts';

export type PushOptions = {
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
};

/**
 * `hangar push [clone]` -- put the current branch on origin when origin lacks it or its latest
 * commits. A fast-forward only: a branch that is behind has nothing to push, and one that has
 * diverged is refused rather than forced.
 *
 * The clone is chosen as `pr create` chooses it, and for the same reason: this is published, so
 * from inside one clone it never reaches into another.
 */
export const push = (hangar: Hangar, ref: string | undefined, opts: PushOptions = {}): void => {
  const clone = forgeClone(hangar, ref, 'push');
  const branch = currentBranch(clone.path);
  if (branch === DETACHED) {
    throw new CliError(`${clone.name}: detached HEAD — there is no branch to push`);
  }
  if (branch === tryDefaultBranch(hangar)) {
    throw new CliError(
      `${clone.name}: on the default branch (${branch}) — hangar push only pushes a working branch`,
      'The default branch moves through merged pull requests, not from a clone.',
    );
  }

  const origin = originState(clone, branch);
  const said = describePush(branch, origin);
  if (origin.plan === 'diverged') {
    throw new CliError(
      `${clone.name}: ${said}`,
      'A push would need --force, which hangar never chooses. Bring the two together first -- `hangar sync` -- or push it yourself.',
    );
  }
  if (!pushes(origin.plan)) {
    if (origin.plan === 'behind') warn(`${clone.name}: ${said}`);
    else ok(`${clone.name}: ${said}`);
    return;
  }

  step(`${clone.name}: ${said}`);
  if (opts.dryRun === true) {
    note('(dry run — nothing was pushed)');
    return;
  }
  if (opts.yes !== true && !confirm(`Push ${branch} to origin?`)) {
    note('nothing was pushed — pass -y (a tool call: `yes: true`) to skip the question');
    return;
  }
  pushBranch(clone, branch);
  ok(`${clone.name}: pushed ${branch}`);
};
