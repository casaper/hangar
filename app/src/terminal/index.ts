import { CliError } from '../exec.ts';
import type { Hangar } from '../hangar.ts';
import { appleTerminalDriver } from './apple-terminal.ts';
import { gnomeTerminalDriver } from './gnome-terminal.ts';
import { iterm2Driver } from './iterm2.ts';
import { konsoleDriver } from './konsole.ts';
import { noneDriver } from './none.ts';
import { tmuxDriver } from './tmux.ts';
import type { TerminalDriver, TerminalKind } from './types.ts';

export * from './types.ts';

/**
 * Which terminal to drive.
 *
 * ## Why the environment is asked first
 *
 * `hangar` is almost always typed INTO the terminal it is being asked to drive, and every
 * emulator here announces itself in the environment. That makes the environment both the
 * cheapest signal and the most likely to be right: a machine with iTerm2 and Terminal.app both
 * installed, or KDE and GNOME both installed, has no correct answer available from the
 * filesystem, and guessing wrong means opening tabs in an application the developer is not
 * looking at.
 *
 * The exception the environment cannot answer is being run from somewhere that is not a terminal
 * the fleet uses -- VS Code's integrated terminal (`TERM_PROGRAM=vscode`), a `claude -p` child,
 * a hook, cron. Those fall through to "what is installed and running", which is why detection has
 * two halves rather than one.
 *
 * `terminal.kind` in the config overrides both, and is the answer to every "it picked the wrong
 * one" report.
 */
export const ENV_SIGNALS: readonly (readonly [string, TerminalKind])[] = [
  // Set by the emulator itself, in every shell it starts.
  ['KONSOLE_VERSION', 'konsole'],
  ['KONSOLE_DBUS_SESSION', 'konsole'],
  ['GNOME_TERMINAL_SCREEN', 'gnome-terminal'],
  ['GNOME_TERMINAL_SERVICE', 'gnome-terminal'],
  // iTerm2 sets ITERM_SESSION_ID locally and LC_TERMINAL over ssh.
  ['ITERM_SESSION_ID', 'iterm2'],
];

