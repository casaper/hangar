import { CliError } from '../exec.ts';
import type { Hangar } from '../hangar.ts';
import { tmuxServer } from '../tmux.ts';
import { confirm, note, ok, step, warn } from '../ui.ts';
import {
  clonesBeingKilled,
  closeWarnings,
  executeCloses,
  planCloses,
  reportCloses,
} from './close.ts';
import { server, uptimeOf, type WindowRow } from './up.ts';

/**
 * `hangar down` -- the other end of `hangar up`: every clone closed, then the root window.
 *
 * ## It is not symmetric with `up`, on purpose
 *
 * `up` opens only the hangar-root window, because which clones to open is a decision per clone
 * and `hangar open` already makes it. `down` has no such decision to make -- "take the hangar
 * down" means all of it -- so it closes every clone through `close`'s own planner and executor,
 * which already stop dev servers before their pane goes, close editor windows, and run the
 * `plans collect` / `tmp merge` that a killed session's `SessionEnd` hook never gets to.
 * `--keep-clones` is the root window alone.
 *
 * ## The root server is killed LAST, and that ordering is not cosmetic
 *
 * The shell tab is where this is normally typed, and it is a window on the server being killed:
 * `kill-server` ends this very process. Everything else has to be done -- and reported -- first.
 * It is a `kill-server` rather than a `kill-session` because the root socket holds one session
 * and nothing else (`claudeSocketName` is its own socket for exactly that reason), so the two are
 * the same act; the server form also leaves no doubt the socket is gone.
 *
 * Root sessions need no plans collect of their own: the root `.claude/settings.json` already
 * writes their plans straight into the archive.
 *
 * ## One confirmation for everything
 *
 * `close --all` and a root teardown would each ask on their own; that is two questions for one
 * decision, and declining the second after accepting the first leaves half a hangar. So the
 * plans are made first, every warning is printed, ONE `confirm` covers the lot, and the clones
 * are executed with no further question.
 *
 * ## Two refusals
 *
 * From a Claude Code session (`$CLAUDECODE`): a session tearing down every session, its own
 * included, is not something a tool call should do, whatever the permission list says. And from
 * inside a clone's own tmux session: the clone pass would kill this terminal half way through,
 * before the root window was reached. `hangar close` is the command for that case.
 */

export type DownOptions = {
  keepClones?: boolean | undefined;
  /** `--no-editor`, matching `close`. */
  editor?: boolean | undefined;
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
};

/** The root window's tabs as `down` reports them. */
export type RootTab = { readonly name: string; readonly claudeUp: string | undefined };

/** One line per tab, plus the act itself. Pure, so every shape prints without a server. */
export const downRootLines = (running: boolean, tabs: readonly RootTab[]): string[] => {
  if (!running) return ['root: the hangar-root window is not running — nothing to stop'];
  return [
    ...tabs.map((t) =>
      t.claudeUp === undefined
        ? `root: ${t.name} tab`
        : `root: ${t.name} tab — Claude Code, up ${t.claudeUp}`,
    ),
    'root: kill its tmux server — last, because the shell tab is on it',
  ];
};

const tabOf = (row: WindowRow): RootTab =>
  row.mode !== undefined
    ? { name: row.mode, claudeUp: uptimeOf(row.pid) }
    : { name: row.shell ? 'shell' : `window ${String(row.index)}`, claudeUp: undefined };

const refuse = (hangar: Hangar): void => {
  if ((process.env['CLAUDECODE'] ?? '') !== '') {
    throw new CliError(
      'hangar down cannot run from inside a Claude Code session',
      'it ends every session in the hangar, this one included -- run it from a terminal.',
    );
  }
  const inside = tmuxServer(hangar).currentSession();
  if (inside !== undefined) {
    throw new CliError(
      `this terminal is inside ${inside}'s tmux session, which hangar down would kill half way through`,
      'run it from the shell tab of `hangar up`, or any terminal outside the clones -- or use `hangar close`.',
    );
  }
};

export const down = (hangar: Hangar, opts: DownOptions): void => {
  const dryRun = opts.dryRun === true;
  if (!dryRun) refuse(hangar);

  const root = server(hangar);
  const running = root.running();
  const tabs = running ? root.windows().map(tabOf) : [];
  const plans =
    opts.keepClones === true
      ? []
      : planCloses(hangar, [], { all: true, editor: opts.editor, dryRun });

  reportCloses(plans);
  step('stop the hangar-root window');
  for (const line of downRootLines(running, tabs)) note(line);

  if (dryRun) {
    note('(dry run — nothing was stopped)');
    return;
  }

  const live = tabs.filter((t) => t.claudeUp !== undefined);
  const warned = live.length > 0 || plans.some(({ facts }) => closeWarnings(facts).length > 0);
  const killing = clonesBeingKilled(plans);
  // Any action at all, not just a kill: a clone with nothing but an editor window open still has
  // something for `executeCloses` to close, exactly as `close --all` would.
  const anything = plans.some(({ actions }) => actions.some((a) => a.kind !== 'nothing-open'));
  if (!running && !anything) {
    note('nothing is running');
    return;
  }
  if (warned && opts.yes !== true) {
    const what = [
      ...killing.map(({ facts }) => facts.clone.name),
      ...(running ? ['the hangar-root window'] : []),
    ];
    if (!confirm(`Take down ${what.join(', ')}?`)) {
      note('nothing was stopped');
      return;
    }
  }

  executeCloses(hangar, plans);

  if (!running) return;
  ok('stopping the hangar-root window — `hangar up` brings it back');
  if (!root.tmux(['kill-server']).ok) warn(`could not kill the ${root.socket} tmux server`);
};
