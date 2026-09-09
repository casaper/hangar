import { editors, type EditorDriver } from '../editor/index.ts';
import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import type { Hangar } from '../hangar.ts';
import { plansCollect } from './plans.ts';
import { claudeSessionsIn, runningServersIn } from '../procs.ts';
import { tmuxServer, tmuxSessionName, type TmuxServer } from '../tmux.ts';
import { tmpMerge } from './tmp.ts';
import { confirm, note, ok, step, warn } from '../ui.ts';

/**
 * `hangar close <clone>…` -- take a clone's working set down. The other end of `hangar open`.
 *
 * ## There is one tmux server per HANGAR, not one per clone
 *
 * Worth saying first because the obvious reading of "close the clone's tmux" is a `kill-server`,
 * and that would end every other clone's session -- every live agent in the fleet -- along with
 * it. A clone is a SESSION on this hangar's one socket, so closing it is `kill-session`, and the
 * server going away afterwards is tmux's own doing: `exit-empty` is on by default, so the server
 * exits when its last session closes. That is also what makes the next `hangar open` read a
 * freshly generated conf, with nothing here needing to arrange it.
 *
 * ## The plans are collected AFTER the kill, and that ordering is the point
 *
 * Each clone runs `plans collect` and `tmp merge` from a `SessionEnd` hook, and a killed Claude
 * Code process does not run its hooks -- so this command does that work itself, or a session's
 * plan stays in the clone it was written in and never reaches the shared archive.
 *
 * It runs after `kill-session` and never before. The root `CLAUDE.md` is explicit that session
 * end is *also the first moment a plan is safe to move, because nothing can rewrite it any more*;
 * collecting first races the very session being closed, which can still be writing.
 *
 * ## What it refuses, and what it merely warns about
 *
 * One refusal: closing the clone whose session this process is running INSIDE. That kills the
 * terminal the command was typed in, half way through the command. `--force` is the way past it,
 * because a session opened from inside another clone's window is a real case.
 *
 * Everything else is a warning inside one confirmation. A dev server dying with the session is
 * recoverable by restarting it, so it is named rather than treated as a guard -- the asymmetry
 * with `remove-clone`, which refuses on the same fact, is that `remove-clone` is about to delete
 * the directory. A live Claude Code session is not a warning at all: ending it is what the
 * command is for.
 */
export type CloseOptions = {
  all?: boolean | undefined;
  /** `--no-editor`, matching `open`: leave every editor window alone. */
  editor?: boolean | undefined;
  yes?: boolean | undefined;
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
};

/** Everything `close` reads before it decides anything. */
export type CloseFacts = {
  readonly clone: Clone;
  readonly sessionExists: boolean;
  /** The roles that have a window in the clone's session. */
  readonly roles: readonly string[];
  /** How many Claude Code processes are running in the clone. */
  readonly claudeSessions: number;
  /** Dev servers that will die with the session, by name. */
  readonly servers: readonly string[];
  /** True when `lsof` could not be asked, so `servers` being empty means nothing. */
  readonly serversUnknown: boolean;
  /** True when THIS process is inside the clone's own session. */
  readonly fromInside: boolean;
  /** The editors that can close a window, in config order. */
  readonly closers: readonly EditorDriver[];
};

export type CloseAction =
  | { readonly kind: 'nothing-open'; readonly clone: string }
  | { readonly kind: 'refuse-from-inside'; readonly clone: string }
  | { readonly kind: 'close-editor'; readonly clone: string; readonly editor: string }
  | { readonly kind: 'kill-session'; readonly clone: string; readonly roles: readonly string[] }
  | { readonly kind: 'collect'; readonly clone: string };

/**
 * The facts turned into a list of actions, and nothing else.
 *
 * Pure, and exported, for the reason every decision in this CLI is: `-n` renders exactly this
 * list and stops, so a dry run cannot describe something different from what the real run does,
 * and every branch of it can be printed side by side in a test without a clone to close.
 */
export const closePlan = (facts: CloseFacts, opts: CloseOptions): CloseAction[] => {
  const clone = facts.clone.name;
  if (facts.fromInside && opts.force !== true) return [{ kind: 'refuse-from-inside', clone }];
  const actions: CloseAction[] = [];
  if (opts.editor !== false) {
    for (const driver of facts.closers)
      actions.push({ kind: 'close-editor', clone, editor: driver.kind });
  }
  if (facts.sessionExists) {
    actions.push({ kind: 'kill-session', clone, roles: facts.roles });
    // Only when there was a session to kill: with nothing running there was no SessionEnd hook
    // skipped, so there is nothing here that the clone's own hook has not already done.
    actions.push({ kind: 'collect', clone });
  } else if (actions.length === 0) {
    actions.push({ kind: 'nothing-open', clone });
  }
  return actions;
};

/** One line per action, for the dry run and for the confirmation. */
export const describeCloseAction = (action: CloseAction): string => {
  switch (action.kind) {
    case 'nothing-open':
      return `${action.clone}: no session and no editor window — nothing to close`;
    case 'refuse-from-inside':
      return `${action.clone}: refusing — this command is running inside that clone's own session`;
    case 'close-editor':
      return `${action.clone}: close the ${action.editor} window`;
    case 'kill-session':
      return `${action.clone}: kill the tmux session (${action.roles.length} window(s): ${action.roles.join(', ')})`;
    case 'collect':
      return `${action.clone}: collect its plans and merge its tmp, which the killed session cannot`;
  }
};

