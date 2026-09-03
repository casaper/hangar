import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILENAME, loadConfigFile } from '../config/load.ts';
import { editorSchema } from '../config/schema.ts';
import { fleetRoot } from '../paths.ts';
import { emacsDriver } from './emacs.ts';
import { jetbrainsDriver } from './jetbrains.ts';
import { isVscodeFork, type EditorKind } from './kinds.ts';
import { eclipseDriver, xcodeDriver } from './launch-only.ts';
import type { EditorDriver } from './types.ts';
import { vimDriver } from './vim.ts';
import { vscodeDriver } from './vscode.ts';
import { zedDriver } from './zed.ts';

export * from './kinds.ts';
export * from './types.ts';
export { isTracked } from './vscode.ts';

/** A configured kind whose driver threw while being built. */
export type BrokenEditor = {
  readonly kind: EditorKind;
  readonly reason: string;
};

export type EditorSelection = {
  /** The drivers that BUILT, in config order. A kind that threw is in `broken` instead. */
  readonly drivers: readonly EditorDriver[];
  /**
   * True when the config exists but would not parse, so these drivers come from the SCHEMA
   * DEFAULT rather than from anything the developer wrote.
   *
   * Worth carrying rather than swallowing, and this is where it differs from the terminal seam.
   * There the fallback is inert -- a `none` driver does nothing. Here the default is
   * `kinds: ['vscode']`, so a hangar that configured `kinds: ['zed']` and then broke an
   * unrelated line of its YAML would get VS Code opened at it and no hint as to why. Falling
   * back is still right (refusing to open an editor over a typo elsewhere is worse), but it has
   * to be said out loud, which `open` does.
   */
  readonly fellBack: boolean;
  /**
   * Configured kinds whose driver would not even build. Reported, never fatal -- see the loop.
   *
   * Normally empty, and it is meant to stay that way: a driver constructor only probes the
   * machine, and `run` does not throw. It exists so that if one ever does, the failure is a line
   * about that editor instead of a stack trace where the default editor should have opened.
   */
  readonly broken: readonly BrokenEditor[];
};

/**
 * The editors this hangar is configured for, in config order.
 *
 * A LIST, unlike the terminal seam's single driver, and for a reason that is about the objects
 * rather than the code: two terminals cannot both hold the same tab, but two editors can both
 * have the same clone open, because their project files are different files. So `open` opens
 * every configured editor and `<kind> sync` addresses one of them by name.
 *
 * Never throws. A config that will not parse falls back to the schema's default (VS Code, via
 * `DEFAULT_EDITOR_KIND`) rather than refusing to open an editor over a YAML typo, and a single
 * kind whose driver will not build is collected into `broken` rather than ending the run --
 * because only the default editor has to work, and it must not be a bystander to another one's
 * failure. `doctor` is what reports both.
 */
export const editors = (): EditorSelection => {
  const { editor, fellBack } = editorConfig();
  const drivers: EditorDriver[] = [];
  const broken: BrokenEditor[] = [];
  for (const kind of editor.kinds) {
    try {
      drivers.push(driverFor(kind, editor));
    } catch (err) {
      // Isolated per kind, and this is the whole point of the list being built in a loop rather
      // than a `.map`. Only VS Code has to work; every other kind is best effort, and several
      // build their driver by probing the machine (vim looks for four binaries, JetBrains
      // resolves a launcher). A throw in one of those must cost that editor and nothing else --
      // a `.map` would take the default editor down with it, which is exactly backwards.
      broken.push({ kind, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { drivers, fellBack, broken };
};

/**
 * One named editor, for the `<kind> sync` commands. No `driver` when it is not configured.
 *
 * Builds ONLY the kind asked for, deliberately -- it used to go through `editors()` and pick from
 * the result, which made `hangar vscode sync` construct every other configured driver first and
 * so depend on all of them. And no catch here, unlike `editors()`: the developer named this
 * editor, so a driver that cannot be built is the answer to their command rather than a bystander
 * to be stepped over.
 *
 * `fellBack` comes back even when the kind was not found, and that is the case it exists for:
 * on a config too broken to parse, `kinds` is the default `['vscode']`, so `hangar zed sync`
 * would otherwise be told to add zed to `editor.kinds` -- which it is already in, in a file
 * nothing here managed to read.
 */
export const editorFor = (kind: EditorKind): { driver?: EditorDriver; fellBack: boolean } => {
  const { editor, fellBack } = editorConfig();
  if (!editor.kinds.includes(kind)) return { fellBack };
  return { driver: driverFor(kind, editor), fellBack };
};

type EditorConfig = ReturnType<typeof editorSchema.parse>;

const editorConfig = (): { editor: EditorConfig; fellBack: boolean } => {
  const configPath = join(fleetRoot, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    try {
      return { editor: loadConfigFile(configPath).editor, fellBack: false };
    } catch {
      // A config too broken to parse must not stop `open` from working -- but the caller is
      // told, because the default it gets instead is not inert.
      return { editor: editorSchema.parse({}), fellBack: true };
    }
  }
  // No config at all is not a fallback, it is an unconfigured hangar: the default IS the answer.
  return { editor: editorSchema.parse({}), fellBack: false };
};

const driverFor = (kind: EditorKind, editor: EditorConfig): EditorDriver => {
  // The whole VS Code family shares one driver, differing only in launcher and state directory.
  if (isVscodeFork(kind)) return vscodeDriver(kind);
  switch (kind) {
    case 'jetbrains':
      return jetbrainsDriver(editor.jetbrains.product, editor.jetbrains.launcher);
    case 'zed':
      return zedDriver();
    case 'emacs':
      return emacsDriver();
    case 'vim':
      return vimDriver(editor.vim.command);
    case 'xcode':
      return xcodeDriver();
    case 'eclipse':
      return eclipseDriver(editor.eclipse.launcher);
  }
};
