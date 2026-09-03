import { CliError } from '../exec.ts';
import { cwdByTty } from '../procs.ts';
import {
  ACCESSIBILITY_HINT,
  appIsRunning,
  asColour,
  asString,
  isAccessibilityDenial,
  osascript,
} from './applescript.ts';
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
 * Terminal.app -- macOS's own terminal, scriptable but missing the two things iTerm2 has.
 *
 * Everything below follows from its scripting dictionary
 * (`/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.sdef`), which is
 * worth reading before changing any of it:
 *
 * - a `tab` has `custom title` (read/write), `tty` (read-only) and `background color`
 *   (read/write). There is no user-variable mechanism, so THE TITLE IS THE TAG.
 * - a `window`'s `tab` element is declared `access="r"`, so there is no `make new tab`. A tab
 *   can only be created by sending Cmd-T through System Events, which needs Accessibility
 *   permission for whichever terminal `hangar` is being run from.
 * - `do script` with no `in` clause opens a NEW WINDOW; with `in <tab>` it types into that tab,
 *   which is what makes the `SYNC PAUSE` protocol work here.
 *
 * ## The title as a tag
 *
 * A title is a worse tag than a user variable in exactly one way: the developer can overwrite
 * it. If they do, the tab stops being recognised and is treated like any window opened by hand
 * -- never appended to, and warned about if it is sitting in one of our clones. That is the safe
 * direction to fail in, and the title earns its keep meanwhile: it is the only place Terminal.app
 * shows which clone a tab belongs to.
 *
 * The hangar id is part of the tag for the same reason it is in iTerm2's: two hangars on one
 * machine must not adopt each other's windows.
 */
const TAG_SEP = ' · ';

const tagFor = (hangarId: string, tab: TerminalTabSpec): string =>
  [tab.clone, tab.role, hangarId].join(TAG_SEP);

const parseTag = (
  hangarId: string,
  title: string | undefined,
): { clone: string | undefined; role: string | undefined } => {
  const parts = (title ?? '').split(TAG_SEP);
  if (parts.length !== 3 || parts[2] !== hangarId) return { clone: undefined, role: undefined };
  return { clone: orUndefined(parts[0]), role: orUndefined(parts[1]) };
};

const FIELD_SEP = '|';

/**
 * `<window id>|<tty>|<custom title>` per tab.
 *
 * The title goes last and unescaped: it is the field that can contain anything, and as the tail
 * of the line it survives without escaping. `tty` is what the working directory is resolved from
 * afterwards -- Terminal.app will not report a tab's directory itself.
 */
const inspectScript = [
  'tell application "Terminal"',
  '  set res to ""',
  '  repeat with w in windows',
  '    set wid to (id of w as text)',
  '    repeat with t in tabs of w',
  '      set ttyOut to ""',
  '      set titleOut to ""',
  '      try',
  '        set ttyOut to (tty of t as text)',
  '      end try',
  '      try',
  '        set titleOut to (custom title of t as text)',
  '      end try',
  `      set res to res & wid & ${JSON.stringify(FIELD_SEP)} & ttyOut & ${JSON.stringify(FIELD_SEP)} & titleOut & linefeed`,
  '    end repeat',
  '  end repeat',
  '  return res',
  'end tell',
].join('\n');

