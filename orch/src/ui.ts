import { spawnSync } from 'node:child_process';

import pc from 'picocolors';

import type { Clone } from './fleet.ts';
import { paint } from './palette.ts';

/**
 * Terminal output helpers. Everything user-facing goes through here so the fleet's own
 * colour vocabulary stays consistent: a clone is always printed in its own hue, and
 * severity uses picocolors, which already no-ops when stdout is not a TTY.
 */
/**
 * `--quiet` capture, for a command a `SessionEnd` hook runs in every clone.
 *
 * Everything user-facing already goes through this module, so holding the lines here is the
 * whole mechanism: the command narrates exactly as it always does, and `releaseCapture`
 * decides afterwards whether any of it is printed. `capturedProblems` is what that decision is
 * made on -- a hook must say nothing about routine work and must never swallow a warning.
 */
let held: string[] | undefined;
let problems = 0;

const emit = (line: string): void => {
  if (held === undefined) console.log(line);
  else held.push(line);
};

export const captureOutput = (): void => {
  held = [];
  problems = 0;
};

/** How many `warn`/`fail` lines have been emitted since `captureOutput`. */
export const capturedProblems = (): number => problems;

/** Stop holding lines back, printing what was held only if `print`. */
export const releaseCapture = (print: boolean): void => {
  const lines = held ?? [];
  held = undefined;
  if (!print) return;
  for (const line of lines) console.log(line);
};

export const ok = (msg: string): void => {
  emit(`${pc.green('ok')}  ${msg}`);
};

export const warn = (msg: string): void => {
  problems += 1;
  emit(`${pc.yellow('!')}   ${msg}`);
};

/**
 * A warning that does NOT break `--quiet` silence, because the next run resolves it by itself.
 *
 * The store pass's two-minute busy guard is the case this exists for: a session ending moments
 * after a ticket was fetched leaves a copy the pass must not touch, and the `SessionEnd` hook
 * that reported it would be announcing work its own next run finishes. Interactively it is
 * still worth seeing -- somebody typed the command and is waiting for its result.
 */
export const warnTransient = (msg: string): void => {
  emit(`${pc.yellow('!')}   ${msg}`);
};

export const fail = (msg: string): void => {
  problems += 1;
  emit(`${pc.red('x')}   ${msg}`);
};

export const note = (msg: string): void => {
  emit(`    ${pc.dim(msg)}`);
};

export const heading = (msg: string): void => {
  emit(`\n${pc.bold(msg)}`);
};

export const step = (msg: string): void => {
  emit(`${pc.cyan('>')}   ${msg}`);
};

/** A blank separator line -- routed through `emit` so `--quiet` holds it back too. */
export const blank = (): void => {
  emit('');
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
    emit(line.trimEnd());
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
