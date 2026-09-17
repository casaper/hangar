import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import pc from 'picocolors';

import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import type { Hangar } from '../hangar.ts';
import { roleUrl } from '../ports.ts';
import {
  allClaudeSessions,
  allListeners,
  cwdsOf,
  isAlive,
  listenersOn,
  pidFilesFor,
  processTable,
  type Listener,
  type PidFile,
  type ProcessRow,
} from '../procs.ts';
import { paintOn } from '../palette.ts';
import { tmuxServer } from '../tmux.ts';
import { blank, confirm, heading, note, ok, raw, table, truncate, warn } from '../ui.ts';

/**
 * `hangar servers` -- what the fleet is serving, across every clone at once.
 *
 * The fleet's own process tracking is the app repo's `dev/run-with-pid.mjs`, which writes
 * `tmp/<name>.pid` and is answerable only from inside one clone. That is the right place for it
 * and it is not what this command replaces: this one asks the question no clone can answer about
 * itself, which is what is running EVERYWHERE, and the one no pid file can answer at all, which
 * is what is running that nothing recorded.
 *
 * **The classification is the deliverable, not the listing.** A port with a listener and a pid
 * file naming it are two different facts, and the six ways they can disagree are each a different
 * problem with a different fix -- see `ServerState`. `procs.ts` already had both halves for one
 * clone (`runningServersIn`, for `status` and `remove-clone`'s guard); what is new here is asking
 * them unfiltered, attributing every answer by working directory, and saying which of the seven
 * states each one is in.
 */

/**
 * The seven ways a server and its record can stand, in the order they are reported.
 *
 * The first four are ordered by how much they want a human: something is serving that nothing
 * recorded, something is serving that was never assigned that port, something took a SIBLING's
 * port, and then everything that is simply working.
 *
 * - `untracked` -- listening on a port this clone was assigned, and no pid file names it. The
 *   tracking lost it: a wrapper hard-killed, or a server started by hand outside the wrapper.
 * - `stray` -- listening from inside a clone on a port no clone was assigned. Often legitimate
 *   and belonging to the developer's editor, which is why the parent is printed and why these are
 *   never swept up by a bulk kill.
 * - `crossed` -- listening on ANOTHER clone's assigned port. The worst state here and the hardest
 *   to see by hand: every clone's fallback port is the same base, so a clone whose direnv never
 *   loaded serves on clone 1's port, and a test run against "the dev server" then verifies the
 *   wrong checkout. A scan that only asked about ports could not tell this from `serving`,
 *   because the port is right and it is the CLONE that is wrong.
 * - `serving` -- a pid file, alive, listening. Working.
 * - `silent` -- a pid file, alive, listening on nothing. Still starting, or it lost its socket.
 * - `recycled` -- a pid file whose pid is alive but is some unrelated process that inherited the
 *   number. Never a kill target; the file is what wants removing.
 * - `stale` -- a pid file whose process is gone. What a `SIGKILL`ed wrapper leaves behind.
 */
export type ServerState =
  'untracked' | 'stray' | 'crossed' | 'serving' | 'silent' | 'recycled' | 'stale';

export type ServerRecord = {
  readonly state: ServerState;
  /** The clone this row is filed under -- where the process IS, or whose port it took. */
  readonly clone: Clone;
  /** The port role's id, or the pid file's stem when one names it. */
  readonly name: string;
  /**
   * The port ROLE this server is on, when it is on an assigned port at all.
   *
   * Separate from `name` because the two answer different questions and a selector needs both.
   * A tracked server's `name` is its pid file's stem -- whatever the repo chose to call it, which
   * is what stops it -- while its role is the hangar's own word for the port. They are routinely
   * different (`ng_serve` on the `ng` role), so `--role` matching `name` would miss every
   * correctly tracked server, which is the only kind most fleets have.
   *
   * Undefined for a `stray` (no role owns that port) and for `silent` and `stale` (no port at
   * all), which is why neither is reachable by `--role`.
   */
  readonly role: string | undefined;
  readonly pid: number;
  readonly port: number | undefined;
  /** Undefined when `lsof` could not answer for this pid -- never read as "somewhere else". */
  readonly cwd: string | undefined;
  readonly command: string | undefined;
  /** The parent's command line, which is how an editor's own helper is recognised. */
  readonly parent: string | undefined;
  /** The pid file that names this process, for the states that have one. */
  readonly pidFile: string | undefined;
  /**
   * Where to reach it, rendered from the role's own `url` template.
   *
   * Undefined for a role that declares `url: null` -- a database port, say, which a URL does not
   * describe -- and for anything with no role at all. Resolved here rather than at render time
   * because the record is where every other derived fact already lives, and because that puts it
   * inside the pure tests.
   *
   * **A `crossed` record keeps one.** The string `roleUrl` renders depends only on the template
   * and the port, so it is the same either way, but the meaning is not: that port answers from
   * the wrong clone. It stays because suppressing it would leave the one row most worth opening
   * with nothing to open, and the detail line beneath already says whose port it is.
   */
  readonly url: string | undefined;
  /** For `crossed`: the clone that was assigned this port. */
  readonly tookPortOf: Clone | undefined;
};

