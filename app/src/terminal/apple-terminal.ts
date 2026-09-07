import {
  ACCESSIBILITY_HINT,
  appIsRunning,
  asString,
  isAccessibilityDenial,
  osascript,
} from './applescript.ts';
import { devPath, type EmulatorDriver, type WindowSpec } from './types.ts';

/**
 * Terminal.app -- a window for free, a tab only with Accessibility permission.
 *
 * Unlike iTerm2's `command`, `do script` runs its text IN A SHELL, so the line is appended with
 * `|| exec $SHELL` here: a tmux that refuses to start then leaves a shell holding the error
 * rather than a window that closes before it can be read.
 *
 * The asymmetry is in the AppleScript dictionary and not in this code:
 *
 * - **`do script <line>` with no `in` clause opens a NEW WINDOW** and runs the line in it. That
 *   is the whole window path, and it needs no special permission.
 * - **a `window`'s `tab` element is declared `access="r"`**, so there is no `make new tab`. A tab
 *   can only be created by sending Cmd-T through System Events, which needs Accessibility
 *   permission for whichever terminal `hangar` is being run from -- and there is no way to ask
 *   for it from here.
 *
 * So a tab is attempted, the tab count is checked to have actually grown, and a refusal falls
 * back to a window with a note naming what to allow. The developer asked for their clone, not for
 * a particular piece of window furniture, and a window in the right clone beats a permission
 * dialog they did not expect.
 */

/** `do script` runs in a shell, so keep one alive if tmux will not start. */
const inShell = (command: string): string => `${command} || exec $SHELL`;

const tabCount = (): number => {
  const res = osascript('tell application "Terminal" to return (count of tabs of windows) as text');
  const total = res.out
    .split(', ')
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => a + b, 0);
  return Number.isFinite(total) ? total : 0;
};

const openWindow = (spec: WindowSpec): boolean => {
  const lines = [
    'tell application "Terminal"',
    '  activate',
    // No `in` clause: this is the one call that creates a window, and it returns the new tab.
    `  set theTab to (do script ${asString(inShell(spec.command))})`,
  ];
  if (spec.title !== undefined) {
    lines.push(`  set custom title of theTab to ${asString(spec.title)}`);
    lines.push('  set title displays custom title of theTab to true');
  }
  lines.push('  return "opened"');
  lines.push('end tell');
  return osascript(lines.join('\n')).out === 'opened';
};

export const appleTerminalDriver = (): EmulatorDriver => {
  let note: string | undefined;

  /**
   * Cmd-T through System Events, then run the line in whatever tab that produced.
   *
   * The tab count is compared before and after rather than trusting the keystroke: System Events
   * reports success for a key it delivered nowhere, so without this check a denied Accessibility
   * grant looks exactly like a tab that opened.
   */
  const openTab = (spec: WindowSpec): boolean => {
    const before = tabCount();
    const res = osascript(
      [
        'tell application "Terminal" to activate',
        'tell application "System Events" to keystroke "t" using command down',
        'delay 0.4',
        'return "sent"',
      ].join('\n'),
    );
    if (!res.ok && isAccessibilityDenial(res.err)) {
      note = `Terminal.app needs Accessibility permission to open a tab. ${ACCESSIBILITY_HINT}`;
      return false;
    }
    if (tabCount() <= before) {
      note = `Terminal.app opened no tab — it likely needs Accessibility permission. ${ACCESSIBILITY_HINT}`;
      return false;
    }
    const lines = ['tell application "Terminal"', '  set theTab to (selected tab of front window)'];
    if (spec.title !== undefined) {
      lines.push(`  set custom title of theTab to ${asString(spec.title)}`);
      lines.push('  set title displays custom title of theTab to true');
    }
    lines.push(`  do script ${asString(inShell(spec.command))} in theTab`);
    lines.push('  return "opened"');
    lines.push('end tell');
    return osascript(lines.join('\n')).out === 'opened';
  };

  const raiseByTty = (tty: string): boolean => {
    const target = devPath(tty);
    const script = [
      'tell application "Terminal"',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      set ttyOut to ""',
      '      try',
      '        set ttyOut to (tty of t as text)',
      '      end try',
      `      if ttyOut is ${asString(target)} then`,
      '        activate',
      '        set frontmost of w to true',
      '        set selected tab of w to t',
      '        return "raised"',
      '      end if',
      '    end repeat',
      '  end repeat',
      'end tell',
      'return "not-found"',
    ].join('\n');
    return osascript(script).out === 'raised';
  };

  return {
    kind: 'apple-terminal',
    label: 'Terminal.app',
    capabilities: { openTab: true, openWindow: true, raiseByTty: true },
    isAvailable: () => appIsRunning('Terminal'),
    unavailableHint: () => 'Start Terminal.app first — this command drives it over AppleScript.',
    open: (spec) => {
      note = undefined;
      if (spec.placement === 'window') return openWindow(spec);
      if (openTab(spec)) return true;
      // The note is already set by `openTab`, and it is the whole point of falling back rather
      // than failing: the clone opens, and the developer is told what a tab would have needed.
      return openWindow(spec);
    },
    lastNote: () => note,
    raiseByTty,
  };
};
