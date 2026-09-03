import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run } from './exec.ts';

/**
 * Finding what is actually running in a clone.
 *
 * Two things matter to the fleet: a live Claude Code session (so `hangar sync` can warn it
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

/** The short form `ps` prints: `ttys004` from `/dev/ttys004`, `pts/3` from `/dev/pts/3`. */
const shortTty = (tty: string): string => tty.replace(/^\/dev\//, '');

/**
 * Where the SHELL on each of these ttys is standing.
 *
 * This exists for the terminal drivers that can list their tabs but cannot label them --
 * Terminal.app and Konsole, which have no equivalent of iTerm2's per-session user variables. A
 * tab Hangar did not open is only interesting for one question ("is some window already sitting
 * in this clone?"), and answering it needs the tab's directory; the emulators hand out a tty and
 * nothing else, so the mapping is done here from the process table.
 *
 * Which process on the tty? The TOPMOST one -- the row whose parent is not itself on this tty,
 * which is the login shell. Not the deepest: the shell's cwd is what a `cd` moves and what the
 * developer means by "where that tab is", whereas the frontmost child is as likely to be a pager
 * standing wherever it was launched. A tty with no such row (unusual, but a reparented process
 * would do it) falls back to its lowest pid, which is the oldest process on it.
 *
 * One `ps` and one `lsof` for every tty asked about, because `open` asks about all of them at
 * once and a call per tab would be slower than the AppleScript that produced the list.
 */
export const cwdByTty = (ttys: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  if (ttys.length === 0) return out;
  const wanted = new Set(ttys.map(shortTty));
  const res = run('ps', ['-axo', 'pid=,ppid=,tty=']);
  if (!res.ok) return out;

  const rows: { pid: number; ppid: number; tty: string }[] = [];
  for (const line of res.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    if (!wanted.has(match[3])) continue;
    rows.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      tty: match[3],
    });
  }

  const onTty = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = onTty.get(row.tty) ?? [];
    list.push(row);
    onTty.set(row.tty, list);
  }

  const chosen = new Map<number, string>();
  for (const [tty, list] of onTty) {
    const pids = new Set(list.map((r) => r.pid));
    const tops = list.filter((r) => !pids.has(r.ppid));
    const pick = (tops.length > 0 ? tops : list).reduce((a, b) => (a.pid <= b.pid ? a : b));
    chosen.set(pick.pid, tty);
  }

  const cwds = cwdsOf([...chosen.keys()]);
  for (const [pid, tty] of chosen) {
    const cwd = cwds.get(pid);
    if (cwd !== undefined) out.set(tty, cwd);
  }
  return out;
};

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

/** Where a branch that scopes its pid files per clone writes them. */
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
 * Both places, unconditionally: `tmp/` is the clone's OWN directory (only the cache entries in
 * it are symlinks into the fleet store), so a flat `tmp/<name>.pid` and a scoped
 * `tmp/_<clone>/<name>.pid` are equally this clone's -- which of the two a clone writes is
 * whatever its checked-out branch does, and nothing here needs to care.
 */
export const runningServersIn = (clonePath: string): RunningServer[] => [
  ...pidsIn(pidDirIn(clonePath)),
  ...pidsIn(join(clonePath, 'tmp')),
];
