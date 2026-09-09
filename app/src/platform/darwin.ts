import { join } from 'node:path';

import {
  accessibilityHint,
  asString,
  isAccessibilityDenial,
  osascript,
} from '../terminal/applescript.ts';
import { run } from '../exec.ts';
import { home } from '../user-paths.ts';
import type { AppWindowOutcome, PlatformDriver } from './types.ts';

/**
 * macOS. The one platform this fleet actually runs on, and so the one whose paths are verified.
 *
 * Homebrew is a hard requirement here and only here -- `hangar_use_gnu` in `.envrc.hangar`
 * prepends the GNU userland off Homebrew and no-ops on every other platform -- which is why
 * every hint is a formula name.
 */
export const darwinPlatform = (): PlatformDriver => {
  const machineConfigDir = join(home, 'Library', 'Application Support');
  return {
    id: 'darwin',
    label: 'macOS',
    capabilities: {
      openExternally: true,
      openApplicationByName: true,
      vscodeWindowState: true,
      controlAppWindows: true,
    },
    machineConfigDir,
    vscodeWindowState: (stateDir) =>
      join(machineConfigDir, stateDir, 'User', 'globalStorage', 'storage.json'),
    openExternally: (target, app) =>
      run('open', app === undefined ? [target] : ['-a', app, target]).ok,
    /*
     * LaunchServices' own lookup, which is the same resolution `open -a` performs -- so this
     * answers for an app wherever it was installed, `~/Applications` (where JetBrains Toolbox
     * puts them) included. Exits 0 with the bundle id, or 1 with `-1728` when nothing matches.
     */
    applicationExists: (app) => run('osascript', ['-e', `id of app "${app}"`]).ok,
    closeAppWindow: (app, titleContains) => closeWindowByTitle(app, titleContains),
    installHint: (pkg) => `brew install ${pkg}`,
  };
};

/**
 * Close every window of `app` whose title contains `titleContains`, through System Events.
 *
 * **Pressing the window's own close button, and never a keystroke.** Both routes exist -- VS
 * Code binds `workbench.action.closeWindow` to Cmd+Shift+W with no `when` clause, read out of
 * the shipped bundle -- and a keystroke has to be delivered to whatever is focused, which means
 * raising the window first and getting it wrong if the focus moves in between. `AXPress` on the
 * button names the window it acts on.
 *
 * `AXCloseButton` by subrole first, with `button 1` as the fallback: the subrole is the exact
 * answer, and an application that does not expose it still puts the close button first. VS Code
 * draws its own title bar on macOS and the traffic lights inside it are real window buttons, so
 * both routes are expected to find them.
 *
 * **This is written from the interfaces and is not exercised here**, the same standing the
 * Konsole and GNOME Terminal window-openers have -- and for a sharper reason: Accessibility is
 * not granted to this machine's terminal, so every run of it on this fleet so far has returned
 * `denied`. That outcome is the one this function is most careful about, because it is the one
 * with a fix the developer can apply.
 */
const closeWindowByTitle = (app: string, titleContains: string): AppWindowOutcome => {
  const script = [
    'tell application "System Events"',
    `  if not (exists process ${asString(app)}) then return "not-running"`,
    `  tell process ${asString(app)}`,
    `    set hits to (every window whose name contains ${asString(titleContains)})`,
    '    if (count of hits) is 0 then return "no-window"',
    '    repeat with w in hits',
    '      try',
    '        set b to (first button of w whose subrole is "AXCloseButton")',
    '      on error',
    '        set b to button 1 of w',
    '      end try',
    '      perform action "AXPress" of b',
    '    end repeat',
    '  end tell',
    'end tell',
    'return "closed"',
  ].join('\n');
  const res = osascript(script);
  if (!res.ok) {
    if (isAccessibilityDenial(res.err)) return { kind: 'denied', hint: accessibilityHint() };
    return { kind: 'failed', why: res.err };
  }
  if (res.out === 'not-running') return { kind: 'not-running' };
  if (res.out === 'no-window') return { kind: 'no-window' };
  return { kind: 'closed' };
};
