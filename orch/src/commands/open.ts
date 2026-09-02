import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { workspacePath } from '../clone-config.ts';
import { CliError, run } from '../exec.ts';
import {
  CLONE_DIR_RE,
  discoverClones,
  knownClonesHint,
  requireClone,
  type Clone,
} from '../fleet.ts';
import {
  fleetWindow,
  itermIsRunning,
  itermWindows,
  openFleetTabs,
  pickFleetWindow,
  selectFleetTab,
  type FleetTabSpec,
  type FleetWindow,
} from '../iterm.ts';
import { tildify } from '../paths.ts';
import { confirm, note, ok, warn } from '../ui.ts';
import { openWorkspaceFile } from '../vscode.ts';

/**
 * `orch-util open <clone>…` -- the clones' whole working set in one command.
 *
 * Three iTerm2 tabs per clone (Claude in the clone root, a shell in the clone root, a shell in
 * `angular/`) plus its VS Code workspace.
 *
 * ## One window, and what "sorted" can mean
 *
 * The tabs all go into ONE window -- the fleet window -- which the command finds by the user
 * variables it stamps on every session it creates (see `openFleetTabs`). Only if no such window
 * is open does it create one. A clone that already has tabs there is not opened twice; its
 * Claude tab is selected instead.
 *
 * VS Code is deduplicated the same way -- a clone whose workspace is already open gets that
 * window focused rather than a second one; see `openWorkspace`.
 *
 * Tab ORDER, though, is creation order and nothing else: iTerm2's AppleScript interface cannot
 * move a tab, and appending is the only insertion it offers (the evidence is in
 * `openFleetTabs`). So this command sorts the clones it was handed before opening any of them,
 * which keeps the window in clone order for every flow that builds it in one go or extends it
 * upwards -- and when the result is nevertheless out of order (opening 1 after 3), it says so
 * rather than pretending to have sorted anything.
 */
export type OpenOptions = {
  code?: boolean | undefined;
  claude?: boolean | undefined;
  all?: boolean | undefined;
};

const tabsFor = (clone: Clone, opts: OpenOptions): FleetTabSpec[] => [
  {
    cwd: clone.path,
    command: opts.claude === false ? undefined : 'claude',
    clone: clone.name,
    role: 'claude',
  },
  { cwd: clone.path, clone: clone.name, role: 'shell' },
  { cwd: join(clone.path, 'angular'), clone: clone.name, role: 'angular' },
];

