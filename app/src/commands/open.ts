import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { landOnBranch } from './checkout-default.ts';
import { editors, type EditorDriver } from '../editor/index.ts';
import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { currentBranch } from '../git.ts';
import {
  attachCommand,
  attachHint,
  tmuxSessionName,
  tmuxServer,
  type TabSpec,
  type TmuxServer,
} from '../tmux.ts';
import { tildify } from '../user-paths.ts';
import { terminal, type EmulatorCapabilities, type Placement } from '../terminal/index.ts';
import { note, ok, step, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';
import { portSummary } from '../ports.ts';

/**
 * `hangar open <clone>…` -- a clone's whole working set in one command.
 *
 * One tab (or window) of the developer's emulator per clone, attached to that clone's session on
 * this hangar's own tmux socket, with one tmux window inside it per `terminal.tabs[]` role -- plus
 * every editor `editor.kinds` lists, which for most hangars is VS Code and its workspace file.
 *
 * ## One session per clone, and why that makes the safety check a fact
 *
 * A clone's identity is its tmux SESSION NAME. So "is this clone already open" is
 * `has-session -t =clone_02:` -- not an inference from what some window's shell happens to be
 * standing in, and not a tag that a rename or a `cd` can invalidate. That matters because the
 * failure it prevents is this fleet's worst: a second Claude Code session in a clone that already
 * has one running. A clone that is open is brought forward and NOTHING is written to its session.
 *
 * It also makes the good case possible at all. A session outlives the tab attached to it, so a
 * clone whose window was closed is still there with `claude` running in it, and opening the clone
 * again reattaches rather than starting over.
 *
 * ## The decision is a pure function
 *
 * Every fact `open` needs is a READ (`has-session`, `list-windows`, `list-clients`,
 * `isAvailable`) and every step it takes is a write, so the two separate cleanly: `openPlan`
 * turns the facts into a list of actions, `-n` renders that list and stops, and the real run
 * performs it. One rendering builder serves both, which is what keeps a dry run from describing
 * something different from what happens.
 */
export type OpenOptions = {
  /**
   * `--no-editor`, not `--no-code`: with a list of editors the flag means "open none of them",
   * and a JetBrains-only hangar controlled by a flag called `code` reads as a bug in the help.
   */
  editor?: boolean | undefined;
  claude?: boolean | undefined;
  all?: boolean | undefined;
  /**
   * The branch each clone is put on before its window opens. Absent means the repo's DEFAULT
   * branch, which is the default because of what `open` is for: a clone you are opening is a
   * clone you are starting work in, and starting on last week's ticket branch -- or on a default
   * branch a week behind origin -- is never what was wanted. `--no-checkout` turns it off, and
   * `--branch <name>` names another one.
   */
  branch?: string | undefined;
  checkout?: boolean | undefined;
  /**
   * Move the branch of a clone that has a live Claude session in it.
   *
   * The flag exists because the landing offers it: without it, a clone with a session is asked
   * about (one clone) or left alone (a sweep), and the warning that says so has to name a real
   * flag. It governs the CHECKOUT only -- the window opens either way.
   */
  includeBusy?: boolean | undefined;
  /** `--tab` / `--window`, overriding `terminal.placement` for this run. */
  placement?: Placement | undefined;
  /**
   * Print every decision and change nothing -- the branch, the session and the editors alike.
   *
   * `open` was the one acting command in this CLI without a dry run, and it mattered more than
   * the omission looked, because `open` grew a checkout: `--all` now fetches and moves a branch in
   * EVERY clone, and `--no-checkout` is a way to not do that rather than a way to see what it
   * would do first.
   */
  dryRun?: boolean | undefined;
};

/**
 * The tmux windows a clone gets. Exported and pure.
 *
 * From `terminal.tabs[]`, not a hardcoded three. It was `claude` at the clone root, `shell` at the
 * clone root, and a third at `<clone>/angular` -- one repo's layout, in a list the schema had
 * described as configurable and that nothing read. A hangar for a repo with no `angular/` got a
 * third window starting in a directory that does not exist, on every `hangar open`.
 *
 * `--no-claude` still means "no window runs a command", and it is expressed that way rather than
 * as "drop the window whose role is claude": the role names are the config's, so matching on one
 * would be matching on a string the developer chose. A window with no command is a shell, and a
 * shell in the right directory is the useful degradation.
 */
export const tabsFor = (
  hangar: Hangar,
  clone: Clone,
  opts: OpenOptions,
  editorDrivers: readonly EditorDriver[],
): TabSpec[] => {
  const configured = hangar.config.terminal.tabs.map((tab): TabSpec => ({
    cwd: tab.dir === '.' ? clone.path : join(clone.path, tab.dir),
    ...(opts.claude === false || tab.command === undefined ? {} : { command: tab.command }),
    clone: clone.name,
    role: tab.role,
  }));

  return [
    ...configured,
    // An editor that lives INSIDE a terminal gets a window in the clone's session rather than a
    // window of its own: terminal vim has no window to hand a path to. It is built here, with the
    // others, so it sits beside them in the same session -- which the editor driver could not
    // arrange, since it knows nothing about the clone's session. See
    // `EditorCapabilities.inTerminalTab`.
    ...editorDrivers
      .filter((editor) => editor.capabilities.inTerminalTab === true)
      .map((editor) => ({
        cwd: clone.path,
        ...(editor.terminalCommand === undefined ? {} : { command: editor.terminalCommand }),
        clone: clone.name,
        role: editor.kind,
      })),
  ];
};

/** Ascending by index, each clone once. */
const resolveClones = (hangar: Hangar, refs: readonly string[], opts: OpenOptions): Clone[] => {
  if (opts.all === true) return discoverClones(hangar);
  if (refs.length === 0)
    throw new CliError('open needs a clone name, or --all', knownClonesHint(hangar));
  const byIndex = new Map<number, Clone>();
  for (const ref of refs) {
    const clone = requireClone(hangar, ref);
    byIndex.set(clone.index, clone);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

/** Everything `open` reads before it decides anything. */
export type OpenFacts = {
  readonly clone: Clone;
  /** From `tabsFor` -- one per role, in config order. */
  readonly roles: readonly TabSpec[];
  readonly sessionExists: boolean;
  /** The roles that already have a window in the clone's session. */
  readonly existingRoles: readonly string[];
  /** The tty of each client attached to the clone. Empty means nobody is looking at it. */
  readonly clientTtys: readonly string[];
  /** The session this process is inside, when that session is on OUR socket. */
  readonly currentSession: string | undefined;
  readonly placement: Placement;
  readonly emulator: EmulatorCapabilities;
};

export type OpenAction =
  | { readonly kind: 'create-session'; readonly clone: string; readonly first: TabSpec }
  | { readonly kind: 'create-window'; readonly clone: string; readonly tab: TabSpec }
  | {
      readonly kind: 'open-emulator';
      readonly clone: string;
      readonly command: string;
      readonly placement: Placement;
    }
  | { readonly kind: 'raise'; readonly clone: string; readonly tty: string }
  | { readonly kind: 'already-here'; readonly clone: string }
  | { readonly kind: 'cannot-raise'; readonly clone: string; readonly hint: string }
  | { readonly kind: 'attach-hint'; readonly clone: string; readonly hint: string };

/**
 * What `open` will do to one clone, from what it found. Pure, exported, and the whole decision.
 *
 * The properties worth knowing, because they are what `test/open-plan.test.ts` pins rather than
 * anything about the wording:
 *
 * - a clone that is fully open with somebody attached yields **exactly one `raise` and no writes
 *   at all**. That is what protects a live Claude session from a stray `new-window`.
 * - a clone whose session exists but is missing a role yields exactly the missing windows, which
 *   is how a new `terminal.tabs[]` entry reaches a clone that is already open.
 * - no plan ever contains both `raise` and `open-emulator`; a clone gets brought forward or gets
 *   a window, never both.
 */
export const openPlan = (hangar: Hangar, facts: OpenFacts): readonly OpenAction[] => {
  const { clone, roles, placement, emulator } = facts;
  const name = clone.name;
  const actions: OpenAction[] = [];

  const [first, ...rest] = roles;
  if (!facts.sessionExists && first !== undefined) {
    actions.push({ kind: 'create-session', clone: name, first });
    for (const tab of rest) actions.push({ kind: 'create-window', clone: name, tab });
  } else {
    for (const tab of roles) {
      if (!facts.existingRoles.includes(tab.role)) {
        actions.push({ kind: 'create-window', clone: name, tab });
      }
    }
  }

  // Already looking at it: one note, and nothing opened. Anything else would put a second client
  // on a session the developer is inside, which is a redraw at best and a duplicate at worst.
  if (facts.currentSession === tmuxSessionName(clone)) {
    actions.push({ kind: 'already-here', clone: name });
    return actions;
  }

  const [tty] = facts.clientTtys;
  if (tty !== undefined) {
    if (emulator.raiseByTty) actions.push({ kind: 'raise', clone: name, tty });
    else {
      actions.push({
        kind: 'cannot-raise',
        clone: name,
        hint: attachHint(hangar, clone),
      });
    }
    return actions;
  }

  const wanted: Placement =
    placement === 'tab' && !emulator.openTab && emulator.openWindow ? 'window' : placement;
  const can = wanted === 'tab' ? emulator.openTab : emulator.openWindow;
  if (!can) {
    // `terminal.kind: none` lands here, and it is a mode rather than a failure: the session is
    // built, the roles are in it, and the developer is handed the line that attaches to it.
    actions.push({ kind: 'attach-hint', clone: name, hint: attachHint(hangar, clone) });
    return actions;
  }
  actions.push({
    kind: 'open-emulator',
    clone: name,
    command: attachCommand(hangar, clone),
    placement: wanted,
  });
  return actions;
};

/** One line per action, for the dry run and the real run alike. Pure and exported. */
export const describeAction = (action: OpenAction, done: boolean): string => {
  const verb = (past: string, future: string): string => (done ? past : `would ${future}`);
  switch (action.kind) {
    case 'create-session':
      return `${verb('created', 'create')} ${action.clone}'s tmux session, on ${action.first.role}`;
    case 'create-window':
      return `${verb('added', 'add')} ${action.clone}'s ${action.tab.role} window`;
    case 'open-emulator':
      return `${verb('opened', 'open')} a ${action.placement} for ${action.clone}`;
    case 'raise':
      return `${action.clone} is already open — ${verb('brought', 'bring')} it forward (${action.tty})`;
    case 'already-here':
      return `${action.clone} is the session you are in — nothing to open`;
    case 'cannot-raise':
      return `${action.clone} is already open, and this terminal cannot bring it forward`;
    case 'attach-hint':
      return `${action.clone}'s session is ready — attach to it yourself`;
  }
};

/** Perform one action. Returns false when the step failed and the caller should say so. */
const perform = (
  server: TmuxServer,
  clone: Clone,
  driver: ReturnType<typeof terminal>['driver'],
  action: OpenAction,
): boolean => {
  switch (action.kind) {
    case 'create-session':
      return server.createSession(clone, action.first);
    case 'create-window':
      return server.addWindow(clone, action.tab);
    case 'open-emulator': {
      if (
        !driver.open({
          command: action.command,
          placement: action.placement,
          title: `${clone.name} · ${clone.hangar.id}`,
        })
      ) {
        return false;
      }
      /*
       * Wait for the client, and treat its absence as a failure.
       *
       * An emulator returns as soon as it has created a tab, so without this `open` claims a
       * clone is open while the process in it has not attached -- and a second `open` moments
       * later cannot tell that from a detached session, so it opens ANOTHER tab. That is the
       * duplicate this command exists to prevent, arriving from the one direction the session
       * name cannot rule out. Three seconds because a client appears in under 100ms when it
       * works; the wait is only ever paid when something is wrong.
       */
      return server.awaitClient(clone, 3000) !== undefined;
    }
    case 'raise':
      return driver.raiseByTty(action.tty);
    case 'already-here':
    case 'cannot-raise':
    case 'attach-hint':
      return true;
  }
};

/**
 * Open the clone in every editor this hangar is configured for.
 *
 * Every one, not the first that works: two editors can both have the same clone open, because
 * their project files are different files, and a developer who listed both meant both.
 */
const openEditors = (clone: Clone, drivers: readonly EditorDriver[], dryRun: boolean): void => {
  for (const driver of drivers) {
    // Already opened as one of the clone's tmux windows, above -- not a window to launch.
    if (driver.capabilities.inTerminalTab === true) continue;
    try {
      openEditor(clone, driver, dryRun);
    } catch (err) {
      // One editor's failure is one line, and the loop goes on. Only the default editor has to
      // work; the rest are best effort, and every one of them shells out to a launcher nobody
      // here has run. Letting a throw out would end the whole `open` -- so a clone listing
      // `[zed, vscode]` would lose VS Code to Zed's launcher, which inverts the priority the
      // config states.
      warn(
        `${driver.label} failed on ${clone.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      note(
        "the clone's other editors are unaffected — `hangar doctor` reports what it can launch.",
      );
    }
  }
};

/** One editor, one clone. Throws only if the driver does; `openEditors` owns that. */
const openEditor = (clone: Clone, driver: EditorDriver, dryRun: boolean): void => {
  if (!driver.capabilities.launch) {
    warn(`${driver.label} cannot be opened by Hangar`);
    note(driver.unavailableHint());
    return;
  }
  if (!driver.isAvailable()) {
    warn(`${driver.label} is not available — ${clone.name} not opened in it`);
    note(driver.unavailableHint());
    return;
  }
  if (dryRun) {
    // Stops before `launch`, which is the only call here that opens anything. Both checks above
    // are probes, so a dry run still answers the question people actually have -- would my editor
    // come up at all -- rather than assuming it would.
    step(`would open ${clone.name} in ${driver.label}`);
    return;
  }
  const res = driver.launch(clone);
  if (res === undefined) {
    warn(`${driver.label} would not open ${clone.name}`);
    note(driver.unavailableHint());
    return;
  }
  if (res.note !== undefined) {
    warn(`${driver.label}: ${res.note}`);
    return;
  }
  const what = res.target.split('/').pop() ?? res.target;
  if (res.reused) ok(`reusing ${driver.label}'s window for ${clone.name} — ${tildify(res.target)}`);
  else ok(`opened ${what} in ${driver.label}`);
};

const SOURCE_LABEL = {
  config: 'from hangar.config.yaml',
  env: 'detected from the environment',
  probe: 'the one that is running',
} as const;

/**
 * Put the clone on its branch before its window opens -- and never let that stop the open.
 *
 * Ordering first: the windows (one of which runs `claude`) and the editor must come up with the
 * branch already checked out, or the session reads one tree and the developer sees another.
 *
 * Severity second, and this is the difference from `hangar checkout-default`. There, a tree it
 * will not touch is the answer to the command; here it is one clone's branch not moving, and
 * refusing to open a window over it would be a worse trade -- the developer asked for their
 * window.
 */
const land = (clone: Clone, opts: OpenOptions, sweeping: boolean): void => {
  try {
    landOnBranch(clone.hangar, clone, opts, sweeping);
  } catch (error) {
    // EVERY error, not just CliError. This runs inside the clone loop, before the session is
    // created, so anything that escapes here costs the whole run its windows -- and `open`'s
    // standing contract is that one clone's failure never does that.
    warn(`${clone.name}: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof CliError && error.hint !== undefined) note(error.hint);
    note(`opening it on ${currentBranch(clone.path)} instead — the session is unaffected.`);
  }
};

const factsFor = (
  hangar: Hangar,
  clone: Clone,
  opts: OpenOptions,
  server: TmuxServer,
  capabilities: EmulatorCapabilities,
  drivers: readonly EditorDriver[],
): OpenFacts => {
  const sessionExists = server.hasSession(clone);
  return {
    clone,
    roles: tabsFor(hangar, clone, opts, drivers),
    sessionExists,
    existingRoles: sessionExists ? server.roles(clone) : [],
    clientTtys: sessionExists ? server.clientTtys(clone) : [],
    currentSession: server.currentSession(),
    placement: opts.placement ?? hangar.config.terminal.placement,
    emulator: capabilities,
  };
};

export const open = (hangar: Hangar, refs: readonly string[], opts: OpenOptions): void => {
  const clones = resolveClones(hangar, refs, opts);
  const { driver, source } = terminal(hangar);
  const server = tmuxServer(hangar);
  const editorChoice = editors(hangar);
  const drivers = opts.editor === false ? [] : editorChoice.drivers;
  for (const bad of editorChoice.broken) {
    warn(`the ${bad.kind} editor driver would not build: ${bad.reason}`);
    note('it is skipped; the other configured editors still open.');
  }
  if (drivers.length > 0 && editorChoice.fellBack) {
    warn(
      `hangar.config.yaml would not parse — opening ${drivers.map((d) => d.label).join(', ')} by default`,
    );
    note(
      '`hangar config validate` says what is wrong; the editors you configured are not being used.',
    );
  }

  if (!server.installed()) {
    throw new CliError(
      'tmux is not on PATH, and every window `hangar open` creates is a tmux window',
      'Install it (`brew install tmux`, or your package manager) and run this again.',
    );
  }
  /*
   * The conf is checked HERE rather than written here, and rather than left to tmux.
   *
   * `tmux -f <missing file>` exits 0, prints nothing, and starts the server unconfigured -- so
   * nothing downstream could notice, and the developer would find Shift+Enter submitting in
   * Claude Code with no clue why. Written by `colours sync`, like every other generated artifact,
   * so `colours sync --check` stays the one answer to "is what is on disk what the builder says".
   */
  if (!server.running() && !existsSync(hangar.paths.tmuxConf)) {
    throw new CliError(
      `no ${tildify(hangar.paths.tmuxConf)}, so the tmux server would start unconfigured`,
      'Run `hangar colours sync` to generate it. tmux ignores a missing -f file silently, which ' +
        'is why this is checked here rather than reported by tmux.',
    );
  }
  if (driver.kind !== 'none' && !driver.isAvailable()) {
    throw new CliError(`${driver.label} is not available`, driver.unavailableHint());
  }

  note(`terminal: ${driver.label} (${SOURCE_LABEL[source]})`);
  if (driver.kind === 'none') {
    note('no emulator is driven — each clone’s session is built and the attach line is printed.');
  }

  for (const clone of clones) {
    if (opts.checkout !== false) land(clone, opts, clones.length > 1);
    const facts = factsFor(hangar, clone, opts, server, driver.capabilities, drivers);
    for (const action of openPlan(hangar, facts)) {
      if (opts.dryRun === true) {
        step(describeAction(action, false));
        if (action.kind === 'attach-hint' || action.kind === 'cannot-raise') note(action.hint);
        continue;
      }
      if (perform(server, clone, driver, action)) {
        ok(describeAction(action, true));
        if (action.kind === 'attach-hint' || action.kind === 'cannot-raise') note(action.hint);
        const said = driver.lastNote();
        if (action.kind === 'open-emulator' && said !== undefined) note(said);
      } else {
        warn(`${clone.name}: ${describeAction(action, false).replace(/^would /, 'could not ')}`);
        const said = driver.lastNote();
        if (said !== undefined) note(said);
      }
    }
    if (opts.editor !== false) openEditors(clone, drivers, opts.dryRun === true);
    note(`ports: ${portSummary(clone.ports)}`);
  }

  if (opts.dryRun === true) {
    console.log('');
    note('(dry run — no branch was moved, no session and no editor was opened)');
  }
};
