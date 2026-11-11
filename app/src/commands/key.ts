import { readSync } from 'node:fs';
import { requireClone, type Clone } from '../fleet.ts';
import { run } from '../exec.ts';
import { git } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { KEY_TABLE, keyHelpLines } from '../keys.ts';
import { scrubbedEnv, tmuxArgv, tmuxBinary, tmuxTarget } from '../tmux.ts';

/**
 * `hangar key <action> <clone>` -- what a hangar key in a clone's tmux session runs.
 *
 * HIDDEN, and nothing about it is promised to an operator: it is the far end of `KEY_TABLE`
 * (`src/keys.ts`), and a key is how it is meant to be reached. Running one by hand does the same
 * thing and prints the same line.
 *
 * **Every action reports by itself, on the bar of the clone it acted on**, as well as on stdout.
 * A key bound with `if-shell` can only choose between two fixed lines, and an action's answer --
 * which remote failed, what git said -- is neither. So an action that could run exits 0 whatever
 * it found, having said what that was; only one that could not run at all reaches the binding's
 * failure line.
 */

/**
 * One line on the clone's bar, and the same line on stdout.
 *
 * `display-message -t` on the clone's session reaches every client attached to it, which is the
 * developer who pressed the key. A clone with no session, or no server, gets stdout only: the
 * command was run by hand.
 */
const say = (hangar: Hangar, clone: Clone, line: string): void => {
  console.log(line);
  run(tmuxBinary(), tmuxArgv(hangar, ['display-message', '-t', tmuxTarget(clone), line]), {
    env: scrubbedEnv(process.env),
  });
};

/** The first line of git's complaint, which is the one that names what went wrong. Pure. */
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? 'no output';

/**
 * What a fetch press reports. PURE.
 *
 * `--all` names every sibling clone as well as origin, because each one is a remote of every
 * other: the failure that matters there is usually a sibling, and the line says which.
 */
export const fetchReport = (
  clone: string,
  all: boolean,
  result: { readonly ok: boolean; readonly stderr: string },
): string => {
  const what = all ? 'every remote' : 'origin';
  return result.ok
    ? `${clone}: fetched ${what}`
    : `${clone}: fetch from ${what} failed -- ${firstLine(result.stderr)}`;
};

export const keyFetch = (
  hangar: Hangar,
  ref: string,
  opts: { all?: boolean | undefined },
): void => {
  const clone = requireClone(hangar, ref);
  const all = opts.all === true;
  const result = git(clone.path, ['fetch', all ? '--all' : 'origin']);
  say(hangar, clone, fetchReport(clone.name, all, result));
};

/**
 * The help table, in the popup `C-b C-k` opens, until a key is pressed.
 *
 * The clone is accepted and unused, so every key in the table runs the same way. Waiting only on a
 * terminal: a pipe has nobody to press anything, and a popup closes the moment its command exits.
 */
export const keyHelp = (): void => {
  console.log(keyHelpLines(KEY_TABLE).join('\n'));
  if (!process.stdin.isTTY) return;
  console.log('\n(any key closes this)');
  process.stdin.setRawMode(true);
  try {
    // A raw stdin can be non-blocking, and then a read with nothing typed yet is EAGAIN rather
    // than a wait.
    for (;;) {
      try {
        readSync(0, Buffer.alloc(8));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
  }
};
