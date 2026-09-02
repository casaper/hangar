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

/**
 * One tab of a clone's working set. `clone` and `role` are stamped onto the session as iTerm2
 * user variables, which is how the CLI recognises its own tabs later -- see `fleetWindow`.
 */
export type FleetTabSpec = {
  readonly cwd: string;
  /** Command to run after cd-ing, e.g. `claude`. Omit for a plain shell. */
  readonly command?: string | undefined;
  /** `clone_NN`, the clone this tab belongs to. */
  readonly clone: string;
  /** `claude` | `shell` | `angular` -- which of the clone's three tabs this is. */
  readonly role: string;
};

/**
 * The two user variables every session the CLI opens carries.
 *
 * A user variable, not the session's `session.path`: the path is where the shell HAPPENS to be
 * standing, so one `cd ~` would make a clone's tab unrecognisable (or, worse, attribute it to
 * whichever clone the developer wandered into). The variables are set once at creation, survive
 * for the life of the session, and are readable from a later `osascript` process -- which is
 * exactly the lifetime "which tabs are already open?" needs.
 */
const VAR_CLONE = 'user.orchClone';
const VAR_ROLE = 'user.orchRole';

export type FleetTab = {
  /** `clone_NN`, or undefined for a tab the CLI did not open. */
  readonly clone: string | undefined;
  readonly role: string | undefined;
  /**
   * Where the tab's shell is standing right now. A HINT only -- it moves with every `cd`, so it
   * never decides which clone a tab belongs to; `clone` above does. It exists for one question
   * a tag cannot answer: does some window this CLI did not open already sit in that clone?
   */
  readonly path: string | undefined;
};

export type FleetWindow = {
  readonly id: number;
  /** Every tab in the window, in tab-bar order, tagged or not. */
  readonly tabs: readonly FleetTab[];
};

const FIELD_SEP = '|';

/**
 * Read every iTerm2 window, its tabs' clone tags and their working directories.
 *
 * One line per tab -- `<window id>|<clone>|<role>|<path>` -- because AppleScript has no JSON
 * and building it by concatenation is worse than parsing a delimited line here. The path goes
 * LAST and is not escaped: it is the one field that can contain the separator, and as the tail
 * of the line it needs no escaping to survive.
 */
const inspectScript = [
  'tell application "iTerm2"',
  '  set res to ""',
  '  repeat with w in windows',
  '    set wid to (id of w as text)',
  '    repeat with t in tabs of w',
  '      set cloneOut to ""',
  '      set roleOut to ""',
  '      set pathOut to ""',
  '      repeat with s in sessions of t',
  '        tell s',
  `          set cloneVar to variable named ${JSON.stringify(VAR_CLONE)}`,
  `          set roleVar to variable named ${JSON.stringify(VAR_ROLE)}`,
  '          set pathVar to variable named "session.path"',
  '        end tell',
  '        if cloneVar is not missing value and (cloneVar as text) is not "" then',
  '          set cloneOut to (cloneVar as text)',
  '          if roleVar is not missing value then set roleOut to (roleVar as text)',
  '        end if',
  '        if pathVar is not missing value and pathOut is "" then',
  '          set pathOut to (pathVar as text)',
  '        end if',
  '      end repeat',
  `      set res to res & wid & ${JSON.stringify(FIELD_SEP)} & cloneOut & ${JSON.stringify(FIELD_SEP)} & roleOut & ${JSON.stringify(FIELD_SEP)} & pathOut & linefeed`,
  '    end repeat',
  '  end repeat',
  '  return res',
  'end tell',
].join('\n');

const orUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * Every iTerm2 window with its tabs, in front-to-back window order.
 *
 * Read in ONE osascript call: every caller needs the same picture -- which window is the
 * fleet's, whether this clone is already in it, whether some other window is sitting in the
 * clone -- and asking three times invites three different answers.
 */
export const itermWindows = (): FleetWindow[] => {
  const res = osascript(inspectScript);
  if (!res.ok) return [];
  const order: number[] = [];
  const tabs = new Map<number, FleetTab[]>();
  for (const line of res.out.split('\n')) {
    if (line.trim() === '') continue;
    // Split into exactly four fields; the path keeps any separator of its own.
    const [rawId, clone, role, ...rest] = line.split(FIELD_SEP);
    const id = Number.parseInt(rawId ?? '', 10);
    if (!Number.isFinite(id)) continue;
    if (!tabs.has(id)) {
      tabs.set(id, []);
      order.push(id);
    }
    tabs.get(id)?.push({
      clone: orUndefined(clone),
      role: orUndefined(role),
      path: orUndefined(rest.join(FIELD_SEP)),
    });
  }
  return order.map((id) => ({ id, tabs: tabs.get(id) ?? [] }));
};

/**
 * The one window the fleet's tabs live in, if it is open.
 *
 * "The fleet window" is simply the window holding the most CLI-opened tabs, so a second one
 * created by hand loses and the tabs keep converging on a single window. A window with no
 * tagged tab at all is never it -- notably the fleet-root window this CLI is usually typed
 * into, which must not have clone tabs pushed into it.
 */
export const pickFleetWindow = (windows: readonly FleetWindow[]): FleetWindow | undefined => {
  let best: FleetWindow | undefined;
  let bestCount = 0;
  for (const win of windows) {
    const count = win.tabs.filter((t) => t.clone !== undefined).length;
    // Strictly greater: `windows` is front-to-back, so a tie keeps the frontmost one.
    if (count > bestCount) {
      best = win;
      bestCount = count;
    }
  }
  return best;
};

export const fleetWindow = (): FleetWindow | undefined => pickFleetWindow(itermWindows());

const cdLine = (tab: FleetTabSpec): string =>
  `cd ${JSON.stringify(tab.cwd)}${tab.command === undefined ? '' : ` && ${tab.command}`}`;

const tabStatements = (tab: FleetTabSpec): string[] => [
  '  tell current session of theTab',
  `    set variable named ${asString(VAR_CLONE)} to ${asString(tab.clone)}`,
  `    set variable named ${asString(VAR_ROLE)} to ${asString(tab.role)}`,
  `    write text ${asString(cdLine(tab))}`,
  '  end tell',
];

export type OpenResult = {
  readonly windowId: number;
  /** False when the tabs went into a window that was already open. */
  readonly createdWindow: boolean;
};

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
 * The tab colours are not set here on purpose -- the `dvb-clone-iterm.zsh` chpwd hook does
 * that the moment each shell cds into the clone, so the colour is right whether the tab was
 * opened by this command or by hand.
 */
export const openFleetTabs = (
  tabs: readonly FleetTabSpec[],
  /** The window to append to, from `pickFleetWindow`. Undefined opens the fleet window. */
  existing: FleetWindow | undefined,
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
  lines.push(...tabStatements(first));
  lines.push('  set firstTab to theTab');
  for (const tab of rest) {
    lines.push('  set theTab to (create tab with default profile of theWindow)');
    lines.push(...tabStatements(tab));
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
 * Bring an already-open clone group forward: its `claude` tab if that one is still there,
 * else whichever of its tabs comes first. Returns false when the clone has no tabs open.
 */
export const selectFleetTab = (windowId: number, clone: string): boolean => {
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
