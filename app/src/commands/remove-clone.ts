import { existsSync, renameSync, rmSync, unlinkSync } from 'node:fs';

import { CliError } from '../exec.ts';
import { discoverClones, requireClone, type Clone } from '../fleet.ts';
import { clearColourAssignment, colourAssignmentsLabel } from '../colour-assignments.ts';
import { themePath } from '../generate/theme-json.ts';
import { git, gitTry, syncState } from '../git.ts';
import { tildify } from '../user-paths.ts';
import { claudeSessionsIn, runningServersIn } from '../procs.ts';
import { cloneLabel, fail, heading, note, ok, warn } from '../ui.ts';
import { coloursSync } from './colours.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar remove-clone` -- take a clone out of the fleet, and optionally delete it.
 *
 * Detaching RENAMES the directory to `<name>.detached`. That is not cosmetic: clone discovery
 * is purely filesystem-based, so a directory still called `clone_NN` is still a member of the
 * fleet no matter how many remotes you drop. Renaming is what actually removes it -- and it
 * keeps every byte of the working tree, which is why it is the default and deleting is not.
 *
 * Indices are never renumbered. Nothing in the fleet is positional -- ports and hues are pure
 * functions of the index -- so a gap costs nothing, and renumbering would silently move
 * another clone's ports out from under a running server.
 */
export type RemoveCloneOptions = {
  delete?: boolean | undefined;
  force?: boolean | undefined;
};

type Guard = { readonly message: string };

/** Things that break the moment the directory moves, whether renamed or deleted. */
const movementGuards = (clone: Clone): Guard[] => {
  const found: Guard[] = [];
  const servers = runningServersIn(clone.path);
  if (servers.length > 0) {
    found.push({
      message: `running: ${servers.map((s) => `${s.name} (pid ${s.pid})`).join(', ')} — stop it first, its cwd is about to move`,
    });
  }
  const sessions = claudeSessionsIn(clone.path);
  if (sessions.length > 0) {
    found.push({
      message: `${sessions.length} live Claude Code session(s) (${sessions.map((s) => `pid ${s.pid}`).join(', ')}) — their working directory is about to move`,
    });
  }
  return found;
};

/** Work that exists nowhere else, and so is lost for good on delete. */
const dataGuards = (clone: Clone): Guard[] => {
  const found: Guard[] = [];
  const state = syncState(clone.path);
  if (state.dirty > 0 || state.untracked > 0) {
    found.push({
      message: `${state.dirty} modified and ${state.untracked} untracked file(s) — this work exists nowhere else`,
    });
  }
  const unpushed = gitTry(clone.path, ['log', '--branches', '--not', '--remotes', '--oneline']);
  if (unpushed !== undefined && unpushed !== '') {
    found.push({
      message: `${unpushed.split('\n').length} commit(s) on local branches that are not on any remote`,
    });
  }
  const stash = gitTry(clone.path, ['stash', 'list']);
  if (stash !== undefined && stash !== '') {
    found.push({ message: `${stash.split('\n').length} stash entr(ies)` });
  }
  return found;
};

const detachedPathFor = (clone: Clone): string => {
  const base = `${clone.path}.detached`;
  if (!existsSync(base)) return base;
  return `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
};

export const removeClone = (hangar: Hangar, ref: string, opts: RemoveCloneOptions): void => {
  const clone = requireClone(hangar, ref);
  const siblings = discoverClones(hangar).filter((c) => c.index !== clone.index);
  const deleting = opts.delete === true;

  heading(`${deleting ? 'Deleting' : 'Detaching'} ${cloneLabel(clone)}`);

  const blocking = [...movementGuards(clone), ...(deleting ? dataGuards(clone) : [])];
  for (const guard of blocking) fail(guard.message);
  if (blocking.length > 0) {
    if (opts.force !== true) {
      throw new CliError(
        `${clone.name} is not safe to ${deleting ? 'delete' : 'detach'}`,
        deleting
          ? 'Resolve the above, or pass --force. Uncommitted work is NOT recoverable.'
          : 'Resolve the above, or pass --force. Detaching keeps the files, but moves them.',
      );
    }
    warn('--force given: proceeding despite the above');
  }

  // 1. drop it as a remote from every sibling, so nobody fetches a path that is gone
  for (const sibling of siblings) {
    if (git(sibling.path, ['remote', 'remove', clone.name]).ok) {
      ok(`removed remote ${clone.name} from ${sibling.name}`);
    }
  }

  // 2. move or delete the directory. This MUST happen before the colour artifacts are
  //    regenerated: discovery is filesystem-based, so a clone still named clone_NN would be
  //    regenerated straight back into the table -- and its theme recreated after deletion.
  if (deleting) {
    rmSync(clone.path, { recursive: true, force: true });
    ok(`deleted ${clone.path}`);
  } else {
    const target = detachedPathFor(clone);
    renameSync(clone.path, target);
    ok(`renamed to ${target}`);
    note(
      'It keeps every file, but is no longer part of the fleet — discovery matches clone_NN only.',
    );
    note(`Delete it with \`rm -rf ${target}\` when you are done with it.`);
  }

  // 3. its theme -- safe now that the directory no longer looks like a clone
  const theme = themePath(clone);
  if (existsSync(theme)) {
    unlinkSync(theme);
    ok(`deleted ${tildify(theme)}`);
  }

  // 4. its colour assignment, if a human chose one. `nextFreeIndex(hangar)` reuses this index, so
  //    leaving it behind would hand the next clone this one's hue.
  if (clearColourAssignment(hangar, clone.index)) {
    ok(`dropped its ${clone.colour.name} assignment from ${colourAssignmentsLabel(hangar)}`);
  }

  // 5. the generated artifacts no longer mention it
  heading('Regenerating colour artifacts');
  coloursSync(hangar, {});

  note(`Index ${clone.index} is now free; the next \`hangar add-clone\` will reuse it.`);
};
