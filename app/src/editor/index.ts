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
export const editors = (): EditorDriver[] => {
  const editor = editorConfig();
  return editor.kinds.map((kind) => driverFor(kind, editor));
};

/** One named editor, for the `<kind> sync` commands. Undefined when it is not configured. */
export const editorFor = (kind: EditorKind): EditorDriver | undefined =>
  editors().find((driver) => driver.kind === kind);

type EditorConfig = ReturnType<typeof editorSchema.parse>;

const editorConfig = (): EditorConfig => {
  const configPath = join(fleetRoot, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    try {
      return loadConfigFile(configPath).editor;
    } catch {
      // fall through to the schema defaults
    }
  }
  return editorSchema.parse({});
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