/** A pid file, and the clone whose `tmp/` it was read from. */
export type ClonePidFile = { readonly clone: Clone; readonly file: PidFile };

/** The states that mean "this should not be like this", which `--stale` selects. */
export const TROUBLE: readonly ServerState[] = ['untracked', 'stray', 'crossed', 'stale'];

const ORDER: readonly ServerState[] = [
  'untracked',
  'stray',
  'crossed',
  'serving',
  'silent',
  'recycled',
  'stale',
];

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

/**
 * Every server the fleet is running, classified. PURE -- the four facts are gathered by
 * `scanFleet` and handed in.
 *
 * Pure because three of the seven states cannot be produced on a real machine without
 * deliberately breaking something: `crossed` needs a clone whose direnv does not load, `recycled`
 * needs the kernel to reissue a pid number, and `stale` needs a wrapper killed with a signal it
 * cannot handle. They are the states that matter most and the states a capture can never show,
 * so they are asserted here against synthetic input instead.
 */
export const classifyServers = (
  clones: readonly Clone[],
  listeners: readonly Listener[],
  pidFiles: readonly ClonePidFile[],
  cwds: ReadonlyMap<number, string>,
  processes: ReadonlyMap<number, ProcessRow>,
): ServerRecord[] => {
  const ownerOfPort = new Map<number, { clone: Clone; role: string; url: string | undefined }>();
  for (const clone of clones) {
    for (const entry of clone.ports) {
      ownerOfPort.set(entry.port, { clone, role: entry.role.id, url: roleUrl(entry) });
    }
  }
  const listenerOf = new Map<number, Listener>();
  for (const listener of listeners) {
    if (!listenerOf.has(listener.pid)) listenerOf.set(listener.pid, listener);
  }

  const describe = (
    pid: number,
  ): { cwd: string | undefined; command: string | undefined; parent: string | undefined } => {
    const row = processes.get(pid);
    const parentRow = row === undefined ? undefined : processes.get(row.ppid);
    return { cwd: cwds.get(pid), command: row?.command, parent: parentRow?.command };
  };

  const records: ServerRecord[] = [];
  const claimed = new Set<number>();

  for (const { clone, file } of pidFiles) {
    claimed.add(file.pid);
    const seen = describe(file.pid);
    const base = {
      clone,
      name: file.name,
      role: undefined as string | undefined,
      url: undefined as string | undefined,
      pid: file.pid,
      cwd: seen.cwd,
      command: seen.command,
      parent: seen.parent,
      pidFile: file.path,
      tookPortOf: undefined,
    };
    if (!file.alive) {
      records.push({ ...base, state: 'stale', port: undefined });
      continue;
    }
    /*
     * A KNOWN cwd outside the clone, never merely an absent one. `cwdsOf` returns nothing for a
     * pid it could not read, so treating absence as "somewhere else" would turn one unlucky lsof
     * into "this server is unkillable, prune it instead" -- the guard failing in the direction
     * that costs the developer the kill they asked for.
     */
    if (seen.cwd !== undefined && !isInside(seen.cwd, clone.path)) {
      records.push({ ...base, state: 'recycled', port: undefined });
      continue;
    }
    const listener = listenerOf.get(file.pid);
    if (listener === undefined) {
      records.push({ ...base, state: 'silent', port: undefined });
      continue;
    }
    const owner = ownerOfPort.get(listener.port);
    if (owner !== undefined && owner.clone.index !== clone.index) {
      records.push({
        ...base,
        state: 'crossed',
        port: listener.port,
        role: owner.role,
        url: owner.url,
        tookPortOf: owner.clone,
      });
      continue;
    }
    records.push({
      ...base,
      state: 'serving',
      port: listener.port,
      role: owner?.role,
      url: owner?.url,
    });
  }

  for (const listener of listeners) {
    if (claimed.has(listener.pid)) continue;
    const seen = describe(listener.pid);
    const owner = ownerOfPort.get(listener.port);
    const host = clones.find((c) => seen.cwd !== undefined && isInside(seen.cwd, c.path));
    if (owner === undefined && host === undefined) continue; // Nothing to do with this fleet.
    const base = {
      pid: listener.pid,
      port: listener.port,
      role: owner?.role,
      url: owner?.url,
      cwd: seen.cwd,
      command: seen.command,
      parent: seen.parent,
      pidFile: undefined,
    };
    if (owner === undefined && host !== undefined) {
      records.push({
        ...base,
        // Named for its own program: the state column already says "stray", and what a developer
        // needs here is which of several node processes this one is.
        state: 'stray',
        clone: host,
        name: seen.command === undefined ? 'unknown' : programName(seen.command),
        tookPortOf: undefined,
      });
      continue;
    }
    if (owner === undefined) continue;
    if (host !== undefined && host.index !== owner.clone.index) {
      records.push({
        ...base,
        state: 'crossed',
        clone: host,
        name: owner.role,
        tookPortOf: owner.clone,
      });
      continue;
    }
    records.push({
      ...base,
      state: 'untracked',
      clone: owner.clone,
      name: owner.role,
      tookPortOf: undefined,
    });
  }

  return records.sort(
    (a, b) => a.clone.index - b.clone.index || ORDER.indexOf(a.state) - ORDER.indexOf(b.state),
  );
};

