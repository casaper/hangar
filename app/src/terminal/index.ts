import type { Hangar } from '../hangar.ts';
import { appleTerminalDriver } from './apple-terminal.ts';
import { gnomeTerminalDriver } from './gnome-terminal.ts';
import { iterm2Driver } from './iterm2.ts';
import { konsoleDriver } from './konsole.ts';
import { noneDriver } from './none.ts';
import type { EmulatorDriver, EmulatorKind } from './types.ts';

export * from './types.ts';

/**
 * Which emulator hosts a clone's window.
 *
 * ## Why the environment is asked first
 *
 * `hangar` is almost always typed INTO the terminal the developer wants their clone to appear in,
 * and every emulator here announces itself in the environment. That makes the environment both
 * the cheapest signal and the most likely to be right -- and it is the only honest reading of
 * "the terminal I use", because there is no system setting to consult: macOS has no default-
 * terminal preference at all, and a `.command` file would open Terminal.app for a developer who
 * lives in iTerm2.
 *
 * The case the environment cannot answer is being run from somewhere that is not a terminal the
 * fleet uses -- VS Code's integrated terminal (`TERM_PROGRAM=vscode`), a `claude -p` child, a
 * hook, cron. Those fall through to "what is installed and running", which is why detection has
 * two halves rather than one.
 *
 * `terminal.kind` in the config overrides both, and is the answer to every "it picked the wrong
 * one" report.
 *
 * ## `$TMUX` is not a signal here
 *
 * It names no emulator. Inside tmux inside iTerm2 both `$TMUX` and `ITERM_SESSION_ID` are set --
 * tmux passes the outer environment through -- so anything choosing a layer from the environment
 * alone is choosing by accident. Hangar's own server is addressed by its socket instead, which
 * makes the target explicit: whether the developer happens to be inside a tmux, and whose, has no
 * bearing on which emulator a new clone window belongs in.
 */
export const ENV_SIGNALS: readonly (readonly [string, EmulatorKind])[] = [
  // Set by the emulator itself, in every shell it starts.
  ['KONSOLE_VERSION', 'konsole'],
  ['KONSOLE_DBUS_SESSION', 'konsole'],
  ['GNOME_TERMINAL_SCREEN', 'gnome-terminal'],
  ['GNOME_TERMINAL_SERVICE', 'gnome-terminal'],
  // VTE's own marker. The generated shell hook has always keyed on it; this list had not.
  ['VTE_VERSION', 'gnome-terminal'],
  // iTerm2 sets ITERM_SESSION_ID locally and LC_TERMINAL over ssh.
  ['ITERM_SESSION_ID', 'iterm2'],
];

/** The kind the current environment names, or undefined if it names none. Pure. */
export const terminalKindFromEnv = (env: NodeJS.ProcessEnv): EmulatorKind | undefined => {
  for (const [key, kind] of ENV_SIGNALS) {
    if (env[key] !== undefined && env[key] !== '') return kind;
  }
  if (env['LC_TERMINAL'] === 'iTerm2') return 'iterm2';
  switch (env['TERM_PROGRAM']) {
    case 'iTerm.app':
      return 'iterm2';
    case 'Apple_Terminal':
      return 'apple-terminal';
    default:
      return undefined;
  }
};

/** How the emulator was chosen, for `doctor` and for error messages. */
export type TerminalSource = 'config' | 'env' | 'probe';

export type ResolvedTerminal = {
  readonly driver: EmulatorDriver;
  readonly source: TerminalSource;
  /** What the environment claimed, even when it was overridden or unrecognised. */
  readonly envSaid: string | undefined;
};

const driverFor = (kind: EmulatorKind): EmulatorDriver => {
  switch (kind) {
    case 'iterm2':
      return iterm2Driver();
    case 'apple-terminal':
      return appleTerminalDriver();
    case 'konsole':
      return konsoleDriver();
    case 'gnome-terminal':
      return gnomeTerminalDriver();
    case 'none':
      return noneDriver(undefined);
  }
};

/**
 * The order to try when the environment did not answer: the more capable emulator first.
 *
 * iTerm2 before Terminal.app because a tab there needs no Accessibility grant; Konsole before
 * GNOME Terminal because it can bring a window forward. `isAvailable` then filters -- for the mac
 * drivers that means "is it running", since AppleScript cannot address an application that is
 * not, and for the Linux ones "is it installed", since both start on demand.
 */
const PROBE_ORDER: Record<string, readonly EmulatorKind[]> = {
  darwin: ['iterm2', 'apple-terminal'],
  linux: ['konsole', 'gnome-terminal'],
};

/**
 * Pick an emulator. `kind` comes from the config; `'auto'` or undefined means detect.
 *
 * Never throws and never returns undefined: an unrecognised or absent terminal yields the `none`
 * driver, whose capabilities are all false, so the decision about what to do lands on the caller
 * that knows which capability it needed.
 */
export const resolveTerminal = (
  kind?: EmulatorKind | 'auto',
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTerminal => {
  const envSaid = terminalKindFromEnv(env) ?? env['TERM_PROGRAM'] ?? env['TERM'];

  if (kind !== undefined && kind !== 'auto') {
    return { driver: driverFor(kind), source: 'config', envSaid };
  }

  const fromEnv = terminalKindFromEnv(env);
  if (fromEnv !== undefined) {
    // Trust the environment even when the app is not answering: `isAvailable` is about being able
    // to drive it right now, and `open` reports that itself with a hint that fits.
    return { driver: driverFor(fromEnv), source: 'env', envSaid };
  }

  for (const candidate of PROBE_ORDER[process.platform] ?? []) {
    const driver = driverFor(candidate);
    if (driver.isAvailable()) return { driver, source: 'probe', envSaid };
  }
  return { driver: noneDriver(envSaid), source: 'probe', envSaid };
};

/**
 * The emulator, resolved from this hangar's config.
 *
 * The single entry point for the commands: they should not care whether the kind was configured
 * or detected.
 */
export const terminal = (hangar: Hangar): ResolvedTerminal =>
  resolveTerminal(hangar.config.terminal.kind);
