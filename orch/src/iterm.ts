import { run } from './exec.ts';

/**
 * iTerm2 automation.
 *
 * Two jobs: open a clone's working set of tabs, and reach INTO a tab that is already running
 * a Claude Code session. The second is the only mechanism there is -- the `claude` CLI has
 * no subcommand that messages a live interactive session, so `orch-util sync` maps the session's
 * tty to an iTerm2 session and types into it, exactly as the user would.
 *
 * Everything here degrades to a no-op plus a warning when iTerm2 is not running or the tab
 * cannot be found; nothing in the fleet depends on it succeeding.
 */
const osascript = (script: string): { ok: boolean; out: string; err: string } => {
  const res = run('osascript', ['-e', script]);
  return { ok: res.ok, out: res.stdout.trim(), err: res.stderr.trim() };
};

/** AppleScript string literal escaping: backslashes and double quotes only. */
const asString = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const itermIsRunning = (): boolean =>
  osascript('tell application "System Events" to (name of processes) contains "iTerm2"').out ===
  'true';

/**
 * Send a line of text to the iTerm2 session attached to `tty` (e.g. `ttys004`), as if the
 * user had typed it and pressed Return. Returns false when no such session is open.
 */
export const writeToTty = (tty: string, text: string): boolean => {
  if (!itermIsRunning()) return false;
  const devPath = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  const script = [
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if tty of s is ${asString(devPath)} then`,
    `          tell s to write text ${asString(text)}`,
    '          return "sent"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "not-found"',
  ].join('\n');
  return osascript(script).out === 'sent';
};

export type TabSpec = {
  readonly cwd: string;
  /** Command to run after cd-ing, e.g. `claude`. Omit for a plain shell. */
  readonly command?: string | undefined;
};

/**
 * Open a new iTerm2 window whose tabs sit in the given directories. The first spec becomes
 * the window's initial session; the rest become additional tabs.
 *
 * The tab colours are not set here on purpose -- the `dvb-clone-iterm.zsh` chpwd hook does
 * that the moment each shell cds into the clone, so the colour is right whether the tab was
 * opened by this command or by hand.
 */
export const openWindowWithTabs = (tabs: readonly TabSpec[]): boolean => {
  if (tabs.length === 0) return true;
  const line = (tab: TabSpec): string =>
    `cd ${JSON.stringify(tab.cwd)}${tab.command === undefined ? '' : ` && ${tab.command}`}`;

  const [first, ...rest] = tabs;
  if (!first) return true;

  const script = [
    'tell application "iTerm2"',
    '  activate',
    '  set theWindow to (create window with default profile)',
    `  tell current session of theWindow to write text ${asString(line(first))}`,
    ...rest.flatMap((tab) => [
      '  tell theWindow',
      '    create tab with default profile',
      `    tell current session of theWindow to write text ${asString(line(tab))}`,
      '  end tell',
    ]),
    '  tell theWindow to select tab 1 of it',
    'end tell',
  ].join('\n');

  const res = osascript(script);
  return res.ok;
};
