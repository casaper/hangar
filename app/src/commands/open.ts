import { join } from 'node:path';

import { landOnBranch } from './checkout-default.ts';
import { editors, type EditorDriver } from '../editor/index.ts';
import { CliError } from '../exec.ts';
import { cloneDirRe, discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { currentBranch } from '../git.ts';
import { tintedHex } from '../palette.ts';
import { tildify } from '../user-paths.ts';
import {
  pickFleetWindow,
  terminal,
  type TerminalDriver,
  type TerminalTabSpec,
  type TerminalWindow,
} from '../terminal/index.ts';
import { confirm, note, ok, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';
import { portSummary } from '../ports.ts';

/**
 * `hangar open <clone>…` -- the clones' whole working set in one command.
 *
 * Three terminal tabs per clone (Claude in the clone root, a shell in the clone root, a shell in
 * `angular/`) plus its VS Code workspace.
 *
 * ## One window, and what "sorted" can mean
 *
 * The tabs all go into ONE window -- the fleet window -- which the command finds by the tags it
 * stamps on every tab it creates. Only if no such window is open does it create one. A clone that
 * already has tabs there is not opened twice; its Claude tab is selected instead.
 *
 * VS Code is deduplicated the same way -- a clone whose workspace is already open gets that
 * window focused rather than a second one; see `openWorkspace`.
 *
 * Tab ORDER, though, is creation order and nothing else: no terminal here can move a tab, and
 * appending is the only insertion they offer (the evidence for iTerm2 is in its driver). So this
 * command sorts the clones it was handed before opening any of them, which keeps the window in
 * clone order for every flow that builds it in one go or extends it upwards -- and when the
 * result is nevertheless out of order (opening 1 after 3), it says so rather than pretending to
 * have sorted anything.
 *
 * ## What a less capable terminal costs
 *
 * Everything above needs a terminal that can be INSPECTED -- that can list its tabs and hand back
 * the tags. iTerm2, Terminal.app and Konsole (with `qdbus`) can; GNOME Terminal cannot, and
 * neither can a terminal Hangar does not recognise. There the two safety checks are impossible,
 * so this command says so once and then only appends: a clone opened twice gets two sets of tabs,
 * and it is the developer who has to notice. It still keeps one window per RUN -- see
 * `assumedWindow` -- so `open --all` does not scatter four windows across the desktop.
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
   * The branch each clone is put on before its tabs open. Absent means the repo's DEFAULT
   * branch, which is the default because of what `open` is for: a clone you are opening is a
   * clone you are starting work in, and starting on last week's ticket branch -- or on a
   * default branch a week behind origin -- is never what was wanted. `--no-checkout` turns it
   * off, and `--branch <name>` names another one.
   */
  branch?: string | undefined;
  checkout?: boolean | undefined;
  /**
   * Move the branch of a clone that has a live Claude session in it.
   *
   * The flag exists because the landing offers it: without it, a clone with a session is asked
   * about (one clone) or left alone (a sweep), and the warning that says so has to name a real
   * flag. It governs the CHECKOUT only -- the tabs open either way.
   */
  includeBusy?: boolean | undefined;
};

/**
 * The tabs a clone gets. Exported and pure: what lands in a tab is what the developer sees, and
 * this repo's convention is that anything producing text for a human gets a builder that can be
 * printed side by side without opening a terminal to find out.
 */
export const tabsFor = (
  hangar: Hangar,
  clone: Clone,
  opts: OpenOptions,
  driver: TerminalDriver,
  editorDrivers: readonly EditorDriver[],
): TerminalTabSpec[] => {
  // Only handed to drivers that paint at creation, so a tab that will be coloured by the shell
  // hook a moment later does not also get an AppleScript colour it did not ask for.
  //
  // TINTED, not the hue: the surface a `paintOnCreate` driver paints is the terminal BACKGROUND
  // -- the same one the hook's OSC 11 covers elsewhere -- so the full hue would put `#00ccff`
  // behind the text. Same `terminal.colour.tint` factor the hook uses.
  const colour = driver.capabilities.paintOnCreate
    ? tintedHex(clone.colour, hangar.config.terminal.colour.tint)
    : undefined;
  return [
    {
      cwd: clone.path,
      command: opts.claude === false ? undefined : 'claude',
      clone: clone.name,
      role: 'claude',
      colour,
    },
    { cwd: clone.path, clone: clone.name, role: 'shell', colour },
    { cwd: join(clone.path, 'angular'), clone: clone.name, role: 'angular', colour },
    // An editor that lives INSIDE a terminal gets a tab rather than a window: terminal vim has
    // no window to hand a path to. The tab is built here, with the others, so it lands in the
    // fleet window in clone order -- the editor driver could not manage that, since it knows
    // nothing about which window is the fleet's. See `EditorCapabilities.inTerminalTab`.
    ...editorDrivers
      .filter((editor) => editor.capabilities.inTerminalTab === true)
      .map((editor) => ({
        cwd: clone.path,
        command: editor.terminalCommand,
        clone: clone.name,
        role: editor.kind,
        colour,
      })),
  ];
};

/** Ascending by index, each clone once -- the order the tabs will end up in. */
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

/** A shell standing in the clone, or anywhere below it -- `clone_01` and `clone_01/angular`. */
const isInside = (hangar: Hangar, path: string | undefined, root: string): boolean =>
  path !== undefined && (path === root || path.startsWith(`${root}/`));

/**
 * A window this CLI did not open whose shells are already sitting in the clone.
 *
 * Worth a stop, because a tab this command cannot recognise is invisible to it: opening the clone
 * again would start a SECOND Claude Code session in a clone that already has one running -- the
 * fleet's own worst failure mode, delivered by the tool meant to stop window sprawl. The working
 * directory is a weak signal (it moves with every `cd`), which is exactly why it only ever gates
 * this question and never decides which clone a tab belongs to.
 */
const foreignWindowFor = (
  hangar: Hangar,
  clone: Clone,
  windows: readonly TerminalWindow[],
  fleet: TerminalWindow | undefined,
): TerminalWindow | undefined =>
  windows.find(
    (win) =>
      win.id !== fleet?.id &&
      win.tabs.some((tab) => tab.clone === undefined && isInside(hangar, tab.path, clone.path)),
  );

/**
 * The window this run created, for drivers that cannot be inspected.
 *
 * Not a real window -- it carries no tabs and its id may be meaningless (GNOME Terminal has no
 * window ids at all). It exists to answer one question the driver cannot: has THIS run already
 * made a window? A driver that gets it appends (`--tab`) instead of starting another window, so
 * `open --all` still produces one window. It is deliberately not remembered between runs: a
 * window from a previous invocation may since have been closed, and there is no way to check.
 */
const assumedWindow = (hangar: Hangar, id: number): TerminalWindow => ({ id, tabs: [] });

const openTabs = (
  hangar: Hangar,
  driver: TerminalDriver,
  clone: Clone,
  opts: OpenOptions,
  assumed: TerminalWindow | undefined,
  editorDrivers: readonly EditorDriver[],
): TerminalWindow | undefined => {
  if (!driver.capabilities.inspect) {
    const res = driver.openTabs(tabsFor(hangar, clone, opts, driver, editorDrivers), assumed);
    if (res === undefined) {
      warn(`${driver.label} refused to open tabs for ${clone.name}`);
      return assumed;
    }
    if (res.createdWindow) ok(`opened a window with three tabs for ${clone.name}`);
    else ok(`added three tabs for ${clone.name}`);
    return assumedWindow(hangar, res.windowId);
  }

  // One read, three questions: which window is the fleet's, is this clone already in it, and is
  // some other window already sitting in the clone.
  const windows = driver.windows();
  const fleet = pickFleetWindow(windows);

  if (fleet?.tabs.some((tab) => tab.clone === clone.name) === true) {
    if (driver.capabilities.select && driver.select(fleet.id, clone.name)) {
      ok(`${clone.name} already has tabs in the fleet window — selected them instead`);
    } else {
      warn(`${clone.name} has tabs in the fleet window but ${driver.label} would not select them`);
    }
    return undefined;
  }

  if (foreignWindowFor(hangar, clone, windows, fleet) !== undefined) {
    warn(
      `${clone.name} already has tabs in an existing ${driver.label} window this CLI did not open`,
    );
    note('Opened by hand, or before the one-window change — it may hold a live Claude session.');
    if (!confirm(`Open a second set of tabs for ${clone.name} anyway?`)) {
      note(`left ${clone.name}'s tabs alone — close that window, then open ${clone.index} again`);
      return undefined;
    }
  }

  const res = driver.openTabs(tabsFor(hangar, clone, opts, driver, editorDrivers), fleet);
  if (res === undefined) {
    warn(`${driver.label} refused the request — no tabs opened for ${clone.name}`);
    return undefined;
  }
  if (res.createdWindow) ok(`opened the fleet window with three tabs for ${clone.name}`);
  else ok(`added three tabs for ${clone.name} to the fleet window`);
  return undefined;
};

/**
 * Open the clone in every editor this hangar is configured for.
 *
 * Every one, not the first that works: two editors can both have the same clone open, because
 * their project files are different files, and a developer who listed both meant both.
 *
 * How much each driver has to be helped differs, and the drivers own that. VS Code is handed the
 * exact workspace-file copy it already has open, because it counts the clone's two byte-identical
 * twins as two different workspaces and would otherwise open a second window on identical
 * content. JetBrains is handed the clone DIRECTORY and dedupes itself, which is why it reports
 * `reused: false` and there is nothing to say about it either way.
 */
const openEditors = (hangar: Hangar, clone: Clone, drivers: readonly EditorDriver[]): void => {
  for (const driver of drivers) {
    // Already opened as one of the clone's terminal tabs, above -- not a window to launch.
    if (driver.capabilities.inTerminalTab === true) continue;
    try {
      openEditor(clone, driver);
    } catch (err) {
      // One editor's failure is one line, and the loop goes on. Only the default editor has to
      // work; the rest are best effort, and every one of them shells out to a launcher nobody
      // here has run. Letting a throw out would end the whole `open` -- so a clone listing
      // `[zed, vscode]` would lose VS Code to Zed's launcher, which inverts the priority the
      // config states. `undefined` and a `note` are the drivers' own ways of declining and are
      // handled above; this is only for a driver that breaks rather than declines.
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
const openEditor = (clone: Clone, driver: EditorDriver): void => {
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

/**
 * Say it plainly when the window did not end up in clone order.
 *
 * Consecutive tabs of one clone collapse to a single entry first, so this reports the ORDER OF
 * THE GROUPS -- which is the thing the developer scans the tab bar for -- and flags a clone whose
 * tabs are split into two groups just the same, since that is equally unsorted.
 */
const reportTabOrder = (hangar: Hangar, driver: TerminalDriver): void => {
  const window = pickFleetWindow(driver.windows());
  if (window === undefined) return;
  const groups: string[] = [];
  for (const tab of window.tabs) {
    if (tab.clone === undefined) continue;
    if (groups.at(-1) !== tab.clone) groups.push(tab.clone);
  }
  // By INDEX, not by name: `clone_100` sorts before `clone_99` as a string, and the fleet
  // supports three-digit clones.
  const indices = groups
    .map((name) => Number.parseInt(cloneDirRe(hangar).exec(name)?.[1] ?? '', 10))
    .filter((index) => Number.isFinite(index));
  const sorted = indices.every((index, i) => i === 0 || (indices[i - 1] ?? -1) < index);
  if (sorted) return;
  warn(`the fleet window's tabs are not in clone order: ${groups.join(', ')}`);
  note(`${driver.label} exposes no scriptable way to move a tab, so tabs can only be appended.`);
  note('Drag them into place, or close the window and run `hangar open --all`.');
};

const SOURCE_LABEL = {
  config: 'from hangar.config.yaml',
  env: 'detected from the environment',
  probe: 'the one that is running',
} as const;

/**
 * Put the clone on its branch before any tab opens -- and never let that stop the open.
 *
 * Ordering first: the tabs (one of which runs `claude`) and the editor must come up with the
 * branch already checked out, or the session reads one tree and the developer sees another.
 *
 * Severity second, and this is the difference from `hangar checkout-default`. There, a tree it
 * will not touch is the answer to the command; here it is one clone's branch not moving, and
 * refusing to open a window over it would be a worse trade -- the developer asked for their
 * window. So a `CliError` from the landing is a warning and the open continues, exactly as a
 * failed editor launch does.
 */
const land = (clone: Clone, opts: OpenOptions, sweeping: boolean): void => {
  try {
    landOnBranch(clone.hangar, clone, opts, sweeping);
  } catch (error) {
    // EVERY error, not just CliError. This runs inside the clone loop, before the first tab is
    // created, so anything that escapes here costs the whole run its windows -- and `open`'s
    // standing contract is that one clone's failure never does that (see `openEditors`). The
    // fallback line below is the right answer to a refusal, a git that would not run and a
    // network that was not there alike.
    warn(`${clone.name}: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof CliError && error.hint !== undefined) note(error.hint);
    note(`opening it on ${currentBranch(clone.path)} instead — the tabs are unaffected.`);
  }
};

export const open = (hangar: Hangar, refs: readonly string[], opts: OpenOptions): void => {
  const clones = resolveClones(hangar, refs, opts);
  const { driver, source } = terminal(hangar);
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

  if (!driver.capabilities.openTabs) {
    throw new CliError(`no terminal to open tabs in — ${driver.label}`, driver.unavailableHint());
  }
  if (!driver.isAvailable()) {
    throw new CliError(`${driver.label} is not available`, driver.unavailableHint());
  }

  note(`terminal: ${driver.label} (${SOURCE_LABEL[source]})`);
  if (!driver.capabilities.inspect) {
    warn(`${driver.label} cannot list its tabs — Hangar cannot tell what is already open`);
    note('Opening a clone twice gives it two sets of tabs; close the old ones yourself.');
  }

  let assumed: TerminalWindow | undefined;
  for (const clone of clones) {
    if (opts.checkout !== false) land(clone, opts, clones.length > 1);
    assumed = openTabs(hangar, driver, clone, opts, assumed, drivers) ?? assumed;
    if (opts.editor !== false) openEditors(hangar, clone, drivers);
    note(`ports: ${portSummary(clone.ports)}`);
  }

  if (driver.capabilities.inspect) reportTabOrder(hangar, driver);
};