/**
 * The program a command line runs, without its arguments or its path.
 *
 * Cut at the first ` -` rather than at whitespace, because the thing being named is frequently an
 * application bundle whose path contains spaces -- splitting on those turns a perfectly good name
 * into its first word. What is left is a path, and its basename is what a developer recognises:
 * an editor's helper process is a hundred-flag command line whose only readable part is the
 * program at the front of it.
 */
export const programName = (command: string): string => {
  const flag = command.indexOf(' -');
  const path = (flag === -1 ? command : command.slice(0, flag)).trim();
  return path.slice(path.lastIndexOf('/') + 1) || path;
};

/**
 * A command line with its interpreter's path shortened to the program name.
 *
 * `/Users/.../fnm_multishells/1004_.../bin/node app/cli.js serve` spends sixty characters saying
 * "node" before reaching the only part that identifies the server. Column width is finite, so the
 * clip would land inside the path and the row would name nothing at all. Only a leading ABSOLUTE
 * path is touched, and only its directory part.
 */
export const shortCommand = (command: string): string => {
  if (!command.startsWith('/')) return command;
  const space = command.indexOf(' ');
  const head = space === -1 ? command : command.slice(0, space);
  return head.slice(head.lastIndexOf('/') + 1) + (space === -1 ? '' : command.slice(space));
};

/** Shown where a record has no value for a column -- no role, no port, no URL. */
const MISSING = '\u2014';

export type Align = 'left' | 'center' | 'right';

/**
 * One column of the report: its heading, how it sits in its width, and how to get it.
 *
 * **Content and colour are two steps, and the order matters.** `of` returns PLAIN text; `paint`
 * is applied afterwards, to the cell already padded to its column width. That is what lets the
 * clone badge be a solid block of hue the full width of its column instead of a smear of colour
 * around one digit -- and it is why widths here can be measured with `.length`, since nothing
 * being measured carries an escape sequence yet.
 */
export type ServerColumn = {
  readonly heading: string;
  readonly align: Align;
  readonly of: (record: ServerRecord) => string;
  readonly paint?: (record: ServerRecord, padded: string) => string;
  /** Left out unless asked for. */
  readonly optional?: boolean;
};

const PAINT: Record<ServerState, (text: string) => string> = {
  untracked: pc.yellow,
  stray: pc.magenta,
  crossed: pc.red,
  serving: pc.green,
  silent: pc.dim,
  recycled: pc.yellow,
  stale: pc.dim,
};

/**
 * The report's columns, in order. The command is LAST because it is the one that gets clipped,
 * and a clipped column can only be the last one without leaving a hole in the middle of a row.
 */
export const SERVER_COLUMNS: readonly ServerColumn[] = [
  {
    heading: 'CLONE',
    align: 'center',
    of: (r) => String(r.clone.index),
    paint: (r, padded) => paintOn(r.clone.colour, padded),
  },
  { heading: 'NAME', align: 'left', of: (r) => r.name },
  {
    heading: 'STATE',
    align: 'center',
    of: (r) => r.state,
    paint: (r, padded) => PAINT[r.state](padded),
  },
  { heading: 'PORT', align: 'right', of: (r) => (r.port === undefined ? MISSING : String(r.port)) },
  { heading: 'URL', align: 'left', of: (r) => r.url ?? MISSING },
  { heading: 'PID', align: 'right', of: (r) => String(r.pid) },
  { heading: 'ROLE', align: 'center', of: (r) => r.role ?? MISSING, optional: true },
  {
    heading: 'COMMAND',
    align: 'left',
    of: (r) => (r.command === undefined ? '(gone)' : shortCommand(r.command)),
  },
];

/** The columns this run shows. An optional one appears only when it was asked for. */
export const columnsFor = (extras: boolean): ServerColumn[] =>
  SERVER_COLUMNS.filter((column) => extras || column.optional !== true);

/** Heading row plus one plain-text row per record. PURE. */
export const serverCells = (
  columns: readonly ServerColumn[],
  records: readonly ServerRecord[],
): string[][] => [
  columns.map((column) => column.heading),
  ...records.map((record) => columns.map((column) => column.of(record))),
];

