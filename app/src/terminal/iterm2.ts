import { appIsRunning, asString, osascript } from './applescript.ts';
import {
  cdLine,
  devPath,
  orUndefined,
  type OpenResult,
  type TerminalDriver,
  type TerminalTab,
  type TerminalTabSpec,
  type TerminalWindow,
} from './types.ts';

/**
 * iTerm2 -- the reference driver, and the only one that can do everything.
 *
 * It is the reference because of one feature no other emulator here has: scriptable per-session
 * USER VARIABLES. Everything `open` does safely -- find the fleet window, notice that a clone is
 * already open, refuse to push tabs into a window belonging to another hangar -- rests on being
 * able to label a tab and read the label back later. The other drivers approximate this with a
 * title, or cannot do it at all.
 */

/**
 * The three variables every session this CLI opens carries.
 *
 * User variables, not the session's `session.path`: the path is where the shell HAPPENS to be
 * standing, so one `cd ~` would make a clone's tab unrecognisable (or, worse, attribute it to
 * whichever clone the developer wandered into). The variables are set once at creation, survive
 * for the life of the session, and are readable from a later `osascript` process -- which is
 * exactly the lifetime "which tabs are already open?" needs.
 *
 * `hangarId` is what keeps several hangars on one machine apart. Without it, `open` in hangar B
 * would find hangar A's window (its tabs are tagged, so it looks like "the fleet window") and
 * append B's clones to it. A tab whose id is not ours is reported as untagged, which puts it in
 * the same bucket as a window the developer opened by hand: never appended to, and warned about
 * only if it is sitting in our clone.
 */
const VAR_ID = 'user.hangarId';
const VAR_CLONE = 'user.hangarClone';
const VAR_ROLE = 'user.hangarRole';

const FIELD_SEP = '|';

/**
 * Read every iTerm2 window, its tabs' tags and their working directories.
 *
 * One line per tab -- `<window id>|<hangar>|<clone>|<role>|<path>` -- because AppleScript has no
 * JSON and building it by concatenation is worse than parsing a delimited line here. The path
 * goes LAST and is not escaped: it is the one field that can contain the separator, and as the
 * tail of the line it needs no escaping to survive.
 */
const inspectScript = [
  'tell application "iTerm2"',
  '  set res to ""',
  '  repeat with w in windows',
  '    set wid to (id of w as text)',
  '    repeat with t in tabs of w',
  '      set idOut to ""',
  '      set cloneOut to ""',
  '      set roleOut to ""',
  '      set pathOut to ""',
  '      repeat with s in sessions of t',
  '        tell s',
  `          set idVar to variable named ${JSON.stringify(VAR_ID)}`,
  `          set cloneVar to variable named ${JSON.stringify(VAR_CLONE)}`,
  `          set roleVar to variable named ${JSON.stringify(VAR_ROLE)}`,
  '          set pathVar to variable named "session.path"',
  '        end tell',
  '        if cloneVar is not missing value and (cloneVar as text) is not "" then',
  '          set cloneOut to (cloneVar as text)',
  '          if roleVar is not missing value then set roleOut to (roleVar as text)',
  '          if idVar is not missing value then set idOut to (idVar as text)',
  '        end if',
  '        if pathVar is not missing value and pathOut is "" then',
  '          set pathOut to (pathVar as text)',
  '        end if',
  '      end repeat',
  `      set res to res & wid & ${JSON.stringify(FIELD_SEP)} & idOut & ${JSON.stringify(FIELD_SEP)} & cloneOut & ${JSON.stringify(FIELD_SEP)} & roleOut & ${JSON.stringify(FIELD_SEP)} & pathOut & linefeed`,
  '    end repeat',
  '  end repeat',
  '  return res',
  'end tell',
].join('\n');

/**
 * Every iTerm2 window with its tabs, in front-to-back window order.
 *
 * Read in ONE osascript call: every caller needs the same picture -- which window is the fleet's,
 * whether this clone is already in it, whether some other window is sitting in the clone -- and
 * asking three times invites three different answers.
 */
const readWindows = (hangarId: string): TerminalWindow[] => {
  const res = osascript(inspectScript);
  if (!res.ok) return [];
  const order: number[] = [];
  const tabs = new Map<number, TerminalTab[]>();
  for (const line of res.out.split('\n')) {
    if (line.trim() === '') continue;
    // Split into exactly five fields; the path keeps any separator of its own.
    const [rawId, tagId, clone, role, ...rest] = line.split(FIELD_SEP);
    const id = Number.parseInt(rawId ?? '', 10);
    if (!Number.isFinite(id)) continue;
    if (!tabs.has(id)) {
      tabs.set(id, []);
      order.push(id);
    }
    // A tab tagged by ANOTHER hangar is reported untagged -- see VAR_ID. An empty id is a tab
    // opened by a Hangar older than the id, and is treated as ours: it is in our window, and
    // demoting it would split the fleet window in two.
    const ours = tagId === undefined || tagId === '' || tagId === hangarId;
    tabs.get(id)?.push({
      clone: ours ? orUndefined(clone) : undefined,
      role: ours ? orUndefined(role) : undefined,
      path: orUndefined(rest.join(FIELD_SEP)),
    });
  }
  return order.map((id) => ({ id, tabs: tabs.get(id) ?? [] }));
};