/** What a confirmation has to say before anything is killed. */
export const closeWarnings = (facts: CloseFacts): string[] => {
  const out: string[] = [];
  if (facts.claudeSessions > 0)
    out.push(
      `${String(facts.claudeSessions)} live Claude Code session(s) — a tool call in flight is interrupted`,
    );
  if (facts.servers.length > 0)
    out.push(`dev server(s) that die with the session: ${facts.servers.join(', ')}`);
  if (facts.serversUnknown)
    out.push('`lsof` could not be run, so a running dev server would not have been noticed');
  return out;
};

const factsFor = (
  clone: Clone,
  server: TmuxServer,
  drivers: readonly EditorDriver[],
): CloseFacts => {
  const sessionExists = server.hasSession(clone);
  const scan = runningServersIn(clone);
  return {
    clone,
    sessionExists,
    roles: sessionExists ? server.roles(clone) : [],
    claudeSessions: claudeSessionsIn(clone.path).length,
    servers: scan.servers.map((proc) => proc.name),
    serversUnknown: !scan.portsChecked,
    fromInside: server.currentSession() === tmuxSessionName(clone),
    closers: drivers.filter((d) => d.capabilities.closeWindow && d.closeWindow !== undefined),
  };
};

/** Ascending by index, each clone once. Same shape as `open`'s. */
const resolveClones = (hangar: Hangar, refs: readonly string[], opts: CloseOptions): Clone[] => {
  if (opts.all === true) return discoverClones(hangar);
  if (refs.length === 0)
    throw new CliError('close needs a clone name, or --all', knownClonesHint(hangar));
  const byIndex = new Map<number, Clone>();
  for (const ref of refs) {
    const clone = requireClone(hangar, ref);
    byIndex.set(clone.index, clone);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

/**
 * Ask the editor to close the clone's window, and say what came back.
 *
 * Every arm of the outcome is printed as itself. `denied` in particular: Accessibility is a
 * permission a person grants in ten seconds once they are told which box to tick, and a run that
 * flattened it to "could not close the window" would send them looking for a bug instead.
 */
const closeEditorWindow = (driver: EditorDriver, clone: Clone): void => {
  const close = driver.closeWindow;
  if (close === undefined) return;
  const outcome = close(clone);
  switch (outcome.kind) {
    case 'closed':
      ok(`closed the ${driver.label} window`);
      return;
    case 'no-window':
      note(
        `${driver.label} has no window whose title names ${clone.name} — it may predate the generated window title, which \`hangar doctor --fix\` writes`,
      );
      return;
    case 'not-running':
      note(`${driver.label} is not running`);
      return;
    case 'denied':
      warn(`${driver.label}'s window is still open: ${outcome.hint}`);
      return;
    case 'unsupported':
      note(
        `closing an editor window is macOS-only, so the ${driver.label} window stays open — close it with Cmd+Shift+W, or its own equivalent`,
      );
      return;
    case 'failed':
      warn(`could not close the ${driver.label} window: ${outcome.why}`);
      return;
  }
};

export const closeClones = (hangar: Hangar, refs: readonly string[], opts: CloseOptions): void => {
  const clones = resolveClones(hangar, refs, opts);
  const server = tmuxServer(hangar);
  const drivers = opts.editor === false ? [] : editors(hangar).drivers;
  const dryRun = opts.dryRun === true;

  const plans = clones.map((clone) => {
    const facts = factsFor(clone, server, drivers);
    return { facts, actions: closePlan(facts, opts) };
  });

  for (const { facts, actions } of plans) {
    step(`close ${facts.clone.name}`);
    for (const action of actions) note(describeCloseAction(action));
    for (const line of closeWarnings(facts)) warn(line);
  }

  if (dryRun) {
    note('(dry run — nothing was closed)');
    return;
  }

  const killing = plans.filter(({ actions }) => actions.some((a) => a.kind === 'kill-session'));
  const warned = killing.some(({ facts }) => closeWarnings(facts).length > 0);
  if (killing.length > 0 && warned && opts.yes !== true) {
    if (!confirm(`Close ${killing.map(({ facts }) => facts.clone.name).join(', ')}?`)) {
      note('nothing was closed');
      return;
    }
  }

  let killed = 0;
  for (const { facts, actions } of plans) {
    for (const action of actions) {
      switch (action.kind) {
        case 'refuse-from-inside':
          warn(
            `${facts.clone.name} is the clone this session is running in — closing it would kill this terminal. \`--force\` if that is what you want.`,
          );
          break;
        case 'nothing-open':
          note(`${facts.clone.name} was not open`);
          break;
        case 'close-editor': {
          const driver = facts.closers.find((d) => d.kind === action.editor);
          if (driver !== undefined) closeEditorWindow(driver, facts.clone);
          break;
        }
        case 'kill-session':
          if (server.killSession(facts.clone)) {
            ok(`killed ${facts.clone.name}'s tmux session`);
            killed += 1;
          } else warn(`could not kill ${facts.clone.name}'s tmux session`);
          break;
        case 'collect':
          break;
      }
    }
  }

  /*
   * Once, after every session is down, rather than once per clone: both of these scan the whole
   * fleet, so calling them per clone would do the same walk N times for one extra plan each.
   */
  if (plans.some(({ actions }) => actions.some((a) => a.kind === 'collect'))) {
    plansCollect(hangar, { quiet: true });
    tmpMerge(hangar, { quiet: true });
  }

  if (killed > 0 && !server.running())
    note(
      'the tmux server exited with its last session — the next `hangar open` reads a fresh conf',
    );
};