const pad = (text: string, width: number, align: Align): string => {
  const slack = Math.max(0, width - text.length);
  if (align === 'left') return text + ' '.repeat(slack);
  if (align === 'right') return ' '.repeat(slack) + text;
  const left = Math.floor(slack / 2);
  return ' '.repeat(left) + text + ' '.repeat(slack - left);
};

/**
 * Pad every cell to its column's width, clipping the last column to fit the window. PURE, and
 * plain text in and out.
 *
 * `table()` pads to the widest cell and never wraps, so one long command line makes every row run
 * past the right edge and the terminal wraps them -- which destroys the alignment a table exists
 * for. The budget is the window less the other columns and the gaps between them.
 *
 * **A budget below one empties the cell rather than calling `truncate(cell, 0)`**, which is
 * `cell.slice(0, -1)` -- the whole string but its last character, so the narrowest window would
 * otherwise produce the WIDEST output this can. Measured.
 *
 * **The guarantee is conditional on the other columns**, which have a width no clipping can go
 * under; below it the last column is empty and the table is as narrow as its columns get.
 * Promising more would mean dropping columns, which is a different report rather than a narrower
 * one. The heading is clipped with everything else -- `COMMAND` is seven characters and a window
 * narrow enough to matter has fewer to spare.
 */
export const layoutRows = (
  rows: readonly string[][],
  aligns: readonly Align[],
  width: number | undefined,
  gap = 2,
): string[][] => {
  const count = Math.max(...rows.map((row) => row.length));
  const widthOf = (index: number): number =>
    Math.max(...rows.map((row) => (row[index] ?? '').length));
  const last = count - 1;
  let clipped: readonly string[][] = rows;
  if (width !== undefined && last >= 1) {
    let used = gap * last;
    for (let i = 0; i < last; i += 1) used += widthOf(i);
    const budget = width - used;
    clipped = rows.map((row) =>
      row.map((cell, i) => (i === last ? (budget < 1 ? '' : truncate(cell, budget)) : cell)),
    );
  }
  const widths = Array.from({ length: count }, (_, i) =>
    Math.max(...clipped.map((row) => (row[i] ?? '').length)),
  );
  return clipped.map((row) => row.map((cell, i) => pad(cell, widths[i] ?? 0, aligns[i] ?? 'left')));
};

/**
 * Colour the laid-out rows: the heading dim, and each column's own `paint` on the PADDED cell.
 * PURE. Nothing here changes a cell's visible width, which is what keeps the table aligned.
 */
export const paintRows = (
  padded: readonly string[][],
  columns: readonly ServerColumn[],
  records: readonly ServerRecord[],
): string[][] => {
  const [heading = [], ...body] = padded;
  return [
    heading.map((cell) => pc.dim(cell)),
    ...body.map((row, r) =>
      row.map((cell, c) => {
        const record = records[r];
        const paintCell = columns[c]?.paint;
        return record === undefined || paintCell === undefined ? cell : paintCell(record, cell);
      }),
    ),
  ];
};

/**
 * The window's width, or undefined where there is no window.
 *
 * Undefined rather than a fallback, deliberately. `tui.ts` falls back to 80 because a picker has
 * to draw somewhere; this has the opposite obligation -- piped output has no right edge to stay
 * inside, and clipping it to an imagined 80 columns would quietly cut the command lines out of
 * `hangar servers list > somewhere`.
 */
const windowWidth = (): number | undefined => {
  const columns = process.stdout.columns;
  return typeof columns === 'number' && Number.isFinite(columns) ? columns : undefined;
};

/**
 * The lines that go UNDER a record, when it has something to say that a column cannot hold.
 * PURE. Each one names the fix, because a state nobody can act on is a state nobody reads.
 */
export const serverDetail = (record: ServerRecord): string[] => {
  const out: string[] = [];
  if (record.state === 'crossed' && record.tookPortOf !== undefined) {
    out.push(
      `this is ${record.clone.name}, serving on the port ${record.tookPortOf.name} was assigned — ` +
        `anything pointed at ${record.tookPortOf.name} is testing ${record.clone.name}`,
    );
    out.push(`its port comes from the clone's own environment; check direnv loaded in that shell`);
  }
  if (record.state === 'untracked') {
    out.push(
      `nothing records this one — it was not started through the wrapper, or the wrapper died`,
    );
  }
  if (record.state === 'stray' && record.parent !== undefined) {
    out.push(
      `started by ${programName(record.parent)} — not something to kill if that is your editor`,
    );
  }
  if (record.state === 'recycled' && record.pidFile !== undefined) {
    out.push(
      `pid ${String(record.pid)} is alive but is not this clone's — the number was reused; the file is what wants removing`,
    );
  }
  if (record.state === 'silent') {
    out.push('recorded and alive, but listening on none of this clone’s ports — still starting?');
  }
  return out;
};

