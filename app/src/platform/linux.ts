import { join } from 'node:path';

import { run } from '../exec.ts';
import { home } from '../user-paths.ts';
import type { PlatformDriver } from './types.ts';

/**
 * Linux. **Written from the specifications, not exercised** -- the same standing this CLI's
 * Konsole and GNOME Terminal window-openers have, and for the same reason: nothing here runs Linux.
 * Each claim below names where it comes from so a first run on Linux can check it rather than
 * trust it.
 *
 * - `$XDG_CONFIG_HOME`, defaulting to `~/.config`, is the XDG Base Directory spec, and VS Code
 *   follows it: `~/.config/Code/User/globalStorage/storage.json`. The layout under the state
 *   directory is identical to macOS's, which is why this is the only value that differs.
 * - `xdg-open` is freedesktop's, and takes a path and nothing else. There is **no** way to name
 *   an application by its display name, which is what `openApplicationByName: false` records.
 * - The install hints name three package managers rather than picking one. Guessing wrong is
 *   worse than listing: a hint that says `apt install jq` on Fedora is an instruction that
 *   fails, and this line is printed exactly when someone is already stuck.
 */
export const linuxPlatform = (): PlatformDriver => {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const machineConfigDir = xdg === undefined || xdg === '' ? join(home, '.config') : xdg;
  return {
    id: 'linux',
    label: 'Linux',
    capabilities: { openExternally: true, openApplicationByName: false, vscodeWindowState: true },
    machineConfigDir,
    vscodeWindowState: (stateDir) =>
      join(machineConfigDir, stateDir, 'User', 'globalStorage', 'storage.json'),
    // `app` is ignored rather than approximated: there is no lookup from a display name to a
    // desktop entry, and passing the name as a path would open a file that is not there.
    openExternally: (target, app) => (app === undefined ? run('xdg-open', [target]).ok : false),
    // False for the same reason `openApplicationByName` is: with no lookup from a display name
    // to a desktop entry, there is nothing to ask.
    applicationExists: () => false,
    installHint: (pkg) =>
      `your package manager, e.g. \`apt install ${pkg}\`, \`dnf install ${pkg}\` or \`pacman -S ${pkg}\``,
  };
};
