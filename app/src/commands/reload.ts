import { readFileSync } from 'node:fs';

import { coloursSync } from './colours.ts';
import { wantsWorkspaceFiles, workspaceContent, workspacePaths } from '../clone-config.ts';
import { editors, type EditorDriver } from '../editor/index.ts';
import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import type { Hangar } from '../hangar.ts';
import { claudeTranscripts } from '../claude-sessions.ts';
import { tabsFor } from './open.ts';
import { tmuxServer, tmuxSessionName, type TmuxPane, type TmuxServer } from '../tmux.ts';
import { tildify } from '../user-paths.ts';
import { confirm, note, ok, step, warn } from '../ui.ts';

/**
 * `hangar reload <clone>…` -- put a clone back on current config without closing it.
 *
 * ## This is the path `kill-server` was the only answer for
 *
 * `clone-tmux.conf` is read once, when the server starts. `colours sync` closes most of that gap
 * by writing the bar's options straight onto a live server, but it cannot reach a SERVER option
 * -- and two of the four settings Claude Code needs inside tmux are server options. The repair
 * for those was `kill-server`, which `doctor --fix` refuses because it ends every live agent in
 * the fleet.
 *
 * `source-file` is the answer: it re-executes the conf's commands, `set -s` included, on the
 * running server, with nothing interrupted. Two of those settings are negotiated with the
 * terminal when a client attaches (`extended-keys`, `focus-events`), so they reach an
 * already-attached client only when its tab is reopened; that is printed rather than implied.
 *
 * ## The shells are respawned, and a pane running something is left alone
 *
 * A process cannot have its environment changed from outside, so "reload the shell env" is a new
 * shell -- `respawn-pane -k`, which re-runs direnv, picks up a new PATH and installs the current
 * prompt. That is destructive to whatever is in the pane, so the decision is per pane and reads
 * `#{pane_current_command}`: a shell name means an idle shell and is respawned, and ANYTHING else
 * is somebody's dev server, test run or editor and is skipped BY NAME. A sweep of the session
 * would have been one line shorter and would kill a dev server without mentioning it.
 *
 * ## Claude Code comes back in the same conversation
 *
 * Its pane runs `claude`, which is not a shell, so the rule above would skip it -- and skipping
 * it is what makes a reload pointless, because that is the process holding the settings and the
 * `CLAUDE.md` that were read once at start-up. So it is a case of its own: the clone's most
 * recent live transcript gives a session id, the pane is respawned as `claude --resume <id>`
 * (measured: `--resume` with an id skips the picker), and the conversation continues.
 *
 * ## And it deliberately does NOT collect the plans, where `close` must
 *
 * `close` runs `plans collect` and `tmp merge` itself because a killed Claude Code process skips
 * its `SessionEnd` hook, and that session is over -- so nothing else would ever move its plan to
 * the shared archive. Here the session is not over: the same conversation comes back under the
 * same id, and it runs that hook when it genuinely ends. Collecting anyway would move a plan out
 * from under a session still working on it, which is the exact race the root `CLAUDE.md` states
 * the hook's timing to avoid.
 */
export type ReloadOptions = {
  all?: boolean | undefined;
  /** `--no-shells`: leave every idle shell pane alone. */
  shells?: boolean | undefined;
  /** `--no-claude`: leave the Claude Code pane running, settings and all. */
  claude?: boolean | undefined;
  /** `--no-editor`: do not rewrite the editor's per-clone artifacts. */
  editor?: boolean | undefined;
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
};

/**
 * The foreground commands that mean "an idle shell, safe to restart".
 *
 * An allow-list and not a deny-list, deliberately: the question is "is it safe to kill what is in
 * this pane", and the honest default for an unrecognised answer is no. A deny-list would have to
 * name every dev server, test runner and pager anyone might run, and the first one it forgot
 * would be killed silently.
 */
export const SHELL_COMMANDS: readonly string[] = ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'];

export const isIdleShell = (pane: TmuxPane): boolean => SHELL_COMMANDS.includes(pane.command);

