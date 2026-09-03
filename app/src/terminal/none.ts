import type { TerminalDriver } from './types.ts';

/**
 * No terminal automation at all.
 *
 * Reached two ways: `terminal.kind: none` in the config, for a hangar whose developer does not
 * want windows opened for them, and detection finding nothing it recognises -- a tmux-only
 * setup, a plain xterm, an SSH session, CI.
 *
 * It is a real driver rather than an `undefined` special case so that every caller keeps one
 * code path and asks the same capability questions. What it must never do is pretend: `open`
 * refuses with a message naming the config key, and `sync` reports that no Claude session can be
 * paused, which is what makes it ask before touching a clone that has one.
 */
export const noneDriver = (detected: string | undefined): TerminalDriver => ({
  kind: 'none',
  label: detected === undefined ? 'no supported terminal' : `unsupported terminal (${detected})`,
  capabilities: {
    openTabs: false,
    inspect: false,
    tag: false,
    writeToTty: false,
    select: false,
    paintOnCreate: false,
  },
  isAvailable: () => false,
  unavailableHint: () =>
    'Set `terminal.kind` in hangar.config.yaml to iterm2, apple-terminal, konsole or gnome-terminal.',
  windows: () => [],
  openTabs: () => undefined,
  select: () => false,
  writeToTty: () => false,
});
