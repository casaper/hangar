import { spawnSync } from 'node:child_process';

import pc from 'picocolors';

import type { Clone } from './fleet.ts';
import { paint } from './palette.ts';

/**
 * Terminal output helpers. Everything user-facing goes through here so the fleet's own
 * colour vocabulary stays consistent: a clone is always printed in its own hue, and
 * severity uses picocolors, which already no-ops when stdout is not a TTY.
 */
export const ok = (msg: string): void => {
  console.log(`${pc.green('ok')}  ${msg}`);
};

export const warn = (msg: string): void => {
  console.log(`${pc.yellow('!')}   ${msg}`);
};

export const fail = (msg: string): void => {
  console.log(`${pc.red('x')}   ${msg}`);
};

export const note = (msg: string): void => {
  console.log(`    ${pc.dim(msg)}`);
};

export const heading = (msg: string): void => {
  console.log(`\n${pc.bold(msg)}`);
};

export const step = (msg: string): void => {
  console.log(`${pc.cyan('>')}   ${msg}`);
};

const BULLET = '●';
const ELLIPSIS = '…';

/**
 * A clone's identity, always in its own hue -- the fleet's core visual convention.
 *
 * It prints the INDEX, not the directory name. A clone is addressed as `1`
 * (`orch-util status 1`), so that is how it is shown. Anything naming a DIRECTORY keeps the
 * padded `clone_NN` form -- `status`'s `dir` row, the git remote names, the generated
 * per-clone files, and the messages `sync` types into another clone's live session -- because
 * those are paths you can act on rather than an identity you type.
 */
export const cloneLabel = (clone: Clone): string => paint(clone.colour, `${BULLET} ${clone.index}`);

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Column widths must ignore colour escapes, or every coloured cell misaligns. */
export const visibleWidth = (s: string): number => s.replace(ANSI, '').length;

/** Render a table with left-aligned, padded columns. */
export const table = (rows: readonly (readonly string[])[], gap = 2): void => {
  if (rows.length === 0) return;
  const columns = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < columns; i += 1) {
    widths.push(Math.max(...rows.map((r) => visibleWidth(r[i] ?? ''))));
  }
  for (const row of rows) {
    const line = row
      .map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - visibleWidth(cell))))
      .join(' '.repeat(gap));
    console.log(line.trimEnd());
  }
};

export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}${ELLIPSIS}`;

/**
 * Ask a yes/no question on the controlling terminal.
 *
 * Reads from /dev/tty rather than stdin so a piped invocation still prompts the human, and
 * fails CLOSED (returns false) when there is no terminal at all -- an unattended `orch-util sync`
 * must never take a destructive branch by default.
 */
export const confirm = (question: string): boolean => {
  const res = spawnSync(
    'bash',
    ['-c', 'exec </dev/tty; read -r -p "$1 [y/N] " answer; printf %s "$answer"', 'bash', question],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
  );
  if (res.status !== 0 || typeof res.stdout !== 'string') return false;
  return /^y(es)?$/i.test(res.stdout.trim());
};
