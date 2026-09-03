import pc from 'picocolors';

import { discoverClones } from '../fleet.ts';
import { currentBranch, lastCommit } from '../git.ts';
import { cloneLabel, note, table, truncate } from '../ui.ts';

/**
 * `hangar list` -- what clones exist, where each one is, and how fresh it is.
 *
 * The branch column is read live from each clone. Never infer a clone's branch from its
 * number or from any table in CLAUDE.md: clones are interchangeable and equal in rank, and
 * whatever a clone has checked out right now is the only answer.
 */
export const list = (): void => {
  const clones = discoverClones();
  if (clones.length === 0) {
    note('No clones found. Create one with `hangar add-clone`.');
    return;
  }

  const rows: string[][] = [
    [pc.dim('CLONE'), pc.dim('COLOUR'), pc.dim('BRANCH'), pc.dim('LAST COMMIT')],
  ];
  for (const clone of clones) {
    const commit = lastCommit(clone.path);
    const commitCell =
      commit === undefined
        ? pc.dim('(no commits)')
        : `${pc.yellow(commit.sha)} ${pc.dim(commit.date)} ${pc.dim(truncate(commit.committer, 18))} ${truncate(commit.subject, 50)}`;
    rows.push([cloneLabel(clone), clone.colour.name, currentBranch(clone.path), commitCell]);
  }
  table(rows);
};
