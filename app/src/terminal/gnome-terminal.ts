import { run } from '../exec.ts';
import type { EmulatorDriver, WindowSpec } from './types.ts';

/**
 * GNOME Terminal -- a tab or a window, and nothing else.
 *
 * One command line does the opening: `--tab` joins the most recently used window and `--window`
 * makes a new one, with the command after `--`. That is the whole of what VTE exposes to another
 * process. There is no way to enumerate its tabs, no way to ask one for its tty, and therefore no
 * way to bring an already-open clone forward -- `raiseByTty` is permanently false here, and it is
 * not an omission anyone can close.
 *
 * What that costs is one line of output: the clone's window is open and simply not in front, and
 * `open` prints the `tmux -L hangar-<id> attach` line that finishes the job. Everything else --
 * the roles, their names, their order, and a `SYNC PAUSE` delivered into a live session -- is
 * tmux, so a GNOME Terminal hangar is not short of anything that matters. That was not true of a
 * design where the emulator had to be typed into: VTE has no API for writing into a running
 * terminal, and the generic POSIX route (the `TIOCSTI` ioctl) has been disabled by default since
 * Linux 6.2.
 *
 * ## Not verified against a live gnome-terminal
 *
 * Written from its documented command line. macOS is the platform this fleet runs on, so what is
 * unexercised is which window comes up; what happens inside it is tmux.
 */
export const gnomeTerminalDriver = (): EmulatorDriver => ({
  kind: 'gnome-terminal',
  label: 'GNOME Terminal',
  capabilities: { openTab: true, openWindow: true, raiseByTty: false },
  // D-Bus-activated, so it starts on demand: this only asks whether it is installed.
  isAvailable: () => run('sh', ['-c', 'command -v gnome-terminal >/dev/null 2>&1']).ok,
  unavailableHint: () => 'gnome-terminal is not on PATH — install it, or set `terminal.kind`.',
  open: (spec: WindowSpec): boolean =>
    run('gnome-terminal', [
      spec.placement === 'tab' ? '--tab' : '--window',
      ...(spec.title === undefined ? [] : [`--title=${spec.title}`]),
      '--',
      // `||`, so the shell is reached only when tmux refused to start: a window that vanishes
      // instantly explains nothing.
      'sh',
      '-c',
      `${spec.command} || exec $SHELL`,
    ]).ok,
  lastNote: () => 'GNOME Terminal cannot bring a window forward; `tmux attach` is how you return',
  raiseByTty: () => false,
});
