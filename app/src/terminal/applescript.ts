import { run } from '../exec.ts';

/**
 * The macOS half of the terminal seam: both mac drivers talk to their app over AppleScript, so
 * the two helpers they share live here rather than being written twice.
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
 * because it is otherwise unreadable: error -1719 says "is not allowed assistive access", which
 * does not obviously mean "tick a box in System Settings for the terminal you are typing in".
 */
export const isAccessibilityDenial = (err: string): boolean =>
  err.includes('-1719') || err.includes('assistive access') || err.includes('not allowed');

export const ACCESSIBILITY_HINT =
  'System Settings → Privacy & Security → Accessibility: allow the terminal you run `hangar` from.';

/** AppleScript wants 16-bit colour channels, so each 0-255 byte is scaled by 257. */
export const asColour = (hex: string): string => {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const chan = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => String(c * 257));
  return `{${chan.join(', ')}}`;
};
