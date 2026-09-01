import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run } from './exec.ts';

/**
 * Finding what is actually running in a clone.
 *
 * Two things matter to the fleet: a live Claude Code session (so `orch-util sync` can warn it
 * before rewriting the branch under its feet) and a live dev server (so `remove-clone`
 * refuses to delete a clone that is still serving).
 */
export type ClaudeSession = {
  readonly pid: number;
  readonly cwd: string;
  /** e.g. `ttys004`. Undefined for an IDE-hosted session, which has no terminal to write to. */
  readonly tty: string | undefined;
};

type PsRow = { pid: number; tty: string | undefined; comm: string };

const psRows = (): PsRow[] => {
  const res = run('ps', ['-axo', 'pid=,tty=,comm=']);
  if (!res.ok) return [];
  const rows: PsRow[] = [];
  for (const line of res.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2] || match[3] === undefined) continue;
    rows.push({
      pid: Number.parseInt(match[1], 10),
      tty: match[2] === '??' ? undefined : match[2],
      comm: match[3].trim(),
    });
  }
  return rows;
};

/** Working directory of each pid, in one lsof call rather than one per process. */
const cwdsOf = (pids: readonly number[]): Map<number, string> => {
  const found = new Map<number, string>();
  if (pids.length === 0) return found;
  const res = run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']);
  let current: number | undefined;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('p')) current = Number.parseInt(line.slice(1), 10);
    else if (line.startsWith('n') && current !== undefined) found.set(current, line.slice(1));
  }
  return found;
};

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

/**
 * Live Claude Code sessions whose working directory is inside `clonePath`. A session started
 * in `angular/` counts -- it is the same clone, and a rebase disturbs it just as much.
 */
export const claudeSessionsIn = (clonePath: string): ClaudeSession[] => {
  const candidates = psRows().filter((r) => basename(r.comm) === 'claude');
  const cwds = cwdsOf(candidates.map((r) => r.pid));
  const sessions: ClaudeSession[] = [];
  for (const row of candidates) {
    const cwd = cwds.get(row.pid);
    if (cwd === undefined || !isInside(cwd, clonePath)) continue;
    sessions.push({ pid: row.pid, cwd, tty: row.tty });
  }
  return sessions;
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type RunningServer = { readonly name: string; readonly pid: number };

/**
 * Dev servers a clone has running, from its own `tmp/*.pid` files -- which is exactly why
 * `tmp/` must stay a real per-clone directory and is never shared across the fleet.
 */
export const runningServersIn = (clonePath: string): RunningServer[] => {
  const tmp = join(clonePath, 'tmp');
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch {
    return [];
  }
  const servers: RunningServer[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.pid')) continue;
    try {
      const pid = Number.parseInt(readFileSync(join(tmp, entry), 'utf8').trim(), 10);
      if (!Number.isNaN(pid) && isAlive(pid)) {
        servers.push({ name: entry.replace(/\.pid$/, ''), pid });
      }
    } catch {
      // A pid file that cannot be read is not a running server.
    }
  }
  return servers;
};
