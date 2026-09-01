import pc from 'picocolors';

import { CliError } from '../exec.ts';
import { discoverClones } from '../fleet.ts';
import { discoverKeys, KEY_RE, linkKey } from '../jira.ts';
import { jiraStore, tildify } from '../paths.ts';
import { fail, heading, note, ok, warn } from '../ui.ts';

/**
 * `orch-util jira link` -- share the per-ticket Jira cache across every clone.
 *
 * Nothing enforces the linking: the `jira-scope` skill creates `tmp/<KEY>` as a real
 * directory whenever a clone fetches a ticket the fleet has not linked yet. So when
 * `ls -la clone_NN/tmp` shows a real directory among the symlinks, run this again -- it
 * adopts them in place.
 *
 * Caveat worth knowing before trusting a shared file: `ticket_<KEY>.md`, its relation
 * variants and the attachments are clone- and branch-independent, which is the point.
 * `pr_description_<KEY>.md` is NOT -- it is derived from the working-tree diff, so it is
 * shared as a side effect and is last-writer-wins when two clones work one ticket at once.
 */
export type JiraLinkOptions = { dryRun?: boolean | undefined };

export const jiraLink = (keys: readonly string[], opts: JiraLinkOptions): void => {
  const dryRun = opts.dryRun === true;
  const clones = discoverClones();
  if (clones.length === 0) throw new CliError('no clones found');

  for (const key of keys) {
    if (!KEY_RE.test(key)) throw new CliError(`not an issue key: ${key}`);
  }

  const targets = keys.length > 0 ? [...keys] : discoverKeys(clones);
  if (targets.length === 0) {
    note('No ticket dirs found and none given. Nothing to do.');
    return;
  }

  note(`store: ${tildify(jiraStore)}`);
  note(`keys:  ${targets.join(', ')}`);

  let conflicts = 0;
  let changes = 0;
  for (const key of targets) {
    const actions = linkKey(clones, key, dryRun);
    const interesting = actions.filter((a) => a.kind !== 'already');
    if (interesting.length === 0) continue;
    heading(key);
    for (const action of actions) {
      const label = `${action.clone}: ${action.message}`;
      if (action.kind === 'already') note(label);
      else if (action.kind === 'warning') warn(label);
      else if (action.kind === 'conflict') {
        conflicts += 1;
        fail(label);
      } else {
        changes += 1;
        ok(label);
      }
    }
  }

  console.log('');
  if (changes === 0 && conflicts === 0) note('Every ticket dir is already linked.');
  if (conflicts > 0) {
    warn(
      `${conflicts} conflicting file(s) kept as *.from-<clone> in the store — review and delete the loser.`,
    );
  }
  if (dryRun) note(pc.dim('(dry run — nothing changed)'));
};
