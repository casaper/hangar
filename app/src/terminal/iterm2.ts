import { appIsRunning, asString, osascript } from './applescript.ts';
import { devPath, type EmulatorDriver, type WindowSpec } from './types.ts';

/**
 * iTerm2 -- a tab or a window, and a raise.
 *
 * The command is given at CREATION rather than typed in afterwards, and both halves of that are
 * measured rather than chosen. On iTerm2 3.6.11:
 *
 * - **`write text` into a session that was just created does not run.** Verified six times across
 *   both placements and both spellings (a `tell … to write text` one-liner and a `tell … end tell`
 *   block), with and without a `delay`, and with the session addressed both through the created
 *   tab and through `current session of current window`. The text is accepted and dropped -- the
 *   shell has not started reading yet, and nothing reports it. `command` at creation has no such
 *   window: the process IS the session.
 * - **A bare `create tab with default profile` returns `missing value`**, so anything reached
 *   through the returned tab fails with `Can't get current session of missing value (-1728)` --
 *   while the tab itself appears, which is what makes it look like the write was the problem.
 *   `tell current window to create tab …` returns a real tab and runs its command.
 *
 * So: `tell current window to create tab with default profile command …` for a tab, and
 * `create window with default profile command …` for a window. No `write text` anywhere.
 *
 * **`command` is argv, not a shell line.** It starts the process directly, so a builtin like
 * `exec` starts nothing, and PATH is the application's rather than a login shell's -- which is
 * why `attachCommand` names tmux by absolute path. Single quotes ARE honoured by iTerm2's own
 * tokenizer, verified with a quoted `sh -c '…'`, so a path with a space still survives.
 *
 * The raise reads `tty of s`; both it and the opening are exercised on this machine.
 */

const openScript = (spec: WindowSpec): string => {
  const command = asString(spec.command);
  if (spec.placement === 'window') {
    return [
      'tell application "iTerm2"',
      '  activate',
      `  create window with default profile command ${command}`,
      '  return "opened"',
      'end tell',
    ].join('\n');
  }
  return [
    'tell application "iTerm2"',
    '  activate',
    // No window to put a tab in -- which is also the case on a machine where iTerm2 was only just
    // launched, so this is what keeps `tab` a safe default rather than a first-run failure.
    '  if (count of windows) is 0 then',
    `    create window with default profile command ${command}`,
    '  else',
    `    tell current window to create tab with default profile command ${command}`,
    '  end if',
    '  return "opened"',
    'end tell',
  ].join('\n');
};

const raiseByTty = (tty: string): boolean => {
  const target = devPath(tty);
  const script = [
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if tty of s is ${asString(target)} then`,
    '          activate',
    '          tell w to select',
    '          tell t to select',
    '          return "raised"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "not-found"',
  ].join('\n');
  return osascript(script).out === 'raised';
};

export const iterm2Driver = (): EmulatorDriver => ({
  kind: 'iterm2',
  label: 'iTerm2',
  capabilities: { openTab: true, openWindow: true, raiseByTty: true },
  isAvailable: () => appIsRunning('iTerm2'),
  unavailableHint: () => 'Start iTerm2 first — this command drives it over AppleScript.',
  open: (spec) => osascript(openScript(spec)).out === 'opened',
  lastNote: () => undefined,
  raiseByTty,
});
