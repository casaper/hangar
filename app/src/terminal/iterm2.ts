import { join } from 'node:path';

import { run } from '../exec.ts';
import { home } from '../user-paths.ts';
import { appIsRunning, asString, osascript } from './applescript.ts';
import {
  devPath,
  type EmulatorDriver,
  type MouseReport,
  type MouseReporting,
  type WindowSpec,
} from './types.ts';

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

/**
 * iTerm2's mouse reporting, which is TWO settings rather than one.
 *
 * Measured on 3.7.2, against this machine's preferences: `Mouse Reporting` turns reporting on,
 * and `Mouse Reporting allow clicks and drags` decides whether BUTTON presses are part of it. A
 * profile with the first on and the second off scrolls a tmux pane with the wheel and delivers no
 * click at all -- and nothing inside tmux can tell that apart from a bad binding, which is what
 * makes the bar's clickable half look broken while every binding is correct. It cost a whole
 * investigation once; `terminal-and-sessions.md` has that story.
 *
 * **The DEFAULT profile is the right one to read, and that is not a guess**: `openScript` above
 * creates every tab and every window `with default profile`, so it is the profile every clone's
 * window runs under.
 *
 * **A missing clicks key reads as `clicks`.** iTerm2's shipped `DefaultBookmark.plist` carries
 * `Mouse Reporting` and not that key, so its compiled-in default is unverified here -- and
 * reporting a state nobody measured would put a false alarm on a machine that is fine.
 *
 * **`plutil -extract … json` rather than converting the whole file**, which is load-bearing: a
 * `plutil -convert json` of this plist fails outright with `Invalid object in plist for JSON
 * format`, and so would anything built on it.
 */
const PREFERENCES = join(home, 'Library', 'Preferences', 'com.googlecode.iterm2.plist');

const extract = (keypath: string, format: 'json' | 'raw'): string | undefined => {
  const res = run('plutil', ['-extract', keypath, format, '-o', '-', PREFERENCES]);
  return res.ok ? res.stdout.trim() : undefined;
};

/**
 * The state, plus what to do about it. Pure, so every branch is assertable without a plist.
 *
 * The hint names the trade-off as well as the setting, because the setting is off for a reason
 * often enough that "just turn it on" would be advice rather than information.
 */
export const iterm2MouseReport = (state: MouseReporting): MouseReport => {
  switch (state) {
    case 'wheel-only':
      return {
        state,
        hint: [
          'iTerm2 is reporting the wheel but not button presses, so clicking a window tab, the issue key or the pull request on the tmux bar does nothing.',
          'Settings → Profiles → Terminal → let clicks and drags be reported.',
          'The trade-off is real: with them reported a plain drag inside a pane selects in tmux rather than in iTerm2, and ⌥-drag becomes the native copy.',
        ].join('\n'),
      };
    case 'off':
      return {
        state,
        hint: [
          'iTerm2 is reporting no mouse events at all, so nothing on the tmux bar is clickable and the wheel scrolls iTerm2 instead of the pane.',
          'Settings → Profiles → Terminal → enable mouse reporting.',
        ].join('\n'),
      };
    default:
      return { state };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The decision, given the two things read off the preferences file. Pure, and exported so the
 * suite reaches every branch -- there is no other way to see one: this machine has whatever
 * iTerm2 preferences it has, and a capture would pin exactly that one state.
 *
 * Everything it cannot RESOLVE is `unknown` rather than a default: an unreadable shape, and a
 * preferences file with several profiles and no guid naming which one is the default. The
 * missing clicks key is the one case that is not unresolved but decided -- see above.
 */
export const iterm2MouseState = (
  profiles: unknown,
  defaultGuid: string | undefined,
): MouseReporting => {
  if (!Array.isArray(profiles)) return 'unknown';
  const records = profiles.filter(isRecord);
  // The one profile, when there is only one, is the default whatever the guid says -- and a file
  // with several and no readable guid is the case this declines to guess at.
  const profile =
    records.find((entry) => defaultGuid !== undefined && entry['Guid'] === defaultGuid) ??
    (records.length === 1 ? records[0] : undefined);
  if (profile === undefined) return 'unknown';
  if (profile['Mouse Reporting'] === false) return 'off';
  return profile['Mouse Reporting allow clicks and drags'] === false ? 'wheel-only' : 'clicks';
};

const mouseReporting = (): MouseReport => {
  const json = extract('New Bookmarks', 'json');
  if (json === undefined) return iterm2MouseReport('unknown');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return iterm2MouseReport('unknown');
  }
  return iterm2MouseReport(iterm2MouseState(parsed, extract('Default Bookmark Guid', 'raw')));
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
  mouseReporting,
});