/** The closing summary. PURE -- `scanned: false` is why this is not just a count. */
export const serversSummary = (records: readonly ServerRecord[], scanned: boolean): string[] => {
  if (!scanned) {
    return [
      '`lsof` could not be run, so only pid files were read.',
      'No clone here can be read as idle: a server that records nothing is exactly what this ' +
        'command is for, and that half is the half that is missing.',
    ];
  }
  const trouble = records.filter((r) => TROUBLE.includes(r.state));
  if (records.length === 0) return ['Nothing is serving in any clone.'];
  if (trouble.length === 0) return [`${String(records.length)} server(s), all accounted for.`];
  const counts = TROUBLE.map((state) => ({
    state,
    n: records.filter((r) => r.state === state).length,
  })).filter((c) => c.n > 0);
  return [
    `${String(records.length)} server(s), ${String(trouble.length)} wanting a look: ` +
      counts.map((c) => `${String(c.n)} ${c.state}`).join(', '),
  ];
};

/** What one scan of the whole fleet found. `scanned` carries `ServerScan.portsChecked`'s lesson. */
export type FleetScan = {
  readonly records: readonly ServerRecord[];
  /** False when `lsof` could not be run at all -- then "nothing running" is not an answer. */
  readonly scanned: boolean;
};

/**
 * Three subprocesses for the entire fleet: one unfiltered `lsof` for the listeners, one for the
 * working directories, one `ps`. `runningServersIn` costs one `lsof` PER CLONE and answers less,
 * which is why this is a second scanner rather than a loop over that one.
 */
export const scanFleet = (clones: readonly Clone[]): FleetScan => {
  const listeners = allListeners();
  const pidFiles: ClonePidFile[] = [];
  for (const clone of clones) {
    for (const file of pidFilesFor(clone)) pidFiles.push({ clone, file });
  }
  const pids = [
    ...new Set([...(listeners ?? []).map((l) => l.pid), ...pidFiles.map((f) => f.file.pid)]),
  ];
  const cwds = cwdsOf(pids);
  const processes = processTable();
  return {
    records: classifyServers(clones, listeners ?? [], pidFiles, cwds, processes),
    scanned: listeners !== undefined,
  };
};

export type ServersListOptions = {
  all?: boolean | undefined;
  stale?: boolean | undefined;
  roles?: boolean | undefined;
};

