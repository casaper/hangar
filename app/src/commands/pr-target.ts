import { tryDefaultBranch } from '../config/default-branch.ts';
import { CliError } from '../exec.ts';
import { currentBranch, DETACHED, git, refExists } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { clearPrTarget, PR_TARGET_KEY, readPrTarget, writePrTarget } from '../pr-target.ts';
import { note, ok } from '../ui.ts';
import { forgeClone } from './pr.ts';

export type PrTargetOptions = {
  set?: string | undefined;
  clear?: boolean | undefined;
};

/** The line `pr target` prints for what is stored. PURE. */
export const describePrTarget = (
  clone: string,
  branch: string,
  stored: string | undefined,
  defaultBranch: string | undefined,
): string =>
  stored === undefined
    ? `${clone}: ${branch} has no stored PR target — sync and pr create use ${defaultBranch ?? 'the default branch'} until a pull request says otherwise`
    : `${clone}: ${branch} → ${stored}${stored === defaultBranch ? ' (the default branch)' : ''}`;

/**
 * `hangar pr target [clone]` -- show, set or clear where this branch's pull request goes.
 *
 * Local only: it writes the clone's own `branch.<branch>.hangarPrTarget` and nothing on the
 * forge. Setting one is how a stacked branch gets synced onto the branch it stacks on, and
 * opened against it, before it has a pull request of its own; once it has one, every refresh
 * takes the forge's answer over this.
 */
export const prTarget = (hangar: Hangar, ref: string | undefined, opts: PrTargetOptions = {}) => {
  if (opts.set !== undefined && opts.clear === true) {
    throw new CliError('--set and --clear contradict each other');
  }
  const clone = forgeClone(hangar, ref, 'pr target');
  const branch = currentBranch(clone.path);
  if (branch === DETACHED)
    throw new CliError(`${clone.name}: detached HEAD — no branch to target from`);
  const defaultBranch = tryDefaultBranch(hangar);

  if (opts.clear === true) {
    if (readPrTarget(clone.path, branch) === undefined) {
      note(describePrTarget(clone.name, branch, undefined, defaultBranch));
      return;
    }
    clearPrTarget(clone.path, branch);
    ok(`${clone.name}: cleared ${branch}'s stored PR target`);
    return;
  }

  if (opts.set !== undefined) {
    const target = opts.set.replace(/^origin\//, '');
    if (target === branch) throw new CliError(`${clone.name}: ${branch} cannot target itself`);
    // Fetched only when the ref is not known yet; a target origin does not have is refused.
    if (!refExists(clone.path, `origin/${target}`)) {
      git(clone.path, ['fetch', '--quiet', 'origin', target]);
    }
    if (!refExists(clone.path, `origin/${target}`)) {
      throw new CliError(
        `${clone.name}: origin has no branch ${target}`,
        'A pull request can only target a branch origin has. Push that branch first.',
      );
    }
    writePrTarget(clone.path, branch, target);
    ok(describePrTarget(clone.name, branch, target, defaultBranch));
    note(`(git config branch.${branch}.${PR_TARGET_KEY})`);
    return;
  }

  note(describePrTarget(clone.name, branch, readPrTarget(clone.path, branch), defaultBranch));
};
