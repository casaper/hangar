/**
 * The platform seam: what Hangar needs from the operating system, and what it does without.
 *
 * The fifth seam, and the one that arrived last for an honest reason -- this fleet runs on
 * macOS, so every platform difference in this CLI was invisible until the tool was published for
 * someone to run on Linux. Three of them were already there, written as if `darwin` were the
 * only case: the VS Code window-state file, JetBrains' `open -a` fallback, and every install
 * hint in `environment.ts` reading `brew install`.
 *
 * ## Why capabilities, and not a global `if (process.platform === 'darwin')`
 *
 * The same reason the other four seams have them. A platform check at each call site answers
 * "am I on a Mac", which is never the question -- the question is "can this machine hand a path
 * to its desktop", and those two come apart. **Failure here is capability-scoped and never a
 * global gate**: an unsupported platform must still run `list`, `sync`, `doctor` and everything
 * else that touches no desktop, and must refuse the two things it genuinely cannot do BY NAME
 * rather than by silently producing a path that does not exist.
 *
 * That last part is the whole point. `vscodeWindowState` written for macOS does not fail on
 * Linux -- it returns a plausible path under `~/Library`, `readFileSync` throws, the catch
 * returns "no opinion", and `hangar open` opens a SECOND window on a workspace that was already
 * open. A workspace opened twice is how two Claude Code sessions end up in one clone, which is
 * this fleet's worst failure, and nothing on the way there prints a word.
 */

export type PlatformId = 'darwin' | 'linux' | 'unsupported';

export type PlatformCapabilities = {
  /**
   * Hand a path to the desktop and let it choose the application -- `open` / `xdg-open`.
   */
  readonly openExternally: boolean;
  /**
   * Address an application by its DISPLAY NAME rather than by a command on PATH.
   *
   * macOS alone: `open -a "WebStorm" <dir>` finds the bundle wherever it was installed. It is
   * what makes JetBrains' Toolbox case recoverable -- Toolbox may install no shell launcher, and
   * then the app bundle is the only handle there is. Linux has no equivalent: a `.desktop` entry
   * is addressed by a reverse-DNS id nobody types, and there is no lookup from "WebStorm" to it.
   */
  readonly openApplicationByName: boolean;
  /** Locate a VS Code-family editor's window-state file. */
  readonly vscodeWindowState: boolean;
  /**
   * Reach into another application's windows -- close one, by title.
   *
   * macOS alone, through System Events' accessibility interface, and **the one capability whose
   * presence is not the same as its working**: it also needs Accessibility permission for the
   * terminal `hangar` runs from, which a person grants by hand in System Settings and which no
   * command can grant for them. So it reports `denied` as its own outcome rather than folding
   * that into a failure -- there is a fix, and it belongs in the message.
   *
   * Linux has no equivalent worth pretending to. Wayland exposes no cross-application window
   * control by design, and the X11 route (`wmctrl`, `xdotool`) is neither installed by default
   * nor available under the compositor most desktops now run.
   */
  readonly controlAppWindows: boolean;
};

/**
 * What came of asking another application to close one of its windows.
 *
 * A union rather than a boolean because every arm here has a different thing to tell the
 * developer, and a caller that collapses them prints "could not close the window" for a
 * permission they can grant in ten seconds.
 */
export type AppWindowOutcome =
  | { readonly kind: 'closed' }
  /** The application is running and has no window whose title matches. */
  | { readonly kind: 'no-window' }
  | { readonly kind: 'not-running' }
  /** Accessibility permission is not granted. `hint` says what to allow, and where. */
  | { readonly kind: 'denied'; readonly hint: string }
  /** This platform cannot do it at all -- see `controlAppWindows`. */
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly why: string };

export type PlatformDriver = {
  readonly id: PlatformId;
  /** How to name it to the user: `macOS`, `Linux`, `win32 (unsupported)`. */
  readonly label: string;
  readonly capabilities: PlatformCapabilities;
  /**
   * Where per-application configuration lives for the current user.
   *
   * `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` (or `~/.config`) on Linux.
   * Named on the seam rather than derived at each call site because it is the one value the
   * platform-specific paths below are all built from.
   */
  readonly machineConfigDir: string;
  /**
   * A VS Code-family editor's window state -- which workspace each window has open.
   *
   * Takes the state directory because every fork has its own (`Code`, `Cursor`, `Windsurf`,
   * `Code - Insiders`); reading the wrong one answers about a different application's windows.
   * **Returns undefined rather than a guess** when the platform's location is unknown, so a
   * caller gets a nullable it must handle instead of a path that silently reads as "no window
   * is open".
   */
  readonly vscodeWindowState: (stateDir: string) => string | undefined;
  /**
   * Hand `target` to the desktop, optionally naming the application to open it with.
   *
   * Returns false when it could not be done -- including when the capability is false, so a
   * caller that forgot to check gets a refusal rather than an exception.
   */
  readonly openExternally: (target: string, app?: string) => boolean;
  /**
   * Whether an application of that DISPLAY NAME is installed, without launching it.
   *
   * The read-only twin of `openExternally`'s `app` argument, and gated by the same
   * `openApplicationByName` capability -- so it has exactly the reach that call does. That is the
   * whole point of it existing: `editor/jetbrains.ts` answered "is it installed?" with
   * `existsSync('/Applications/<name>.app')` while answering "open it" with `open -a <name>`,
   * and `hangar open` checks the first before doing the second. The narrow answer therefore
   * gated the wide one, and it did so in precisely the case the wide one was written for -- a
   * Toolbox install with no shell launcher, which Toolbox does not put under `/Applications`.
   *
   * Returns false when the capability is false, like `openExternally`, so a caller that forgot
   * to check gets a refusal rather than an exception.
   */
  readonly applicationExists: (app: string) => boolean;
  /**
   * Close the window of `app` whose title contains `titleContains`.
   *
   * Matched on the TITLE because that is the only handle another application's windows offer
   * from outside, and it is a usable one here: the generated `*.code-workspace` puts the clone's
   * name at the front of `window.title`, so the clone IS the title's first field.
   *
   * Every window that matches is closed, not just the first -- two windows on one clone is a
   * state `open` works to prevent but cannot rule out, and closing one of them would leave the
   * command reporting success while the clone is still open.
   *
   * Returns an outcome rather than a boolean, and returns `unsupported` rather than throwing
   * when the capability is false, so a caller that forgot to check gets a refusal it can print.
   */
  readonly closeAppWindow: (app: string, titleContains: string) => AppWindowOutcome;
  /**
   * How to tell someone to install `pkg`, as one line.
   *
   * A hint, deliberately, and not a command this CLI runs: Linux has no single package manager
   * and guessing one wrong is worse than naming three.
   */
  readonly installHint: (pkg: string) => string;
};