/** Ascending by index, each clone once -- the same shape every command here has. */
export const resolveClones = (
  hangar: Hangar,
  refs: readonly string[],
  all: boolean | undefined,
  what: string,
): Clone[] => {
  if (all === true || refs.length === 0) return discoverClones(hangar);
  const byIndex = new Map<number, Clone>();
  for (const ref of refs) {
    const clone = requireClone(hangar, ref);
    byIndex.set(clone.index, clone);
  }
  if (byIndex.size === 0)
    throw new CliError(`${what} needs a clone name, or --all`, knownClonesHint(hangar));
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

export const serversList = (
  hangar: Hangar,
  refs: readonly string[],
  opts: ServersListOptions,
): void => {
  const clones = resolveClones(hangar, refs, opts.all, 'servers list');
  const scan = scanFleet(clones);
  const shown =
    opts.stale === true ? scan.records.filter((r) => TROUBLE.includes(r.state)) : scan.records;

  if (shown.length > 0) {
    const columns = columnsFor(opts.roles === true);
    const laid = layoutRows(
      serverCells(columns, shown),
      columns.map((column) => column.align),
      windowWidth(),
    );
    table(paintRows(laid, columns, shown));
    blank();
    /*
     * The explanations go under the WHOLE table rather than under each clone, because there are
     * no longer per-clone blocks to sit in -- and keyed by pid, which is the one column that
     * names a row uniquely.
     */
    for (const record of shown) {
      for (const line of serverDetail(record)) note(`pid ${String(record.pid)}: ${line}`);
    }
    blank();
  }

  for (const line of serversSummary(shown, scan.scanned)) {
    if (scan.scanned) raw(line);
    else warn(line);
  }
};

/* ---------------------------------------------------------------- stopping one */

export type KillRefusal = { readonly record: ServerRecord; readonly why: string };

export type KillPlan = {
  /** Killable, in the order they will be signalled. */
  readonly kill: readonly ServerRecord[];
  /** Matched the selection and will not be signalled, each with the reason. */
  readonly refused: readonly KillRefusal[];
  /** Pid files naming nothing worth killing -- `servers prune` is their answer. */
  readonly prunable: readonly ServerRecord[];
};

export type KillOptions = {
  all?: boolean | undefined;
  role?: string[] | undefined;
  name?: string[] | undefined;
  pid?: string[] | undefined;
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
  yes?: boolean | undefined;
};

/**
 * Which of the scanned servers this invocation stops, and which it refuses. PURE.
 *
 * **Four guards, and every one of them is about killing the wrong process.** A pid is a small
 * integer that the kernel reissues; a `kill` aimed at a stale record reaches whatever holds that
 * number now.
 *
 * 1. **Containment.** The process's working directory must be KNOWN and inside the hangar. An
 *    unknown one refuses rather than proceeding -- this is the one guard where refusing is the
 *    safe direction, because the cost of being wrong is somebody else's process.
 * 2. **Never `recycled`.** That state IS the reissued-number case, caught by name.
 * 3. **Never a Claude Code session.** Free, since the process table is already in hand.
 * 4. **A `stray` only when named by pid.** An editor's own helper is a stray, and "stop my dev
 *    servers" does not mean "stop my editor". `--pid` is how one is asked for on purpose.
 */
export const killPlan = (
  records: readonly ServerRecord[],
  hangarRoot: string,
  claudePids: ReadonlySet<number>,
  opts: KillOptions,
): KillPlan => {
  const wantPids = new Set((opts.pid ?? []).map((p) => Number.parseInt(p, 10)));
  const roles = new Set(opts.role ?? []);
  const names = new Set(opts.name ?? []);

  const selected = records.filter((record) => {
    if (wantPids.size > 0 && wantPids.has(record.pid)) return true;
    if (wantPids.size > 0) return false;
    /*
     * `--role` matches the PORT role and `--name` the pid file's stem, because those are two
     * different words for most servers: a tracked one is `ng_serve` on the `ng` role. Matching
     * both against `name` made `--role` select nothing at all for a correctly tracked server --
     * silently, since selecting nothing is also what a clone with no such server looks like.
     */
    if (roles.size > 0 && (record.role === undefined || !roles.has(record.role))) return false;
    if (names.size > 0 && !names.has(record.name)) return false;
    return true;
  });

  const kill: ServerRecord[] = [];
  const refused: KillRefusal[] = [];
  const prunable: ServerRecord[] = [];

  for (const record of selected) {
    const named = wantPids.has(record.pid);
    if (record.state === 'stale') {
      prunable.push(record);
      continue;
    }
    if (record.state === 'recycled') {
      prunable.push(record);
      refused.push({
        record,
        why: `pid ${String(record.pid)} is alive but is not this clone's — the number was reused, so stopping it would stop something else`,
      });
      continue;
    }
    if (record.state === 'stray' && !named) {
      refused.push({
        record,
        why: `a stray is stopped only when asked for by name — \`--pid ${String(record.pid)}\`${record.parent === undefined ? '' : `; this one was started by ${programName(record.parent)}`}`,
      });
      continue;
    }
    if (claudePids.has(record.pid)) {
      refused.push({ record, why: 'this is a Claude Code session, not a server' });
      continue;
    }
    if (record.cwd === undefined) {
      refused.push({
        record,
        why: `nothing could read where pid ${String(record.pid)} is running, and a pid alone is not enough to stop it safely`,
      });
      continue;
    }
    if (!isInside(record.cwd, hangarRoot)) {
      refused.push({
        record,
        why: `pid ${String(record.pid)} is running in ${record.cwd}, outside this hangar`,
      });
      continue;
    }
    kill.push(record);
  }

  return { kill, refused, prunable };
};

/** What a confirmation has to say before anything is signalled. PURE. */
export const killWarnings = (plan: KillPlan): string[] =>
  plan.kill.map(
    (record) =>
      `${record.clone.name}: ${record.name} (pid ${String(record.pid)}${record.port === undefined ? '' : `, on ${String(record.port)}`})`,
  );

/**
 * Sleep, synchronously, without a subprocess.
 *
 * Everything in this command is synchronous -- `run` is `spawnSync` and the whole CLI is written
 * that way -- so waiting for a signal to take effect needs a blocking wait rather than a timer
 * whose callback would never run. `Atomics.wait` on a buffer nobody else touches is exactly that
 * and costs no process.
 */
const waitMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Signal one process, and say whether it actually went away. */
const stop = (record: ServerRecord, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(record.pid, signal);
  } catch {
    return !isAlive(record.pid);
  }
  for (let waited = 0; waited < 5000; waited += 100) {
    if (!isAlive(record.pid)) return true;
    waitMs(100);
  }
  return !isAlive(record.pid);
};

