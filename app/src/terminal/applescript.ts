import { run } from '../exec.ts';

/**
 * The macOS AppleScript helpers, shared by every driver that talks to an app that way.
 *
 * Both mac terminal drivers do, and so does `platform/darwin.ts`'s `closeAppWindow` -- so these
 * live here rather than being written three times. It is a leaf: no seam semantics, no imports
 * beyond `run`.
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

export const ACCESSIBILITY_HINT =
  'System Settings → Privacy & Security → Accessibility: allow the terminal you run `hangar` from.';
