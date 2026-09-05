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
};

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
   * How to tell someone to install `pkg`, as one line.
   *
   * A hint, deliberately, and not a command this CLI runs: Linux has no single package manager
   * and guessing one wrong is worse than naming three.
   */
  readonly installHint: (pkg: string) => string;
};
