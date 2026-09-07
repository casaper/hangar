/**
 * The emulator seam: the two things Hangar needs from a terminal emulator.
 *
 * `hangar open` puts a clone in ONE tab (or window) of the developer's emulator, and that tab is
 * a client attached to that clone's tmux session -- one tmux window inside it per
 * `terminal.tabs[]` role. So the emulator is asked to **open one tab or window running one
 * command**, and to **bring one it already opened to the front**. Everything else -- creating the
 * roles, naming them, ordering them, finding the clone again, typing a `SYNC PAUSE` into a live
 * session -- is `src/tmux.ts`, which is the same program on macOS and on Linux.
 *
 * ## Why capabilities, and not one interface every driver must satisfy
 *
 * Opening a tab or a window is the floor and every emulator here manages both. Raising one is
 * not: it needs the emulator to enumerate its tabs AND report each one's tty, which iTerm2 and
 * Terminal.app do over AppleScript, Konsole does over D-Bus only when `qdbus` is installed, and
 * GNOME Terminal cannot do at all -- VTE exposes no such API. That last one is not a gap this
 * code can close, so a driver DECLARES what it can do and the caller degrades one capability at a
 * time. The alternative -- pretending they are equivalent and silently no-opping the hard part --
 * would have `open` report a clone brought forward when nothing moved on screen.
 *
 * ## Raising is keyed on a TTY
 *
 * tmux reports the tty of the client attached to a clone's session (`#{client_tty}`), and mapping
 * a tty back to a tab is a lookup every capable emulator already supports. A title match would be
 * the alternative and it is worse: a title is a string the developer can overwrite, and one that
 * has been overwritten would make `open` create a second tab in a clone that already has one.
 */
export type EmulatorKind = 'iterm2' | 'apple-terminal' | 'konsole' | 'gnome-terminal' | 'none';

export type EmulatorCapabilities = {
  /**
   * Open a new tab in the emulator's current window.
   *
   * The default placement, and available everywhere -- but not always free: Terminal.app's `tab`
   * element is read-only in AppleScript, so a tab can only be made by sending Cmd-T through
   * System Events, which needs Accessibility permission for whichever terminal `hangar` runs
   * from. A driver that cannot deliver a tab right now says so and the caller falls back to a
   * window, which needs no such grant.
   */
  readonly openTab: boolean;
  /** Open a new window. The floor: false here means `hangar open` has nowhere to put a clone. */
  readonly openWindow: boolean;
  /**
   * Bring the tab or window hosting a given tty to the front.
   *
   * Distinct from opening one, and the only capability a caller has to degrade around. Without
   * it a clone that is already open stays where it is, and `open` says which `tmux attach` line
   * gets the developer back to it.
   */
  readonly raiseByTty: boolean;
};

/** One tab or window, running one command. There is nothing else to ask an emulator for. */
export type WindowSpec = {
  /** The shell LINE to run. `tmux.ts`'s `attachShellLine` builds it; nothing else may. */
  readonly command: string;
  readonly placement: Placement;
  /**
   * A title, for the emulators that take one at creation.
   *
   * Cosmetic and best effort. The title that actually shows is tmux's, through the generated
   * conf's `set-titles-string` -- which is how a developer with one tab per clone tells them
   * apart at the level the emulator draws.
   */
  readonly title?: string | undefined;
};

/** A tab in the current window, or a window of its own. `terminal.placement` picks the default. */
export type Placement = 'tab' | 'window';

export type EmulatorDriver = {
  readonly kind: EmulatorKind;
  /** How to name this terminal to the user: `iTerm2`, `Konsole`, … */
  readonly label: string;
  readonly capabilities: EmulatorCapabilities;
  /**
   * Whether the emulator can be driven right now.
   *
   * Deliberately not the same question for every driver: iTerm2 and Terminal.app must already be
   * RUNNING, because AppleScript cannot address an application that is not, while Konsole and
   * GNOME Terminal start on demand, so for those this only asks whether they are installed.
   */
  readonly isAvailable: () => boolean;
  /** Why it is not available, for the error message. Only consulted when `isAvailable` is false. */
  readonly unavailableHint: () => string;
  /**
   * Open one tab or window running the spec's command. False when the emulator refused.
   *
   * A driver asked for a `tab` it cannot deliver may fall back to a window and return true -- the
   * developer asked for their clone, not for a particular piece of window furniture -- but it
   * must report the reason through `lastNote` so the caller can print it.
   */
  readonly open: (spec: WindowSpec) => boolean;
  /** What the last `open` had to do differently, if anything. Read only after `open` returns. */
  readonly lastNote: () => string | undefined;
  /** False when there is no such tab, or `raiseByTty` is false. */
  readonly raiseByTty: (tty: string) => boolean;
};

/** `/dev/ttys004` from either `ttys004` or `/dev/ttys004`. */
export const devPath = (tty: string): string => (tty.startsWith('/dev/') ? tty : `/dev/${tty}`);

export const orUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;
