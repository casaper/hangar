import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run } from './exec.ts';
import { isSharedTmpPath } from './tmp.ts';

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
  /**
   * When the process started, derived from `ps -o etime`. Undefined when that column could
   * not be parsed -- callers must treat that as "unknown", never as "not running".
   */
  readonly startedAtMs: number | undefined;
};

type PsRow = {
  pid: number;
  tty: string | undefined;
  elapsedSeconds: number | undefined;
  comm: string;
};

/** `[[dd-]hh:]mm:ss`, which is BSD `ps`'s only elapsed format -- `etimes` is silently ignored. */
const ETIME_RE = /^((?:\d+-)?(?:\d+:)?\d+:\d\d)\s+(.*)$/;

const parseEtime = (etime: string): number | undefined => {
  const dash = etime.indexOf('-');
  const days = dash === -1 ? 0 : Number.parseInt(etime.slice(0, dash), 10);
  const parts = etime
    .slice(dash + 1)
    .split(':')
    .map((n) => Number.parseInt(n, 10));
  if (Number.isNaN(days) || parts.some(Number.isNaN)) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0) + days * 86400;
};

/**
 * `ps` rows for every process. The elapsed column is parsed opportunistically: if the format
 * ever changes, the row still counts as a live process with an unknown start time. A missing
 * session is a far worse answer than a missing timestamp -- `sync` warns other agents with it.
 */
const psRows = (): PsRow[] => {
  const res = run('ps', ['-axo', 'pid=,tty=,etime=,comm=']);
  if (!res.ok) return [];
  const rows: PsRow[] = [];
  for (const line of res.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2] || match[3] === undefined) continue;
    const withEtime = ETIME_RE.exec(match[3]);
    rows.push({
      pid: Number.parseInt(match[1], 10),
      tty: match[2] === '??' ? undefined : match[2],
      elapsedSeconds: withEtime?.[1] === undefined ? undefined : parseEtime(withEtime[1]),
      comm: (withEtime?.[2] ?? match[3]).trim(),
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

/** Every live Claude Code session on this machine, with the directory it was started in. */
export const allClaudeSessions = (): ClaudeSession[] => {
  const candidates = psRows().filter((r) => basename(r.comm) === 'claude');
  const cwds = cwdsOf(candidates.map((r) => r.pid));
  const now = Date.now();
  const sessions: ClaudeSession[] = [];
  for (const row of candidates) {
    const cwd = cwds.get(row.pid);
    if (cwd === undefined) continue;
    sessions.push({
      pid: row.pid,
      cwd,
      tty: row.tty,
      startedAtMs: row.elapsedSeconds === undefined ? undefined : now - row.elapsedSeconds * 1000,
    });
  }
  return sessions;
};

/**
 * Live Claude Code sessions whose working directory is inside `clonePath`. A session started
 * in `angular/` counts -- it is the same clone, and a rebase disturbs it just as much.
 */
export const claudeSessionsIn = (clonePath: string): ClaudeSession[] =>
  allClaudeSessions().filter((s) => isInside(s.cwd, clonePath));

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type RunningServer = { readonly name: string; readonly pid: number };

/** Where `dev/pid-files.mjs` writes this clone's pid files inside the shared `tmp/`. */
export const pidDirIn = (clonePath: string): string =>
  join(clonePath, 'tmp', `_${basename(clonePath)}`);

const pidsIn = (dir: string): RunningServer[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const servers: RunningServer[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.pid')) continue;
    try {
      const pid = Number.parseInt(readFileSync(join(dir, entry), 'utf8').trim(), 10);
      if (!Number.isNaN(pid) && isAlive(pid)) {
        servers.push({ name: entry.replace(/\.pid$/, ''), pid });
      }
    } catch {
      // A pid file that cannot be read is not a running server.
    }
  }
  return servers;
};

/**
 * Dev servers a clone has running, from its pid files.
 *
 * `tmp/_<clone>/` is where a tree carrying the per-clone pid path writes. A flat `tmp/*.pid` is
 * what an older branch writes, and it is read ONLY while `tmp/` is still this clone's own
 * directory -- once `tmp/` is shared, that same file is visible from every clone and attributing
 * it here would make one clone's dev server look like a server in all of them, which
 * `remove-clone` and `status` would then act on. Flat pid files in a shared `tmp/` are reported
 * once at fleet level instead (`strayPidFilesInSharedTmp`).
 */
export const runningServersIn = (clonePath: string): RunningServer[] => [
  ...pidsIn(pidDirIn(clonePath)),
  ...(isSharedTmpPath(clonePath) ? [] : pidsIn(join(clonePath, 'tmp'))),
];
