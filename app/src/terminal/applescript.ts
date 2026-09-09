import { realpathSync } from 'node:fs';

import { run } from '../exec.ts';

/**
 * The macOS AppleScript helpers, shared by every driver that talks to an app that way.
 *
 * Both mac terminal drivers do, and so does `platform/darwin.ts`'s `closeAppWindow` -- so these
 * live here rather than being written three times. It is a leaf: no seam semantics, and nothing
 * imported beyond `run` and `node:fs`.
 */
export type OsaResult = { readonly ok: boolean; readonly out: string; readonly err: string };

export const osascript = (script: string): OsaResult => {
  const res = run('osascript', ['-e', script]);
  return { ok: res.ok, out: res.stdout.trim(), err: res.stderr.trim() };
};

/** AppleScript string literal escaping: backslashes and double quotes only. */
export const asString = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Whether a macOS application is running, without launching it by asking. */
export const appIsRunning = (processName: string): boolean =>
  osascript(
    `tell application "System Events" to (name of processes) contains ${asString(processName)}`,
  ).out === 'true';

/**
 * Whether an AppleScript failure was macOS refusing us Accessibility access.
 *
 * Worth singling out because it is the one failure with a fix the user must apply by hand, and
 * because it is otherwise unreadable: the error says "is not allowed assistive access", which
 * does not obviously mean "tick a box in System Settings for the terminal you are typing in".
 *
 * **The TEXT is what this matches on, and the number deliberately is not enough.** Measured on
 * this machine: `System Events got an error: osascript is not allowed assistive access. (-1728)`
 * -- so the denial arrives under -1728, which also means "can't get that object" and is exactly
 * what `applicationExists` relies on for "no such app". Adding -1728 to the numeric test would
 * report a missing window as a permission problem and send the developer to System Settings to
 * fix nothing. -1719 stays because it is unambiguous and older macOS raises it.
 */
export const isAccessibilityDenial = (err: string): boolean =>
  err.includes('-1719') || err.includes('assistive access') || err.includes('not allowed');

/**
 * What to allow, and where -- with the two parts that are not obvious.
 *
 * "Allow your terminal" is the answer everyone gives and it is half of one here. macOS attributes
 * an Apple Event to the RESPONSIBLE process, which for a command typed in a terminal is that
 * terminal -- but hangar's commands run inside its own tmux server, and a tmux server is
 * reparented to launchd. A detached chain has no terminal to be responsible for it, so the
 * attribution falls to the executable itself.
 *
 * Measured on this machine, with iTerm2 already allowed: from a pane on hangar's socket,
 * `tell application "System Events" to get name of processes` succeeds (it needs no
 * accessibility) while `tell process "Code" to get name of windows` still fails with
 * `not allowed assistive access. (-1728)`. The same machine's Accessibility list had picked up
 * bare executables of its own accord (`uv`, and hangar's own launcher script), which is what
 * attribution-to-the-executable looks like from the outside.
 *
 * Two things make the instruction actionable rather than merely correct:
 *
 * - **The REAL path, not the one on PATH.** `tmuxBinary()` answers `command -v`, which here is
 *   `/opt/homebrew/bin/tmux` -- a symlink. TCC records the resolved target, so the symlink is the
 *   one path that will not work, and this resolves it. Homebrew's target carries the version, so
 *   `brew upgrade tmux` moves it and the grant has to be made again; that is said rather than
 *   left to be discovered.
 * - **How to reach it in the picker.** `/opt` is hidden in the `+` file dialog and cannot be
 *   browsed to, which is where this stalls. Cmd-Shift-G takes a path.
 *
 * A granted process also keeps the answer it was given until it restarts, so a tmux server that
 * has already been refused stays refused.
 */
export const accessibilityHint = (): string => {
  const lines = [
    'System Settings → Privacy & Security → Accessibility, then:',
    '  • allow the terminal you run `hangar` from;',
    `  • allow ${resolvedTmuxPath()} — hangar runs inside its own tmux server, which is detached from that terminal, so macOS attributes the request to the binary rather than to the terminal;`,
    '  • in that `+` file picker, press Cmd-Shift-G and paste the path — /opt is hidden and cannot be browsed to;',
    '  • then restart the tmux server: one that has already been refused keeps that answer until it does.',
  ];
  return lines.join('\n');
};

/**
 * Where tmux really lives, with every symlink resolved, or the bare name if it cannot be found.
 *
 * Deliberately not `tmuxBinary()` from `src/tmux.ts`: that returns what `command -v` says, which
 * is what you want to EXECUTE and exactly what you must not paste into TCC. Keeping this here
 * also keeps this module the leaf its header claims it is.
 */
const resolvedTmuxPath = (): string => {
  const found = run('sh', ['-c', 'command -v tmux 2>/dev/null']);
  const path = found.ok ? found.stdout.trim() : '';
  if (path === '') return 'the `tmux` binary';
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
