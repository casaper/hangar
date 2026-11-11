import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, run } from './exec.ts';

/**
 * `fzf`, for the pickers the hangar keys open in a tmux popup.
 *
 * **Found without trusting PATH.** A popup's shell inherits the tmux SERVER's environment, and a
 * server the terminal emulator started has launchd's `/usr/bin:/bin:/usr/sbin:/sbin` -- the case
 * `TmuxServer.ensureNodeOnPath` exists for. So PATH is asked first and Homebrew's two prefixes and
 * `/usr/bin` after it, the same places `.envrc.hangar` looks.
 */
const FZF_FALLBACKS = (): string[] => [
  ...(process.env['HOMEBREW_PREFIX'] ? [join(process.env['HOMEBREW_PREFIX'], 'bin', 'fzf')] : []),
  '/opt/homebrew/bin/fzf',
  '/usr/local/bin/fzf',
  '/usr/bin/fzf',
];

let cachedFzf: string | null | undefined;
export const fzfBinary = (): string | undefined => {
  if (cachedFzf !== undefined) return cachedFzf ?? undefined;
  const onPath = run('sh', ['-c', 'command -v fzf 2>/dev/null']);
  const found =
    onPath.ok && onPath.stdout.trim() !== ''
      ? onPath.stdout.trim()
      : FZF_FALLBACKS().find((path) => existsSync(path));
  cachedFzf = found ?? null;
  return found;
};

export type PickOptions = {
  /** Shown before the query, e.g. `clone_02 edit> `. */
  readonly prompt: string;
  /** One line above the list saying what Enter does. */
  readonly header: string;
};

/**
 * Show `rows` in fzf and return the chosen row, or undefined when the picker was left with Esc.
 *
 * The candidates go in on stdin and the choice comes out on stdout; fzf draws on `/dev/tty`
 * itself, which is the popup -- so stderr may stay piped. With no query fzf lists the rows in
 * input order, and `--tiebreak=index` keeps that order among equal matches, so a first row
 * standing for "the whole thing" is what Enter picks before anything is typed.
 */
export const pick = (rows: readonly string[], opts: PickOptions): string | undefined => {
  const fzf = fzfBinary();
  if (fzf === undefined) {
    throw new CliError(
      'fzf is not installed',
      '`brew install fzf` gives the hangar keys a picker.',
    );
  }
  const res = run(
    fzf,
    [
      '--layout=reverse',
      '--tiebreak=index',
      '--no-multi',
      `--prompt=${opts.prompt}`,
      `--header=${opts.header}`,
    ],
    { input: `${rows.join('\n')}\n` },
  );
  // 1 is "no match", 130 is Esc or C-c: both are a person changing their mind, not a failure.
  if (!res.ok) return undefined;
  const chosen = res.stdout.trim();
  return chosen === '' ? undefined : chosen;
};