/** The kind the current environment names, or undefined if it names none. Pure. */
export const terminalKindFromEnv = (env: NodeJS.ProcessEnv): TerminalKind | undefined => {
  /*
   * tmux wins over every emulator signal, and it has to be tested FIRST.
   *
   * Inside tmux inside iTerm2, `ITERM_SESSION_ID` is still set -- tmux passes the outer shell's
   * environment through -- so an ordered scan that reached iTerm2 first would drive the emulator
   * and never see the multiplexer. Everything `open` and `sync` want then happens to the wrong
   * layer: a new iTerm2 TAB rather than a tmux window, and a `SYNC PAUSE` typed into the pane
   * that happens to be showing rather than the one holding the session.
   *
   * `$TMUX` is set by the tmux server in every pane and by nothing else, so its presence is the
   * fact, not a preference. `terminal.kind` in the config still overrides it.
   */
  if (env['TMUX'] !== undefined && env['TMUX'] !== '') return 'tmux';
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

/** How the terminal was chosen, for `doctor` and for error messages. */
export type TerminalSource = 'config' | 'env' | 'probe';

export type ResolvedTerminal = {
  readonly driver: TerminalDriver;
  readonly source: TerminalSource;
  /** What the environment claimed, even when it was overridden or unrecognised. */
  readonly envSaid: string | undefined;
};

const driverFor = (kind: TerminalKind, hangarId: string): TerminalDriver => {
  switch (kind) {
    case 'iterm2':
      return iterm2Driver(hangarId);
    case 'apple-terminal':
      return appleTerminalDriver(hangarId);
    case 'konsole':
      return konsoleDriver(hangarId);
    case 'gnome-terminal':
      return gnomeTerminalDriver();
    case 'tmux':
      return tmuxDriver(hangarId);
    case 'none':
      return noneDriver(undefined);
  }
};

/**
 * The order to try when the environment did not answer: richest driver first, per platform.
 *
 * iTerm2 before Terminal.app because it can do everything and Terminal.app cannot; Konsole
 * before GNOME Terminal for the same reason. `isAvailable` then filters -- for the mac drivers
 * that means "is it running", since AppleScript cannot address an application that is not, and
 * for the Linux ones "is it installed", since both start on demand.
 *
 * **tmux is first on both**, and only its `isAvailable` keeps that honest: it demands a running
 * SERVER, not just the binary. A tmux session is a tmux session whichever emulator is drawing it,
 * and driving the emulator instead would open a tab beside the multiplexer rather than a window
 * inside it. Reaching this probe at all means `$TMUX` was unset -- so this is the case where the
 * developer keeps a tmux server but ran `hangar` from somewhere outside it (a hook, a `claude -p`
 * child, VS Code's integrated terminal), and the fleet's windows belong in that server.
 */
const PROBE_ORDER: Record<string, readonly TerminalKind[]> = {
  darwin: ['tmux', 'iterm2', 'apple-terminal'],
  linux: ['tmux', 'konsole', 'gnome-terminal'],
};

/**
 * What the generated shell hook should paint.
 *
 * A plain read of the threaded config now. It used to catch an unparseable config and fall back
 * to the schema defaults on its own; that fallback is a `Hangar` field
 * (`configFellBack`) so there is one of it rather than four.
 */

/**
 * Pick a terminal driver. `kind` comes from the config; `'auto'` or undefined means detect.
 *
 * Never throws and never returns undefined: an unrecognised or absent terminal yields the `none`
 * driver, whose capabilities are all false, so the decision about what to do lands on the caller
 * that knows which capability it needed.
 */
export const resolveTerminal = (
  id: string,
  kind?: TerminalKind | 'auto',
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTerminal => {
  const envSaid = terminalKindFromEnv(env) ?? env['TERM_PROGRAM'] ?? env['TERM'];

  if (kind !== undefined && kind !== 'auto') {
    return { driver: driverFor(kind, id), source: 'config', envSaid };
  }

  const fromEnv = terminalKindFromEnv(env);
  if (fromEnv !== undefined) {
    const driver = driverFor(fromEnv, id);
    // Trust the environment even when the app is not answering: `isAvailable` is about being
    // able to drive it right now, and `open` reports that itself with a hint that fits.
    return { driver, source: 'env', envSaid };
  }

  for (const candidate of PROBE_ORDER[process.platform] ?? []) {
    const driver = driverFor(candidate, id);
    if (driver.isAvailable()) return { driver, source: 'probe', envSaid };
  }
  return { driver: noneDriver(envSaid), source: 'probe', envSaid };
};

/**
 * The terminal, resolved from this hangar's config.
 *
 * The single entry point for the commands: they should not care whether the kind was configured
 * or detected.
 */
export const terminal = (hangar: Hangar): ResolvedTerminal =>
  resolveTerminal(hangar.id, hangar.config.terminal.kind);

/**
 * The refusal a driver that cannot be typed into produces, as a NAMED error rather than a note.
 *
 * GNOME Terminal is the case this exists for, and it is not an omission anyone can close: VTE
 * exposes no API for writing into a running tab, and the generic POSIX route -- the `TIOCSTI`
 * ioctl -- has been disabled by default since Linux 6.2. So `writeToTty: false` is permanent
 * there, and permanent limitations are exactly the ones that must not read as a quiet `false`
 * in a capability record nobody prints.
 *
 * Constructed here and printed by `doctor`'s platform section, which is what makes it visible
 * BEFORE a sync rather than after one: `sync` itself degrades correctly (it reports every
 * session as missed and asks before touching the clone), and the failure this names is a
 * developer discovering at that moment that the protocol their `CLAUDE.md` describes has never
 * been available on their machine.
 */
export const syncPauseUnsupported = (driver: TerminalDriver): CliError =>
  new CliError(
    `${driver.label} cannot deliver \`SYNC PAUSE\` — it cannot be typed into`,
    driver.kind === 'gnome-terminal'
      ? 'Not a gap in this driver: VTE has no API for writing into a running tab, and TIOCSTI ' +
          'has been off by default since Linux 6.2. Run the fleet under tmux, or set ' +
          '`terminal.kind: konsole` if Konsole is what you use. `hangar sync` still works — it ' +
          'reports every live session as unreachable and asks before touching the clone.'
      : '`hangar sync` reports every live session as unreachable and asks before touching the ' +
          'clone, rather than rewriting a branch under an agent that was never told.',
  );
