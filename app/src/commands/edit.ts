import { editorsToOpen, openEditors } from './open.ts';
import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { cloneLabel, heading, note } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar edit <clone>…` -- open a clone in its editors, and do nothing else at all.
 *
 * The other half of `hangar open`, on its own. `open` builds a tmux session, lands a branch and
 * opens a window; this opens the editors and touches no git state, no session and no window --
 * which is what makes it safe to bind to a key and press twice by accident.
 *
 * **That key is why the command exists.** `clone-tmux.conf` binds `C-b C-e` to run it for the
 * clone the session belongs to, so a developer sitting in a clone's tmux window can put that
 * clone in front of them in VS Code without leaving the keyboard or naming an index. The
 * alternative -- binding the key to `hangar open --editor` -- would fetch, move a branch and
 * create windows on every press, which is not what a key press should cost.
 *
 * Everything about HOW an editor is opened is `open.ts`'s: `editorsToOpen` reports the drivers
 * that would not build, `openEditors` isolates each launcher so one editor's failure is one line,
 * and the same dry run stops before `launch` while still probing whether the editor is there at
 * all. Nothing about it is spelled twice.
 */
export type EditOptions = {
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
};

/** Ascending by index, each clone once -- the same shape every command here has. */
const resolveClones = (hangar: Hangar, refs: readonly string[], opts: EditOptions): Clone[] => {
  if (opts.all === true) return discoverClones(hangar);
  if (refs.length === 0) {
    throw new CliError('edit needs a clone name, or --all', knownClonesHint(hangar));
  }
  const byIndex = new Map<number, Clone>();
  for (const ref of refs) {
    const clone = requireClone(hangar, ref);
    byIndex.set(clone.index, clone);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

export const edit = (hangar: Hangar, refs: readonly string[], opts: EditOptions): void => {
  const clones = resolveClones(hangar, refs, opts);
  const drivers = editorsToOpen(hangar);
  if (drivers.length === 0) {
    throw new CliError(
      'this hangar has no editor to open',
      '`editor.kinds` in hangar.config.yaml is what `hangar edit` opens; `hangar doctor` prints a row per configured editor.',
    );
  }
  /*
   * An editor that lives in a terminal is the one kind this command cannot open -- it IS a tmux
   * window, and `edit` creates none. Asked when it is the ONLY kind configured, because then the
   * command can do nothing at all and the honest answer is which command can.
   */
  if (drivers.every((driver) => driver.capabilities.inTerminalTab === true)) {
    throw new CliError(
      `this hangar's only editor lives in a terminal, so \`hangar edit\` cannot open it`,
      'It needs a tmux window to live in, which `hangar open <clone> -e` is what builds.',
    );
  }

  let opened = 0;
  for (const clone of clones) {
    heading(`Editors for ${cloneLabel(clone)}`);
    opened += openEditors(clone, drivers, opts.dryRun === true);
    // And the same for one configured BESIDE others, where the command still has work to do:
    // silently doing nothing for a configured editor would read as its launcher failing.
    for (const driver of drivers) {
      if (driver.capabilities.inTerminalTab !== true) continue;
      note(
        `${driver.label} lives in one of the clone's tmux windows — \`hangar open ${clone.index} -e\` is what puts it there`,
      );
    }
  }

  /*
   * Nothing came up, so this FAILS -- and that is the whole reason `openEditors` counts.
   *
   * Every miss inside it is a warning and a `continue`: an editor that is not installed, a
   * launcher that answered nothing, a driver that threw. Under `hangar open` that is right, the
   * window is what was asked for. Here the editor IS the command, and `C-b C-e` reads the exit
   * status and nothing else -- so exiting 0 would have the status bar say a clone was opened in
   * an editor that is not on the machine.
   */
  if (opened === 0) {
    throw new CliError(
      `no editor opened ${clones.length === 1 ? (clones[0]?.name ?? '') : 'any of those clones'}`,
      'Each one said why above. `hangar doctor` prints a row per configured editor with whether it can be launched at all.',
    );
  }

  if (opts.dryRun === true) note('(dry run — no editor was opened)');
};