/** Everything `reload` reads before it decides anything. */
export type ReloadFacts = {
  readonly clone: Clone;
  readonly sessionExists: boolean;
  readonly panes: readonly TmuxPane[];
  /** The most recent resumable session id with a live `claude` in the clone. */
  readonly liveSessionId: string | undefined;
  /** The command `terminal.tabs[]` gives the Claude Code role, for a pane with no session to resume. */
  readonly claudeCommand: string | undefined;
  /**
   * The pane THIS process is running in, when it is one of the clone's.
   *
   * Respawning it would kill the command half way through its own run -- and for an agent session
   * driving `hangar` from inside a clone, that is the agent killing itself. It is skipped and
   * named rather than refusing the whole clone: the conf and every other pane still reload, which
   * is most of what was asked for.
   */
  readonly ownPane: string | undefined;
  /**
   * The clone's workspace files whose content is not what the builder renders.
   *
   * Reported and never written, which is the one-writer rule this CLI holds everywhere: the
   * per-clone artifacts belong to `add-clone` and `doctor --fix`, and a second command writing
   * them is how two builders drift. `reload` is the command you run when a config change has to
   * reach a clone, so it is the right place to NOTICE, and the wrong place to fix.
   */
  readonly staleWorkspaces: readonly string[];
};

export type ReloadAction =
  | { readonly kind: 'not-open'; readonly clone: string }
  | { readonly kind: 'source-conf'; readonly clone: string }
  | { readonly kind: 'respawn-shell'; readonly clone: string; readonly pane: string }
  | {
      readonly kind: 'skip-pane';
      readonly clone: string;
      readonly pane: string;
      readonly command: string;
    }
  | {
      readonly kind: 'resume-claude';
      readonly clone: string;
      readonly pane: string;
      readonly session: string;
    }
  | { readonly kind: 'restart-claude'; readonly clone: string; readonly pane: string }
  | { readonly kind: 'skip-self'; readonly clone: string; readonly pane: string }
  | { readonly kind: 'workspace-stale'; readonly clone: string; readonly paths: readonly string[] };

/**
 * The facts turned into a list of actions, and nothing else. Pure, and exported, so `-n` renders
 * exactly what the real run performs.
 *
 * The Claude Code pane is recognised by its `@hangar_role` and not by what is running in it: a
 * session that has been exited leaves a shell in that pane, and the pane is still the one Claude
 * Code belongs in. That is also why `resume-claude` and `respawn-shell` cannot both fire for it.
 */
export const reloadPlan = (facts: ReloadFacts, opts: ReloadOptions): ReloadAction[] => {
  const clone = facts.clone.name;
  const actions: ReloadAction[] = [];
  if (opts.editor !== false && facts.staleWorkspaces.length > 0)
    actions.push({ kind: 'workspace-stale', clone, paths: facts.staleWorkspaces });
  if (!facts.sessionExists) {
    actions.push({ kind: 'not-open', clone });
    return actions;
  }
  actions.push({ kind: 'source-conf', clone });
  for (const pane of facts.panes) {
    if (pane.id === facts.ownPane) {
      actions.push({ kind: 'skip-self', clone, pane: pane.id });
      continue;
    }
    const isClaudePane = facts.claudeCommand !== undefined && pane.role === CLAUDE_ROLE;
    if (isClaudePane) {
      if (opts.claude === false) continue;
      if (facts.liveSessionId !== undefined)
        actions.push({ kind: 'resume-claude', clone, pane: pane.id, session: facts.liveSessionId });
      else actions.push({ kind: 'restart-claude', clone, pane: pane.id });
      continue;
    }
    if (opts.shells === false) continue;
    if (isIdleShell(pane)) actions.push({ kind: 'respawn-shell', clone, pane: pane.id });
    else actions.push({ kind: 'skip-pane', clone, pane: pane.id, command: pane.command });
  }
  return actions;
};

/**
 * The role whose pane runs Claude Code.
 *
 * The schema's default first tab, and the name every hangar in this fleet uses. A hangar that
 * renames it gets its Claude pane treated as an ordinary one -- respawned when idle, skipped
 * when busy -- which is the safe way round.
 */
