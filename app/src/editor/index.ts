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

/**
 * The editors this hangar is configured for, in config order.
 *
 * A LIST, unlike the terminal seam's single driver, and for a reason that is about the objects
 * rather than the code: two terminals cannot both hold the same tab, but two editors can both
 * have the same clone open, because their project files are different files. So `open` opens
 * every configured editor and `<kind> sync` addresses one of them by name.
 *
 * Never throws. A config that will not parse falls back to the schema's default -- VS Code --
 * rather than refusing to open an editor over a YAML typo; `doctor` is what reports the config.
 */
export type EditorSelection = {
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
};

export const editors = (): EditorSelection => {
  const { editor, fellBack } = editorConfig();
  return { drivers: editor.kinds.map((kind) => driverFor(kind, editor)), fellBack };
};

/** One named editor, for the `<kind> sync` commands. Undefined when it is not configured. */
export const editorFor = (kind: EditorKind): EditorDriver | undefined =>
  editors().drivers.find((driver) => driver.kind === kind);

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