/** Ascending by index, each clone once -- the order the tabs will end up in. */
const resolveClones = (refs: readonly string[], opts: OpenOptions): Clone[] => {
  if (opts.all === true) return discoverClones();
  if (refs.length === 0) throw new CliError('open needs a clone name, or --all', knownClonesHint());
  const byIndex = new Map<number, Clone>();
  for (const ref of refs) {
    const clone = requireClone(ref);
    byIndex.set(clone.index, clone);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

/** A shell standing in the clone, or anywhere below it -- `clone_01` and `clone_01/angular`. */
const isInside = (path: string | undefined, root: string): boolean =>
  path !== undefined && (path === root || path.startsWith(`${root}/`));

/**
 * A window this CLI did not open whose shells are already sitting in the clone.
 *
 * Worth a stop, because the tabs a previous version of this command opened carry no tags: to
 * this command they are invisible, so opening the clone again would start a SECOND Claude Code
 * session in a clone that already has one running -- the fleet's own worst failure mode,
 * delivered by the tool meant to stop window sprawl. The working directory is a weak signal
 * (it moves with every `cd`), which is exactly why it only ever gates this question and never
 * decides which clone a tab belongs to.
 */
const foreignWindowFor = (
  clone: Clone,
  windows: readonly FleetWindow[],
  fleet: FleetWindow | undefined,
): FleetWindow | undefined =>
  windows.find(
    (win) =>
      win.id !== fleet?.id &&
      win.tabs.some((tab) => tab.clone === undefined && isInside(tab.path, clone.path)),
  );

const openTabs = (clone: Clone, opts: OpenOptions): void => {
  // One read, three questions: which window is the fleet's, is this clone already in it, and
  // is some other window already sitting in the clone.
  const windows = itermWindows();
  const fleet = pickFleetWindow(windows);

  if (fleet?.tabs.some((tab) => tab.clone === clone.name) === true) {
    if (selectFleetTab(fleet.id, clone.name)) {
      ok(`${clone.name} already has tabs in the fleet window — selected them instead`);
    } else {
      warn(`${clone.name} has tabs in the fleet window but iTerm2 would not select them`);
    }
    return;
  }

  if (foreignWindowFor(clone, windows, fleet) !== undefined) {
    warn(`${clone.name} already has tabs in an iTerm2 window this CLI did not open`);
    note('Opened by hand, or before the one-window change — it may hold a live Claude session.');
    if (!confirm(`Open a second set of tabs for ${clone.name} anyway?`)) {
      note(`left ${clone.name}'s tabs alone — close that window, then open ${clone.index} again`);
      return;
    }
  }

  const res = openFleetTabs(tabsFor(clone, opts), fleet);
  if (res === undefined) {
    warn(`iTerm2 refused the AppleScript — no tabs opened for ${clone.name}`);
    return;
  }
  if (res.createdWindow) ok(`opened the fleet window with three tabs for ${clone.name}`);
  else ok(`added three tabs for ${clone.name} to the fleet window`);
};

/**
 * Hand the clone's workspace to VS Code, reusing the window that already has it open.
 *
 * The path matters twice over. The workspace file lives at the CLONE ROOT, so
 * `code *.code-workspace` from `angular/` would match nothing -- hence the full path. And the
 * clone carries that file twice, at the root and in `angular/`; VS Code treats the two copies
 * as two different workspaces, so `openWorkspaceFile` asks it which copy it is already showing
 * and that exact path is what gets passed, which is what makes VS Code focus the existing
 * window instead of opening a second one on identical content.
 */
const openWorkspace = (clone: Clone): void => {
  const alreadyOpen = openWorkspaceFile(clone);
  const workspace = alreadyOpen ?? workspacePath(clone);
  if (!existsSync(workspace)) {
    warn(`no workspace file at ${workspace} — run \`orch-util doctor --fix\` to create it`);
    return;
  }
  const res = run('code', [workspace]);
  if (!res.ok) {
    warn(`could not launch VS Code: ${res.stderr.trim() || 'is the `code` command installed?'}`);
    return;
  }
  if (alreadyOpen === undefined) ok(`opened ${workspace.split('/').pop() ?? workspace} in VS Code`);
  else ok(`reusing VS Code's window for ${clone.name} — ${tildify(alreadyOpen)}`);
};

/**
 * Say it plainly when the window did not end up in clone order.
 *
 * Consecutive tabs of one clone collapse to a single entry first, so this reports the ORDER OF
 * THE GROUPS -- which is the thing the developer scans the tab bar for -- and flags a clone
 * whose tabs are split into two groups just the same, since that is equally unsorted.
 */
const reportTabOrder = (): void => {
  const window = fleetWindow();
  if (window === undefined) return;
  const groups: string[] = [];
  for (const tab of window.tabs) {
    if (tab.clone === undefined) continue;
    if (groups.at(-1) !== tab.clone) groups.push(tab.clone);
  }
  // By INDEX, not by name: `clone_100` sorts before `clone_99` as a string, and the fleet
  // supports three-digit clones.
  const indices = groups
    .map((name) => Number.parseInt(CLONE_DIR_RE.exec(name)?.[1] ?? '', 10))
    .filter((index) => Number.isFinite(index));
  const sorted = indices.every((index, i) => i === 0 || (indices[i - 1] ?? -1) < index);
  if (sorted) return;
  warn(`the fleet window's tabs are not in clone order: ${groups.join(', ')}`);
  note('iTerm2 exposes no scriptable way to move a tab, so tabs can only be appended.');
  note('Drag them into place, or close the window and run `orch-util open --all`.');
};

export const open = (refs: readonly string[], opts: OpenOptions): void => {
  const clones = resolveClones(refs, opts);

  if (!itermIsRunning()) {
    throw new CliError(
      'iTerm2 is not running',
      'Start iTerm2 first — this command drives it over AppleScript.',
    );
  }

  for (const clone of clones) {
    openTabs(clone, opts);
    if (opts.code !== false) openWorkspace(clone);
    note(
      `ports: ng ${clone.ports.ng} · storybook ${clone.ports.storybook} · playwright ${clone.ports.playwrightReport}`,
    );
  }

  reportTabOrder();
};