export const serversKill = (hangar: Hangar, refs: readonly string[], opts: KillOptions): void => {
  const clones = resolveClones(hangar, refs, opts.all, 'servers kill');
  const scan = scanFleet(clones);
  /*
   * A kill decided from a scan that could not be taken is a kill aimed at nothing. `lsof` is what
   * attributes a pid to a clone at all, so without it every containment check below would be
   * deciding on absent evidence -- which is how a guard stops guarding with everything still
   * green. `remove-clone` refuses on the same missing tool for the same reason.
   */
  if (!scan.scanned) {
    throw new CliError(
      '`lsof` could not be run, so nothing here can be stopped safely',
      'It is what says where a process is running, and stopping one without that is stopping a pid number. `hangar doctor` names how to install it.',
    );
  }

  const plan = killPlan(
    scan.records,
    hangar.root,
    new Set(allClaudeSessions().map((s) => s.pid)),
    opts,
  );

  for (const { record, why } of plan.refused) warn(`${record.clone.name}: ${record.name} — ${why}`);
  if (plan.prunable.length > 0) {
    note(
      `${String(plan.prunable.length)} pid file(s) name nothing worth stopping — \`hangar servers prune\` removes them`,
    );
  }
  if (plan.kill.length === 0) {
    note('Nothing to stop.');
    return;
  }

  heading(opts.dryRun === true ? 'Would stop' : 'Stopping');
  for (const line of killWarnings(plan)) raw(`  ${line}`);
  if (opts.dryRun === true) {
    note('(dry run — nothing was signalled)');
    return;
  }
  if (opts.yes !== true && !confirm(`Stop ${String(plan.kill.length)} server(s)?`)) {
    throw new CliError('cancelled — nothing was signalled');
  }

  const signal: NodeJS.Signals = opts.force === true ? 'SIGKILL' : 'SIGTERM';
  const survivors: ServerRecord[] = [];
  for (const record of plan.kill) {
    if (stop(record, signal))
      ok(`${record.clone.name}: ${record.name} (pid ${String(record.pid)}) stopped`);
    else {
      warn(`${record.clone.name}: ${record.name} (pid ${String(record.pid)}) is still running`);
      survivors.push(record);
    }
  }

  /*
   * The port is re-checked rather than assumed, and that is the whole reason `--force` is a
   * considered escalation instead of a reflex. A dev server commonly has children of its own --
   * a bundler, a watcher -- and whether they let go of the socket when their parent is asked to
   * stop is not something this command can know for any given repo. So it looks.
   */
  const ports = plan.kill.map((r) => r.port).filter((p): p is number => p !== undefined);
  const stillBound = ports.length === 0 ? undefined : listenersOn(ports);
  if (stillBound !== undefined && stillBound.size > 0) {
    for (const [port, pid] of stillBound) {
      warn(`port ${String(port)} is still held, now by pid ${String(pid)}`);
    }
    note(
      survivors.length > 0
        ? '`hangar servers kill --force` sends SIGKILL, which a process cannot decline.'
        : 'The server stopped but something it started still holds the port — `hangar servers list` says what.',
    );
  } else if (ports.length > 0) {
    ok(`${String(ports.length)} port(s) free again`);
  }
};

export type PruneOptions = { all?: boolean | undefined; dryRun?: boolean | undefined };

export const serversPrune = (hangar: Hangar, refs: readonly string[], opts: PruneOptions): void => {
  const clones = resolveClones(hangar, refs, opts.all, 'servers prune');
  let removed = 0;
  for (const clone of clones) {
    for (const file of pidFilesFor(clone)) {
      if (file.alive) continue;
      if (opts.dryRun === true) {
        raw(`  would remove  ${file.path} ${pc.dim(`(pid ${String(file.pid)} is gone)`)}`);
        removed += 1;
        continue;
      }
      /*
       * Re-read before unlinking, and only remove a file that STILL names the dead pid it was
       * scanned as. A server restarted between the scan and here has rewritten this file with its
       * own pid, and deleting it would leave a running server with no record -- the exact state
       * this command exists to clear up. The repo's own tooling guards its removal the same way.
       */
      try {
        const now = Number.parseInt(readFileSync(file.path, 'utf8').trim(), 10);
        if (now !== file.pid || isAlive(now)) {
          note(`${clone.name}: ${file.name} was restarted while scanning — left alone`);
          continue;
        }
        unlinkSync(file.path);
        ok(`${clone.name}: removed ${file.name}.pid (pid ${String(file.pid)} is gone)`);
        removed += 1;
      } catch {
        warn(`${clone.name}: could not remove ${file.path}`);
      }
    }
  }
  if (removed === 0) note('No pid file names a process that is gone.');
  else if (opts.dryRun === true) note('(dry run — nothing was removed)');
};

/* ---------------------------------------------------------------- starting one */

export type StartAction = {
  readonly clone: Clone;
  readonly role: string;
  readonly label: string;
  readonly port: number;
  readonly cwd: string;
  /** The line typed into the window, with the port already fixed. */
  readonly command: string;
};

export type StartSkip = { readonly clone: Clone; readonly role: string; readonly why: string };

export type StartPlan = {
  readonly start: readonly StartAction[];
  readonly skip: readonly StartSkip[];
};

