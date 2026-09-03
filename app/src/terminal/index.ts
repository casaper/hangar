import { basename, join } from 'node:path';

import { CONFIG_FILENAME, loadConfigFile } from '../config/load.ts';
import { terminalSchema } from '../config/schema.ts';
import type { TerminalColourSettings } from '../generate/terminal-sh.ts';
import { fleetRoot } from '../paths.ts';
import { appleTerminalDriver } from './apple-terminal.ts';
import { gnomeTerminalDriver } from './gnome-terminal.ts';
import { iterm2Driver } from './iterm2.ts';
import { konsoleDriver } from './konsole.ts';
import { noneDriver } from './none.ts';
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
 */
const PROBE_ORDER: Record<string, readonly TerminalKind[]> = {
  darwin: ['iterm2', 'apple-terminal'],
  linux: ['konsole', 'gnome-terminal'],
};

/**
 * The hangar's id, for namespacing the tags a driver writes into a terminal.
 *
 * Read straight from the config file rather than taken as a parameter, because the terminal
 * drivers are reached from three commands and threading one string through all of them buys
 * nothing until `loadHangar()` is threaded properly (it becomes a `Hangar` field then). A config
 * that will not parse falls back to the directory name, which is what `hangar setup` derives the
 * id from anyway -- so the tabs still get tagged distinctly from a neighbouring hangar's.
 */
export const currentHangarId = (): string => {
  try {
    return loadConfigFile(join(fleetRoot, CONFIG_FILENAME)).id;
  } catch {
    // Only a config too broken to PARSE reaches here -- an absent one is already refused by the
    // gate in `cli.ts`. Falling back to the directory name keeps `open` working; `doctor` and
    // `config validate` are what report the file.
    return basename(fleetRoot);
  }
};

/**
 * What the generated shell hook should paint, from this hangar's config.
 *
 * The defaults come from the schema rather than being repeated here, so there is one authority
 * for them.
 */
export const terminalColourSettings = (): TerminalColourSettings => {
  try {
    return loadConfigFile(join(fleetRoot, CONFIG_FILENAME)).terminal.colour;
  } catch {
    // Unparseable only; absence is refused earlier. `colours sync` regenerating with default
    // colouring is a better failure than `colours sync` refusing to run.
    return terminalSchema.parse({}).colour;
  }
};

/**
 * Pick a terminal driver. `kind` comes from the config; `'auto'` or undefined means detect.
 *
 * Never throws and never returns undefined: an unrecognised or absent terminal yields the `none`
 * driver, whose capabilities are all false, so the decision about what to do lands on the caller
 * that knows which capability it needed.
 */
export const resolveTerminal = (
  kind?: TerminalKind | 'auto',
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTerminal => {
  const id = currentHangarId();
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
export const terminal = (): ResolvedTerminal => {
  try {
    return resolveTerminal(loadConfigFile(join(fleetRoot, CONFIG_FILENAME)).terminal.kind);
  } catch {
    // Unparseable only; absence is refused earlier. Detecting the terminal is a better failure
    // than refusing to open one over a YAML typo somewhere else in the file.
    return resolveTerminal(undefined);
  }
};
