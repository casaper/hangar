/**
 * The terminal seam: what Hangar needs from a terminal emulator, and what it does without.
 *
 * Hangar drives a terminal for two unrelated jobs. It OPENS a clone's working set of tabs, and
 * it reaches INTO a tab that is already running a Claude Code session -- the second because the
 * `claude` CLI has no subcommand that messages a live interactive session, so `hangar sync` maps
 * the session's tty to a tab and types into it, exactly as the user would.
 *
 * ## Why capabilities, and not one interface every driver must satisfy
 *
 * The emulators differ in KIND, not in polish. iTerm2 exposes scriptable session variables, so a
 * tab can be tagged with the clone it belongs to and found again later; Konsole exposes a D-Bus
 * interface with session titles and `sendText`; Terminal.app is scriptable but has no notion of a
 * user variable, so the tag has to live in its `custom title`; GNOME Terminal has a command line
 * that opens a tab and NOTHING else -- no enumeration, no titles it will report back, no way to
 * type into a running tab. That last one is not a gap this code can close: VTE has no such API,
 * and the generic POSIX escape hatch (the `TIOCSTI` ioctl) is disabled by default on Linux 6.2
 * and later.
 *
 * So a driver DECLARES what it can do and every caller degrades one capability at a time. The
 * alternative -- a lowest-common-denominator interface -- would throw away the iTerm2 features
 * this fleet is built on, and a driver that silently no-ops the hard parts would be worse still:
 * `sync` would report a Claude session paused when nothing had been typed anywhere.
 */
export type TerminalKind = 'iterm2' | 'apple-terminal' | 'konsole' | 'gnome-terminal' | 'none';

export type TerminalCapabilities = {
  /** Create a clone's tabs at all. False means `hangar open` cannot run. */
  readonly openTabs: boolean;
  /**
   * Enumerate windows and tabs. This is what `open`'s two safety checks need: is this clone
   * already open, and is some window this CLI did not open already sitting in it. Without it,
   * `open` can only append and say so.
   */
  readonly inspect: boolean;
  /**
   * Stamp a clone/role tag on a tab and read it back later. Distinct from `inspect`: a driver
   * can list tabs without being able to label them, in which case every tab looks foreign.
   */
  readonly tag: boolean;
  /** Type a line into the tab attached to a given tty -- the `SYNC PAUSE` protocol. */
  readonly writeToTty: boolean;
  /** Bring an already-open clone group to the front. */
  readonly select: boolean;
  /**
   * Paint the tab's chrome when the tab is CREATED.
   *
   * True only for drivers whose emulator cannot be coloured from the shell, which today means
   * Terminal.app alone: it ignores the background-colour escape sequence, so the only way in is
   * AppleScript at creation time. Everywhere else the generated shell hook does the colouring on
   * every `cd`, which is strictly better -- a tab the developer opened by hand gets its colour
   * too. See `generate/terminal-sh.ts`.
   */
  readonly paintOnCreate: boolean;
};

/**
 * One tab of a clone's working set.
 *
 * `clone` and `role` are the tag: they are what the driver stamps on the tab and what
 * `windows()` reads back, which is how the CLI recognises its own tabs later.
 */
export type TerminalTabSpec = {
  readonly cwd: string;
  /** Command to run after cd-ing, e.g. `claude`. Omit for a plain shell. */
  readonly command?: string | undefined;
  /** The clone directory this tab belongs to. */
  readonly clone: string;
  /** Which of the clone's tabs this is -- a `terminal.tabs[].role` from the config, or an
   * editor kind for an editor that lives in a terminal. Free text, because the config chooses
   * it: nothing may match on a particular value. */
  readonly role: string;
  /** The clone's hue as `#rrggbb`, for drivers with `paintOnCreate`. */
  readonly colour?: string | undefined;
};

export type TerminalTab = {
  /** The clone directory, or undefined for a tab the CLI did not open (or cannot recognise). */
  readonly clone: string | undefined;
  readonly role: string | undefined;
  /**
   * Where the tab's shell is standing right now. A HINT only -- it moves with every `cd`, so it
   * never decides which clone a tab belongs to; `clone` above does. It exists for one question a
   * tag cannot answer: does some window this CLI did not open already sit in that clone?
   */
  readonly path: string | undefined;
};

export type TerminalWindow = {
  readonly id: number;
  /** Every tab in the window, in tab-bar order, tagged or not. */
  readonly tabs: readonly TerminalTab[];
};

export type OpenResult = {
  readonly windowId: number;
  /** False when the tabs went into a window that was already open. */
  readonly createdWindow: boolean;
};

export type TerminalDriver = {
  readonly kind: TerminalKind;
  /** How to name this terminal to the user: `iTerm2`, `Konsole`, … */
  readonly label: string;
  readonly capabilities: TerminalCapabilities;
  /**
   * Whether the emulator is available to be driven right now.
   *
   * Deliberately not the same question for every driver: iTerm2 and Terminal.app must already be
   * RUNNING (AppleScript cannot address an application that is not), while GNOME Terminal is
   * D-Bus-activated and starts on demand, so for it this only asks whether it is installed.
   */
  readonly isAvailable: () => boolean;
  /** Why it is not available, for the error message. Only consulted when `isAvailable` is false. */
  readonly unavailableHint: () => string;
  /** Every window with its tabs, front-to-back. Always `[]` when `inspect` is false. */
  readonly windows: () => TerminalWindow[];
  /**
   * Append a clone's tabs, creating a window only if `existing` is undefined.
   * Returns undefined when the emulator refused.
   */
  readonly openTabs: (
    tabs: readonly TerminalTabSpec[],
    existing: TerminalWindow | undefined,
  ) => OpenResult | undefined;
  /** Bring the clone's group forward. False when it has no tabs open, or `select` is false. */
  readonly select: (windowId: number, clone: string) => boolean;
  /** Type one line into the tab on `tty`. False when there is no such tab, or it cannot be done. */
  readonly writeToTty: (tty: string, text: string) => boolean;
};

/** `/dev/ttys004` from either `ttys004` or `/dev/ttys004`. */
export const devPath = (tty: string): string => (tty.startsWith('/dev/') ? tty : `/dev/${tty}`);

/** The shell line a tab runs once it is created. */
export const cdLine = (tab: TerminalTabSpec): string =>
  `cd ${JSON.stringify(tab.cwd)}${tab.command === undefined ? '' : ` && ${tab.command}`}`;

export const orUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * The one window the fleet's tabs live in, if it is open.
 *
 * "The fleet window" is simply the window holding the most CLI-opened tabs, so a second one
 * created by hand loses and the tabs keep converging on a single window. A window with no tagged
 * tab at all is never it -- notably the hangar-root window this CLI is usually typed into, which
 * must not have clone tabs pushed into it.
 *
 * Shared by every driver rather than reimplemented per emulator: the rule is about what the CLI
 * wants, not about how a particular terminal reports its windows.
 */
export const pickFleetWindow = (windows: readonly TerminalWindow[]): TerminalWindow | undefined => {
  let best: TerminalWindow | undefined;
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