const CLAUDE_ROLE = 'claude';

export const describeReloadAction = (action: ReloadAction): string => {
  switch (action.kind) {
    case 'not-open':
      return `${action.clone}: no tmux session — nothing to reload (\`hangar open\` starts one)`;
    case 'source-conf':
      return `${action.clone}: re-execute clone-tmux.conf on the live server`;
    case 'respawn-shell':
      return `${action.clone}: restart the shell in ${action.pane}`;
    case 'skip-pane':
      return `${action.clone}: leave ${action.pane} alone — \`${action.command}\` is running in it`;
    case 'resume-claude':
      return `${action.clone}: restart Claude Code in ${action.pane}, resuming ${action.session.slice(0, 8)}`;
    case 'restart-claude':
      return `${action.clone}: restart Claude Code in ${action.pane} (no live session to resume)`;
    case 'skip-self':
      return `${action.clone}: leave ${action.pane} alone — this command is running in it`;
    case 'workspace-stale':
      return `${action.clone}: ${String(action.paths.length)} workspace file(s) differ from the builder — \`hangar doctor --fix\` rewrites them`;
  }
};

const factsFor = (
  hangar: Hangar,
  clone: Clone,
  server: TmuxServer,
  drivers: readonly EditorDriver[],
): ReloadFacts => {
  const sessionExists = server.hasSession(clone);
  /*
   * The most recent transcript with a live `claude` in the clone. `claudeTranscripts` marks
   * liveness by matching a running process's working directory, which over-counts on purpose --
   * so this is "the session most likely running here", and the id it gives is checked by nothing
   * else. Resuming the wrong one of two would put the wrong conversation back, which is why
   * `--no-claude` exists and why the id is printed before anything is killed.
   */
  const live = claudeTranscripts(clone).filter((t) => t.live);
  // No editor drivers: `tabsFor` adds a window for terminal vim, which is not a role this
  // command has anything to say about -- it only needs the configured Claude Code command.
  const claudeTab = tabsFor(hangar, clone, {}, []).find((tab) => tab.role === CLAUDE_ROLE);
  return {
    clone,
    sessionExists,
    panes: sessionExists ? server.panes(clone) : [],
    liveSessionId: live[0]?.id,
    claudeCommand: claudeTab?.command,
    staleWorkspaces: staleWorkspacesIn(hangar, clone, drivers),
    ownPane: ownPaneOf(server, clone),
  };
};

/**
 * Which of the clone's workspace files disagree with `workspaceContent`.
 *
 * The same comparison `doctor` makes, through the same builder, so the two cannot disagree about
 * what "stale" means. Only where a configured editor actually reads one -- `wantsWorkspaceFiles`
 * is the predicate `add-clone`, `doctor` and the golden capture all share, so a JetBrains-only
 * hangar is not told about a file it has no reason to have.
 */
const staleWorkspacesIn = (
  hangar: Hangar,
  clone: Clone,
  drivers: readonly EditorDriver[],
): string[] => {
  if (drivers.every((driver) => !driver.capabilities.syncArtifacts)) return [];
  if (!wantsWorkspaceFiles(hangar)) return [];
  const wanted = workspaceContent(clone);
  return workspacePaths(clone).filter((path) => {
    try {
      return readFileSync(path, 'utf8') !== wanted;
    } catch {
      // Absent is `doctor`'s business rather than this command's: a clone with no workspace file
      // has never been through `add-clone` or `doctor --fix`, which is a bigger thing to say.
      return false;
    }
  });
};

/**
 * `$TMUX_PANE`, but only when this process is inside THAT clone's session.
 *
 * tmux exports the variable in every pane, including one on somebody else's socket -- so the
 * session has to be checked too, or a `hangar reload 3` typed in clone_02's window would match
 * pane ids across sessions and skip whichever of clone_03's panes happened to share the id.
 */
const ownPaneOf = (server: TmuxServer, clone: Clone): string | undefined => {
  if (server.currentSession() !== tmuxSessionName(clone)) return undefined;
  const pane = process.env['TMUX_PANE'];
  return pane === undefined || pane === '' ? undefined : pane;
};

