import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run } from './exec.ts';
import type { Clone } from './fleet.ts';

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
  /** The whole command line, `args=`. */
  args: string;
  /** `basename(argv[0])` -- what a process is USUALLY matched on here. */
  argv0: string;
  /** The tty column exactly as `ps` printed it, kept only so the diagnostic can report it. */
  ttyRaw: string;
};

/**
 * `[[dd-]hh:]mm:ss`. BSD `ps`'s only elapsed format -- `etimes` is silently ignored there -- and
 * procps's default for `etime` as well, so one regex covers both.
 */
const ETIME_RE = /^((?:\d+-)?(?:\d+:)?\d+:\d\d)\s+(.*)$/;

/**
 * The no-tty marker, which is spelled DIFFERENTLY by the two `ps` implementations.
 *
 * BSD `ps` (macOS) prints `??`; procps (Linux) prints `?`. The check used to be `=== '??'`
 * alone, so on Linux every process without a controlling terminal came back with the tty
 * literally named `?` -- which is not "no tty", it is a tty that does not exist. `status` would
 * print `on ?`, and `sync` would try to deliver `SYNC PAUSE` to `/dev/?`. Verified for `??` on
 * this machine; the `?` half is from procps's documented output and is the one thing here a
 * first Linux run should confirm.
 */
const isNoTty = (field: string): boolean => field === '??' || field === '?' || field === '-';

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
 *
 * **`args=` rather than `comm=`, and it must stay LAST.** Two reasons, one certain and one open:
 *
 * - The certain one is parsing. `args` is the only column that can contain spaces, so as the
 *   final column it needs no quoting rule at all -- everything after the elapsed time is the
 *   command line. `comm` is space-free on both implementations, but it is also *truncated*
 *   (BSD `ps` caps it), and a truncated name is a name that stops matching.
 * - The open one is what a Claude Code process is even CALLED on Linux. Matching happens on
 *   `argv0` below, which is `claude` here -- verified on this machine, where `ps -axo args=`
 *   prints `claude --settings …`. Whether procps reports the same for a Claude Code process is
 *   **unverified**, because nothing in this fleet runs Linux. If it does not, every Linux hangar
 *   sees zero sessions, `sync --all` stops skipping busy clones and the whole `SYNC PAUSE`
 *   protocol goes quiet -- silently, since "no sessions" is also what a genuinely idle machine
 *   looks like. `claudeSessionDiagnostic()` below exists to make that visible on a first run
 *   rather than leaving it to be discovered by a rebase landing under a live agent.
 */
