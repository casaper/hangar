import { run } from '../exec.ts';
import {
  cdLine,
  type OpenResult,
  type TerminalDriver,
  type TerminalTabSpec,
  type TerminalWindow,
} from './types.ts';

/**
 * GNOME Terminal -- tabs, and nothing else.
 *
 * This is the driver that justifies the capability model. GNOME Terminal is a thin client for
 * `gnome-terminal-server`, and its D-Bus interface (`org.gnome.Terminal.Factory0`) exposes one
 * method, `CreateInstance`. There is no way to enumerate windows or tabs, no per-tab label this
 * code could read back, and no way to send input to a tab that already exists:
 *
 * - **No inspection.** So `open` cannot tell whether a clone is already open. It says so and
 *   appends, and the developer may end up with two sets of tabs for one clone.
 * - **No typing into a live tab.** So `hangar sync` cannot deliver `SYNC PAUSE` to a Claude Code
 *   session running here. That is not an omission this code can fix: VTE has no such API, and
 *   the generic POSIX route -- the `TIOCSTI` ioctl -- has been disabled by default since Linux
 *   6.2 (`dev.tty.legacy_tiocsti=0`), precisely because injecting keystrokes into another
 *   process's terminal is a privilege-escalation primitive. `sync` degrades to asking before it
 *   touches a clone with a live session, which is the existing behaviour when a session cannot
 *   be reached.
 *
 * What it CAN do it does well: one command line can carry several `--window`/`--tab` flags, and
 * each `--tab` joins the most recent `--window` on that same line, so a clone's whole working
 * set arrives in one window in one call.
 *
 * ## Not verified on hardware
 *
 * Written from the documented command line. macOS is the platform Hangar runs on today; this has
 * not been exercised against a live gnome-terminal. `hangar doctor` prints the detected driver.
 */

/**
 * `--` ends the flags and takes a command with no shell around it, so an interactive shell has
 * to be asked for explicitly -- otherwise the tab closes the moment `claude` exits.
 */
const tabArgs = (tab: TerminalTabSpec, first: boolean): string[] => [
  first ? '--window' : '--tab',
  `--working-directory=${tab.cwd}`,
  '--',
  'sh',
  '-c',
  `${cdLine(tab)}; exec "\${SHELL:-/bin/sh}" -i`,
];

const openTabs = (
  tabs: readonly TerminalTabSpec[],
  existing: TerminalWindow | undefined,
): OpenResult | undefined => {
  if (tabs.length === 0) return undefined;
  // `existing` can only be the synthetic window `open` carries within one run -- see its
  // `assumedWindow`. There is no way to address a window that was open before this run.
  const args = tabs.flatMap((tab, i) => tabArgs(tab, existing === undefined && i === 0));
  const res = run('gnome-terminal', args);
  if (!res.ok) return undefined;
  return { windowId: 0, createdWindow: existing === undefined };
};

export const gnomeTerminalDriver = (): TerminalDriver => ({
  kind: 'gnome-terminal',
  label: 'GNOME Terminal',
  capabilities: {
    openTabs: true,
    inspect: false,
    tag: false,
    writeToTty: false,
    select: false,
    // VTE honours the background-colour escape sequence, so the shell hook paints it.
    paintOnCreate: false,
  },
  // Not "is it running": gnome-terminal is D-Bus-activated and starts on demand, so being
  // installed is the whole of the question.
  isAvailable: () => run('sh', ['-c', 'command -v gnome-terminal >/dev/null 2>&1']).ok,
  unavailableHint: () =>
    'gnome-terminal is not on PATH — install it, or set `terminal.kind` in hangar.config.yaml.',
  windows: () => [],
  openTabs,
  select: () => false,
  writeToTty: () => false,
});