const resolveClones = (hangar: Hangar, refs: readonly string[], opts: ReloadOptions): Clone[] => {
  if (opts.all === true) return discoverClones(hangar);
  if (refs.length === 0)
    throw new CliError('reload needs a clone name, or --all', knownClonesHint(hangar));
  const byIndex = new Map<number, Clone>();
  for (const ref of refs) {
    const clone = requireClone(hangar, ref);
    byIndex.set(clone.index, clone);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

export const reloadClones = (
  hangar: Hangar,
  refs: readonly string[],
  opts: ReloadOptions,
): void => {
  const clones = resolveClones(hangar, refs, opts);
  const server = tmuxServer(hangar);
  const drivers = opts.editor === false ? [] : editors(hangar).drivers;
  const dryRun = opts.dryRun === true;

  const plans = clones.map((clone) => {
    const facts = factsFor(hangar, clone, server, drivers);
    return { facts, actions: reloadPlan(facts, opts) };
  });

  for (const { facts, actions } of plans) {
    step(`reload ${facts.clone.name}`);
    for (const action of actions) note(describeReloadAction(action));
  }

  if (dryRun) {
    note('(dry run — nothing was reloaded)');
    return;
  }

  const killsClaude = plans.some(({ actions }) =>
    actions.some((a) => a.kind === 'resume-claude' || a.kind === 'restart-claude'),
  );
  if (killsClaude && opts.yes !== true) {
    if (
      !confirm('Restart Claude Code in the clone(s) above? A tool call in flight is interrupted.')
    ) {
      note('nothing was reloaded');
      return;
    }
  }

  /*
   * The generated artifacts first, so `source-file` reads a current conf rather than whatever was
   * last written. `coloursSync` is the writer for all of them and is idempotent, so this is the
   * existing one being called rather than a second one growing here.
   */
  coloursSync(hangar, {});

  for (const { facts, actions } of plans) {
    for (const action of actions) {
      switch (action.kind) {
        case 'not-open':
          note(`${facts.clone.name} is not open`);
          break;
        case 'source-conf':
          if (server.sourceConf()) ok(`${facts.clone.name}: tmux re-read its config`);
          else warn(`${facts.clone.name}: could not re-read clone-tmux.conf`);
          break;
        case 'respawn-shell': {
          const pane = facts.panes.find((p) => p.id === action.pane);
          if (pane !== undefined && server.respawnPane(pane.id, pane.path))
            ok(`${facts.clone.name}: fresh shell in ${pane.id}`);
          else warn(`${facts.clone.name}: could not restart the shell in ${action.pane}`);
          break;
        }
        case 'skip-pane':
          note(`${facts.clone.name}: ${action.pane} left running \`${action.command}\``);
          break;
        case 'skip-self':
          warn(
            `${facts.clone.name}: ${action.pane} is the pane this command is running in, so it keeps the config it started with — reload from another window, or reopen this tab`,
          );
          break;
        case 'resume-claude':
        case 'restart-claude': {
          const pane = facts.panes.find((p) => p.id === action.pane);
          if (pane === undefined) break;
          const command =
            action.kind === 'resume-claude'
              ? `${facts.claudeCommand ?? 'claude'} --resume ${action.session}`
              : (facts.claudeCommand ?? 'claude');
          if (server.respawnPane(pane.id, facts.clone.path, command))
            ok(`${facts.clone.name}: Claude Code restarted in ${pane.id}`);
          else warn(`${facts.clone.name}: could not restart Claude Code in ${pane.id}`);
          break;
        }
        case 'workspace-stale':
          warn(
            `${facts.clone.name}: ${action.paths.map((path) => tildify(path)).join(', ')} differ from the builder — \`hangar doctor ${String(facts.clone.index)} --fix\``,
          );
          break;
      }
    }
  }

  if (plans.some(({ actions }) => actions.some((a) => a.kind === 'source-conf')))
    note(
      '`extended-keys` and `focus-events` are negotiated when a client attaches, so those two reach an open tab only when it is reopened',
    );
};