const psRows = (): PsRow[] => {
  const res = run('ps', ['-axo', 'pid=,tty=,etime=,args=']);
  if (!res.ok) return [];
  const rows: PsRow[] = [];
  for (const line of res.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2] || match[3] === undefined) continue;
    const withEtime = ETIME_RE.exec(match[3]);
    const args = (withEtime?.[2] ?? match[3]).trim();
    rows.push({
      pid: Number.parseInt(match[1], 10),
      tty: isNoTty(match[2]) ? undefined : match[2],
      elapsedSeconds: withEtime?.[1] === undefined ? undefined : parseEtime(withEtime[1]),
      args,
      argv0: basename(args.split(/\s+/)[0] ?? ''),
      ttyRaw: match[2],
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

/**
 * How a Claude Code process is recognised in the process table.
 *
 * One rule, deliberately: `basename(argv[0]) === 'claude'`. Anything looser -- matching `node`
 * and then sniffing the arguments, say -- would be guessing at a shape nobody here has seen, and
 * a wrong guess costs more than a miss does: a false positive makes `sync` skip a clone that is
 * NOT busy, and `remove-clone` refuse a deletion nobody can explain.
 */
const CLAUDE_ARGV0 = 'claude';

const isClaudeRow = (row: PsRow): boolean => row.argv0 === CLAUDE_ARGV0;

/** Every live Claude Code session on this machine, with the directory it was started in. */
export const allClaudeSessions = (): ClaudeSession[] => {
  const candidates = psRows().filter(isClaudeRow);
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
 * What the session detector actually saw -- the answer to "why does this machine report no
 * sessions", printed by `hangar doctor`.
 *
 * This exists because the failure it describes is INVISIBLE. A `ps` whose output this code does
 * not recognise produces zero sessions, and zero sessions is also what a machine with no Claude
 * Code running produces; there is no error, no empty-result marker, nothing to notice. On macOS
 * the detector is verified. On Linux nothing here has ever run, so the honest deliverable is not
 * a claim that it works -- it is a row that says how many rows `ps` returned, how many matched,
 * and, when none did, which command names came CLOSE. A first `hangar doctor` on Linux then
 * answers the question empirically, in one line, without anyone reading this file.
 *
 * `nearMisses` is the load-bearing field: a process whose command line mentions `claude` but
 * whose `argv[0]` is `node` is exactly the shape that would break Linux, and naming it is what
 * turns a guess into a bug report. It never widens the match itself -- see `CLAUDE_ARGV0`.
 */
export type ClaudeSessionDiagnostic = {
  /** False when `ps` itself failed, which is a different problem from finding nothing. */
  readonly psOk: boolean;
  readonly rows: number;
  readonly matched: number;
  /** Of the matched rows, how many `lsof` could give a working directory for. */
  readonly withCwd: number;
  /** Distinct `argv[0]` names of rows that mention `claude` but did not match. */
  readonly nearMisses: readonly string[];
  /** The no-tty spellings this `ps` used, e.g. `??` on BSD and `?` on procps. */
  readonly noTtyMarkers: readonly string[];
};

export const claudeSessionDiagnostic = (): ClaudeSessionDiagnostic => {
  const res = run('ps', ['-axo', 'pid=,tty=,etime=,args=']);
  const rows = psRows();
  const matched = rows.filter(isClaudeRow);
  const near = new Set<string>();
  for (const row of rows) {
    if (isClaudeRow(row)) continue;
    if (row.args.toLowerCase().includes('claude')) near.add(row.argv0);
  }
  const markers = new Set<string>();
  for (const row of rows) if (row.tty === undefined) markers.add(row.ttyRaw);
  return {
    psOk: res.ok,
    rows: rows.length,
    matched: matched.length,
    withCwd: cwdsOf(matched.map((r) => r.pid)).size,
    nearMisses: [...near].sort(),
    noTtyMarkers: [...markers].sort(),
  };
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

export type RunningServer = {
  /** The pid file's stem, or the role id for a listener. */
  readonly name: string;
  readonly pid: number;
  /** Which mechanism found it -- printed, because the two answer different questions. */
  readonly how: 'pid file' | 'port';
  /** The listening port, for a server found that way. */
  readonly port?: number | undefined;
};

/**
 * What a scan of one clone found, and whether both halves could be asked.
 *
 * `portsChecked: false` is the whole reason this is a record rather than an array. "No servers
 * running" and "nobody could tell me" are the same empty list, and `remove-clone` turns the
 * first into a deletion. See `runningServersIn`.
 */
export type ServerScan = {
  readonly servers: readonly RunningServer[];
  readonly portsChecked: boolean;
};

/**
 * Which of these ports has something LISTENING on it, and what its pid is.
 *
 * One `lsof` for every port asked about: `-i` flags OR together, so a clone's whole port set
 * costs one spawn. `-Fp -Fn` is the machine-readable form -- `p<pid>` starts a process block and
 * `n<host>:<port>` names each of its files -- which avoids parsing a column layout that differs
 * between lsof builds.
 *
 * Returns undefined when `lsof` could not be run at all. That is deliberately distinct from an
 * empty map: an absent `lsof` means the question was never asked, and reporting that as "nothing
 * is listening" is how a guard stops guarding without anyone noticing.
 */
export const listenersOn = (ports: readonly number[]): Map<number, number> | undefined => {
  const found = new Map<number, number>();
  if (ports.length === 0) return found;
  const res = run('lsof', [
    '-nP',
    ...ports.map((port) => `-iTCP:${String(port)}`),
    '-sTCP:LISTEN',
    '-Fpn',
  ]);
  /*
   * `code === -1` is the missing-tool signal, and nothing else is.
   *
   * lsof exits 1 with empty stdout and empty stderr when NOTHING is listening -- byte for byte
   * what a binary that does not exist produces through `run`, except for the exit code, which
   * `run` reports as -1 for a spawn that never started. Verified both ways on this machine. Any
   * looser test ("failed and printed nothing") reads an idle machine as a broken one, which
   * would make `remove-clone` refuse every deletion.
   */
  if (res.code === -1) return undefined;
  const wanted = new Set(ports);
  let pid: number | undefined;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number.parseInt(line.slice(1), 10);
      continue;
    }
    if (!line.startsWith('n') || pid === undefined) continue;
    const port = Number.parseInt(line.slice(line.lastIndexOf(':') + 1), 10);
    if (wanted.has(port) && !found.has(port)) found.set(port, pid);
  }
  return found;
};

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
        servers.push({ name: entry.replace(/\.pid$/, ''), pid, how: 'pid file' });
      }
    } catch {
      // A pid file that cannot be read is not a running server.
    }
  }
  return servers;
};

/**
 * Dev servers a clone has running: its pid files, AND anything listening on its ports.
 *
 * The pid files come first and are read from both places unconditionally -- `tmp/` is the
 * clone's OWN directory (only the cache entries in it are symlinks into the fleet store), so a
 * flat `tmp/<name>.pid` and a scoped `tmp/_<clone>/<name>.pid` are equally this clone's, and
 * which of the two a clone writes is whatever its checked-out branch does.
 *
 * **The port half exists because the pid-file half is a convention of one repo.** `*.pid` files
 * are written by this app repo's own `dev/run-with-pid.mjs`; a repo that starts its servers any
 * other way writes none, so `status` reported "none running" forever and -- far worse --
 * `remove-clone`'s refusal to delete a clone that is still serving silently stopped protecting
 * anything. A port with a listener is the answer that needs no cooperation from the repo, and
 * the clone's ports are a pure function of its index, so there is nothing to configure.
 *
 * Both halves, not one: a listener answers "is this clone serving" and a pid file answers "what
 * is it called and how do I stop it", and only the pid file survives a server bound to a port
 * this hangar did not assign. A pid file wins when both name the same process, so the developer
 * gets the name they can kill.
 */
export const runningServersIn = (clone: Clone): ServerScan => {
  const byPid = [...pidsIn(pidDirIn(clone.path)), ...pidsIn(join(clone.path, 'tmp'))];
  const known = new Set(byPid.map((s) => s.pid));
  const listeners = listenersOn(clone.ports.map((entry) => entry.port));
  const servers = [...byPid];
  if (listeners !== undefined) {
    for (const entry of clone.ports) {
      const pid = listeners.get(entry.port);
      if (pid === undefined || known.has(pid)) continue;
      servers.push({ name: entry.role.id, pid, how: 'port', port: entry.port });
    }
  }
  return { servers, portsChecked: listeners !== undefined };
};
