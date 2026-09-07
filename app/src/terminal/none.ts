import type { EmulatorDriver } from './types.ts';

/**
 * No emulator at all -- `terminal.kind: none`, or a terminal Hangar does not recognise.
 *
 * Every capability false, so `open` builds the clone's tmux session and prints the `tmux attach`
 * line instead of guessing at a window. That is a real mode rather than a failure: a hangar
 * driven from a terminal nobody wrote a driver for still gets its sessions, its per-clone hues
 * and its `SYNC PAUSE`, because all three are tmux's. What it does not get is a window opening by
 * itself.
 */
export const noneDriver = (envSaid: string | undefined): EmulatorDriver => ({
  kind: 'none',
  label: envSaid === undefined ? 'no terminal automation' : `unrecognised terminal (${envSaid})`,
  capabilities: { openTab: false, openWindow: false, raiseByTty: false },
  isAvailable: () => false,
  unavailableHint: () =>
    'Set `terminal.kind` in hangar.config.yaml to the emulator you use, or leave it `none` and ' +
    'attach to the session `hangar open` prints.',
  open: () => false,
  lastNote: () => undefined,
  raiseByTty: () => false,
});