const readWindows = (hangarId: string): TerminalWindow[] => {
  const res = osascript(inspectScript);
  if (!res.ok) return [];

  type Raw = { readonly wid: number; readonly tty: string | undefined; readonly title: string };
  const raw: Raw[] = [];
  for (const line of res.out.split('\n')) {
    if (line.trim() === '') continue;
    const [rawId, tty, ...rest] = line.split(FIELD_SEP);
    const wid = Number.parseInt(rawId ?? '', 10);
    if (!Number.isFinite(wid)) continue;
    raw.push({ wid, tty: orUndefined(tty), title: rest.join(FIELD_SEP) });
  }

  // One process-table lookup for every tab at once; see `cwdByTty`.
  const cwds = cwdByTty(raw.map((r) => r.tty).filter((t): t is string => t !== undefined));

  const order: number[] = [];
  const tabs = new Map<number, TerminalTab[]>();
  for (const row of raw) {
    if (!tabs.has(row.wid)) {
      tabs.set(row.wid, []);
      order.push(row.wid);
    }
    const tag = parseTag(hangarId, row.title);
    tabs.get(row.wid)?.push({
      clone: tag.clone,
      role: tag.role,
      path: row.tty === undefined ? undefined : cwds.get(row.tty.replace(/^\/dev\//, '')),
    });
  }
  return order.map((id) => ({ id, tabs: tabs.get(id) ?? [] }));
};

/** What every tab gets once it exists: the command, the tag, and the clone's colour. */
const dressTab = (hangarId: string, tab: TerminalTabSpec, target: string): string[] => [
  `  do script ${asString(cdLine(tab))} in ${target}`,
  `  set custom title of ${target} to ${asString(tagFor(hangarId, tab))}`,
  `  set title displays custom title of ${target} to true`,
  ...(tab.colour === undefined
    ? []
    : [`  set background color of ${target} to ${asColour(tab.colour)}`]),
];

/**
 * Open a clone's tabs.
 *
 * The Cmd-T keystroke is the only way to add a tab (see the header), so this asks System Events
 * for it and then checks that the tab count actually grew. When it did not -- Accessibility
 * permission missing, most likely -- the caller is told rather than left with three tabs' worth
 * of commands typed into one tab on top of each other, which is what an unchecked keystroke
 * would produce.
 *
 * Terminal.app is also the one driver that paints the tab itself: it ignores the background
 * colour escape sequence the generated shell hook uses, so a colour set here at creation is the
 * only colour these tabs will ever have. The consequence is honest and worth knowing -- a
 * Terminal.app tab the developer opens by hand in a clone stays uncoloured.
 */
const openTabs = (
  hangarId: string,
  tabs: readonly TerminalTabSpec[],
  existing: TerminalWindow | undefined,
): OpenResult | undefined => {
  const [first, ...rest] = tabs;
  if (!first) return undefined;

  const lines = ['tell application "Terminal"', '  activate'];
  if (existing === undefined) {
    // No `in` clause: this is the one call that creates a window, and it returns the new tab.
    lines.push(`  set theTab to (do script ${asString(cdLine(first))})`);
    lines.push('  set theWindow to (first window whose tabs contains theTab)');
    lines.push(`  set custom title of theTab to ${asString(tagFor(hangarId, first))}`);
    lines.push('  set title displays custom title of theTab to true');
    if (first.colour !== undefined) {
      lines.push(`  set background color of theTab to ${asColour(first.colour)}`);
    }
  } else {
    lines.push(`  set theWindow to (first window whose id is ${String(existing.id)})`);
    lines.push('  set frontmost of theWindow to true');
    lines.push(`  set expected to (count of tabs of theWindow) + 1`);
    lines.push('  tell application "System Events" to keystroke "t" using command down');
    lines.push('  delay 0.35');
    lines.push('  if (count of tabs of theWindow) is not expected then return "no-tab"');
    lines.push('  set theTab to (last tab of theWindow)');
    lines.push(...dressTab(hangarId, first, 'theTab'));
  }
  for (const tab of rest) {
    lines.push('  set frontmost of theWindow to true');
    lines.push('  set expected to (count of tabs of theWindow) + 1');
    lines.push('  tell application "System Events" to keystroke "t" using command down');
    lines.push('  delay 0.35');
    lines.push('  if (count of tabs of theWindow) is not expected then return "no-tab"');
    lines.push('  set theTab to (last tab of theWindow)');
    lines.push(...dressTab(hangarId, tab, 'theTab'));
  }
  lines.push('  set frontmost of theWindow to true');
  lines.push('  set selected of (first tab of theWindow) to true');
  lines.push('  return (id of theWindow) as text');
  lines.push('end tell');

  const res = osascript(lines.join('\n'));
  if (!res.ok || res.out === 'no-tab') {
    if (isAccessibilityDenial(res.err) || res.out === 'no-tab') {
      throw new CliError(
        'Terminal.app would not open a new tab',
        `Terminal.app has no scriptable "new tab" — Hangar sends Cmd-T instead, which needs Accessibility permission.\n${ACCESSIBILITY_HINT}`,
      );
    }
    return undefined;
  }
  const id = Number.parseInt(res.out, 10);
  return {
    windowId: Number.isFinite(id) ? id : (existing?.id ?? 0),
    createdWindow: existing === undefined,
  };
};

const selectTab = (hangarId: string, windowId: number, clone: string): boolean => {
  const want = `${clone}${TAG_SEP}claude${TAG_SEP}${hangarId}`;
  const prefix = `${clone}${TAG_SEP}`;
  const suffix = `${TAG_SEP}${hangarId}`;
  const script = [
    'tell application "Terminal"',
    '  activate',
    `  set theWindow to (first window whose id is ${String(windowId)})`,
    '  set fallback to missing value',
    '  repeat with t in tabs of theWindow',
    '    set titleOut to ""',
    '    try',
    '      set titleOut to (custom title of t as text)',
    '    end try',
    `    if titleOut is ${asString(want)} then`,
    '      set frontmost of theWindow to true',
    '      set selected of t to true',
    '      return "selected"',
    '    end if',
    `    if titleOut starts with ${asString(prefix)} and titleOut ends with ${asString(suffix)} then`,
    '      if fallback is missing value then set fallback to t',
    '    end if',
    '  end repeat',
    '  if fallback is not missing value then',
    '    set frontmost of theWindow to true',
    '    set selected of fallback to true',
    '    return "selected"',
    '  end if',
    'end tell',
    'return "not-found"',
  ].join('\n');
  return osascript(script).out === 'selected';
};

/**
 * Type a line into the tab on `tty`.
 *
 * `do script … in <tab>` is exactly the right primitive: it runs the text in an existing tab as
 * if it had been typed, which is the whole of the `SYNC PAUSE` mechanism.
 */
const writeToTty = (tty: string, text: string): boolean => {
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
    `        do script ${asString(text)} in t`,
    '        return "sent"',
    '      end if',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "not-found"',
  ].join('\n');
  return osascript(script).out === 'sent';
};

export const appleTerminalDriver = (hangarId: string): TerminalDriver => ({
  kind: 'apple-terminal',
  label: 'Terminal.app',
  capabilities: {
    openTabs: true,
    inspect: true,
    tag: true,
    writeToTty: true,
    select: true,
    // The one driver that must paint at creation: Terminal.app ignores OSC 11.
    paintOnCreate: true,
  },
  isAvailable: () => appIsRunning('Terminal'),
  unavailableHint: () => 'Start Terminal.app first — this command drives it over AppleScript.',
  windows: () => readWindows(hangarId),
  openTabs: (tabs, existing) => openTabs(hangarId, tabs, existing),
  select: (windowId, clone) => selectTab(hangarId, windowId, clone),
  writeToTty,
});