/**
 * The line `servers start` types into the window, with this clone's port fixed in front of it.
 * PURE.
 *
 * **The prefix is the whole reason this command is safer than starting the server by hand.** A
 * port role's port comes from an environment variable, and every clone's fallback when that
 * variable is missing is the same base -- so a clone whose environment did not load serves on
 * clone 1's port, and anything aimed at clone 1 then tests the wrong checkout. That is the
 * `crossed` state, and it is reached by accident rather than by choice. Naming the variable in
 * front of the command makes it a property of the invocation instead of of the shell: a shell
 * assignment prefix wins over an exported value, so this is right whether or not direnv ran.
 */
export const startCommandLine = (envKey: string, port: number, command: string): string =>
  `${envKey}=${String(port)} ${command}`;

/**
 * What `servers start` would do for these clones, and what it would decline. PURE.
 *
 * `serving` is a skip and not an error: asking for a server that is already up is the natural
 * thing to type when you are not sure, and the honest answer is that it is up.
 */
export const startPlan = (
  clones: readonly Clone[],
  records: readonly ServerRecord[],
  windowsOf: (clone: Clone) => readonly string[],
  roleFilter: readonly string[] | undefined,
): StartPlan => {
  const wanted = new Set(roleFilter ?? []);
  const start: StartAction[] = [];
  const skip: StartSkip[] = [];

  for (const clone of clones) {
    const windows = new Set(windowsOf(clone));
    const busy = new Set(
      records.filter((r) => r.clone.index === clone.index).map((r) => r.port ?? 0),
    );
    for (const entry of clone.ports) {
      const role = entry.role;
      if (wanted.size > 0 && !wanted.has(role.id)) continue;
      if (role.start === undefined) {
        if (wanted.size > 0) {
          skip.push({
            clone,
            role: role.id,
            why: 'no `start` command in this hangar’s config for that role',
          });
        }
        continue;
      }
      if (busy.has(entry.port)) {
        skip.push({ clone, role: role.id, why: `already serving on ${String(entry.port)}` });
        continue;
      }
      if (windows.has(role.id)) {
        skip.push({
          clone,
          role: role.id,
          why: 'the clone already has a window for that role — look there before starting a second',
        });
        continue;
      }
      start.push({
        clone,
        role: role.id,
        label: role.label,
        port: entry.port,
        cwd: role.start.dir === '' ? clone.path : join(clone.path, role.start.dir),
        command: startCommandLine(role.envKey, entry.port, role.start.command),
      });
    }
  }
  return { start, skip };
};

export type StartOptions = {
  all?: boolean | undefined;
  role?: string[] | undefined;
  dryRun?: boolean | undefined;
};

export const serversStart = (hangar: Hangar, refs: readonly string[], opts: StartOptions): void => {
  const clones = resolveClones(hangar, refs, opts.all, 'servers start');
  const server = tmuxServer(hangar);
  /*
   * A session is required rather than created, and that is a boundary rather than a limitation.
   * `hangar open` builds a clone's session with every role its config declares -- the shell, the
   * agent -- and a session created here would hold one server window and none of them, after
   * which `open` finds a session already there and simply attaches to it. So the clone would
   * quietly lose its own tabs, from a command about dev servers.
   */
  const withoutSession = clones.filter((clone) => !server.hasSession(clone));
  if (withoutSession.length > 0 && !server.running()) {
    throw new CliError(
      'this hangar has no tmux server running, so there is no window to start a server in',
      `\`hangar open ${String(withoutSession[0]?.index ?? 1)}\` builds the clone's session first.`,
    );
  }

  const scan = scanFleet(clones);
  const plan = startPlan(
    clones.filter((clone) => server.hasSession(clone)),
    scan.records,
    (clone) => server.roles(clone),
    opts.role,
  );
  for (const clone of withoutSession) {
    warn(`${clone.name}: no tmux session — \`hangar open ${String(clone.index)}\` first`);
  }
  for (const item of plan.skip) note(`${item.clone.name}: ${item.role} — ${item.why}`);

  if (plan.start.length === 0) {
    note('Nothing to start.');
    return;
  }

  heading(opts.dryRun === true ? 'Would start' : 'Starting');
  for (const action of plan.start) {
    raw(`  ${action.clone.name}: ${action.label} on ${String(action.port)}`);
    raw(`    ${pc.dim(`${action.cwd} $ ${action.command}`)}`);
  }
  if (opts.dryRun === true) {
    note('(dry run — nothing was started)');
    return;
  }

  for (const action of plan.start) {
    const added = server.addWindow(action.clone, {
      cwd: action.cwd,
      command: action.command,
      clone: action.clone.name,
      role: action.role,
    });
    if (added) {
      ok(
        `${action.clone.name}: ${action.label} starting in its own window, on ${String(action.port)}`,
      );
    } else {
      warn(`${action.clone.name}: could not add a window for ${action.role}`);
    }
  }
  note(
    'A server takes a moment to bind — `hangar servers list` says when it is up, and `hangar open` puts you in the window.',
  );
};