const tabStatements = (hangarId: string, tab: TerminalTabSpec): string[] => [
  '  tell current session of theTab',
  `    set variable named ${asString(VAR_ID)} to ${asString(hangarId)}`,
  `    set variable named ${asString(VAR_CLONE)} to ${asString(tab.clone)}`,
  `    set variable named ${asString(VAR_ROLE)} to ${asString(tab.role)}`,
  `    write text ${asString(cdLine(tab))}`,
  '  end tell',
];

/**
 * Add a clone's tabs to the fleet window, creating that window only if there is not one yet.
 *
 * ## Why the tabs can only be appended
 *
 * iTerm2's AppleScript interface cannot MOVE a tab. Its `tabs` element is declared read-only
 * (`<element type="tab" access="r">`), `move` is accepted and then silently does nothing --
 * verified for `to before tab 1`, `to beginning of tabs`, and even into another window -- and
 * `tab`'s `index` property has a getter and no setter. `make new tab at before tab 1` likewise
 * reports success and creates nothing. Only iTerm2's Python API can reorder tabs
 * (`ITMReorderTabsRequest`), and that needs the Python API switched on plus its downloaded
 * runtime, so it is not something this CLI can reach.
 *
 * So order comes from CREATION order, which is why `open` sorts the clones it was given before
 * opening any of them, and why it says so when the result is still out of order.
 *
 * The tab colours are not set here on purpose -- the generated shell hook does that the moment
 * each shell cds into the clone, so the colour is right whether the tab was opened by this
 * command or by hand. Terminal.app is the one driver that has to paint at creation instead,
 * because it ignores the escape sequence; see its `paintOnCreate`.
 */
const openTabs = (
  hangarId: string,
  tabs: readonly TerminalTabSpec[],
  existing: TerminalWindow | undefined,
): OpenResult | undefined => {
  const [first, ...rest] = tabs;
  if (!first) return undefined;

  const lines = ['tell application "iTerm2"', '  activate'];
  if (existing === undefined) {
    lines.push('  set theWindow to (create window with default profile)');
    lines.push('  set theTab to (current tab of theWindow)');
  } else {
    lines.push(`  set theWindow to (first window whose id is ${String(existing.id)})`);
    lines.push('  set theTab to (create tab with default profile of theWindow)');
  }
  lines.push(...tabStatements(hangarId, first));
  lines.push('  set firstTab to theTab');
  for (const tab of rest) {
    lines.push('  set theTab to (create tab with default profile of theWindow)');
    lines.push(...tabStatements(hangarId, tab));
  }
  // Land on the clone's first tab rather than wherever the last `create tab` left the selection.
  lines.push('  tell theWindow to select');
  lines.push('  tell firstTab to select');
  lines.push('  return (id of theWindow) as text');
  lines.push('end tell');

  const res = osascript(lines.join('\n'));
  if (!res.ok) return undefined;
  const id = Number.parseInt(res.out, 10);
  return {
    windowId: Number.isFinite(id) ? id : (existing?.id ?? 0),
    createdWindow: existing === undefined,
  };
};

/**
 * Bring an already-open clone group forward: its `claude` tab if that one is still there, else
 * whichever of its tabs comes first. Returns false when the clone has no tabs open.
 */
const selectTab = (windowId: number, clone: string): boolean => {
  const script = [
    'tell application "iTerm2"',
    '  activate',
    `  set theWindow to (first window whose id is ${String(windowId)})`,
    '  set fallback to missing value',
    '  repeat with t in tabs of theWindow',
    '    repeat with s in sessions of t',
    '      tell s',
    `        set cloneVar to variable named ${asString(VAR_CLONE)}`,
    `        set roleVar to variable named ${asString(VAR_ROLE)}`,
    '      end tell',
    `      if cloneVar is not missing value and (cloneVar as text) is ${asString(clone)} then`,
    '        if roleVar is not missing value and (roleVar as text) is "claude" then',
    '          tell theWindow to select',
    '          tell t to select',
    '          return "selected"',
    '        end if',
    '        if fallback is missing value then set fallback to t',
    '      end if',
    '    end repeat',
    '  end repeat',
    '  if fallback is not missing value then',
    '    tell theWindow to select',
    '    tell fallback to select',
    '    return "selected"',
    '  end if',
    'end tell',
    'return "not-found"',
  ].join('\n');
  return osascript(script).out === 'selected';
};

/**
 * Send a line of text to the session attached to `tty` (e.g. `ttys004`), as if the user had
 * typed it and pressed Return. Returns false when no such session is open.
 */
const writeToTty = (tty: string, text: string): boolean => {
  const target = devPath(tty);
  const script = [
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if tty of s is ${asString(target)} then`,
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

export const iterm2Driver = (hangarId: string): TerminalDriver => ({
  kind: 'iterm2',
  label: 'iTerm2',
  capabilities: {
    openTabs: true,
    inspect: true,
    tag: true,
    writeToTty: true,
    select: true,
    paintOnCreate: false,
  },
  isAvailable: () => appIsRunning('iTerm2'),
  unavailableHint: () => 'Start iTerm2 first — this command drives it over AppleScript.',
  windows: () => readWindows(hangarId),
  openTabs: (tabs, existing) => openTabs(hangarId, tabs, existing),
  select: selectTab,
  writeToTty,
});
