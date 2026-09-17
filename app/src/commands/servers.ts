import pc from 'picocolors';

import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import type { Hangar } from '../hangar.ts';
import {
  allListeners,
  cwdsOf,
  pidFilesFor,
  processTable,
  type Listener,
  type PidFile,
  type ProcessRow,
} from '../procs.ts';
import { blank, cloneLabel, heading, note, raw, table, warn } from '../ui.ts';

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
  readonly pid: number;
  readonly port: number | undefined;
  /** Undefined when `lsof` could not answer for this pid -- never read as "somewhere else". */
  readonly cwd: string | undefined;
  readonly command: string | undefined;
  /** The parent's command line, which is how an editor's own helper is recognised. */
  readonly parent: string | undefined;
  /** The pid file that names this process, for the states that have one. */
  readonly pidFile: string | undefined;
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
  const ownerOfPort = new Map<number, { clone: Clone; role: string }>();
  for (const clone of clones) {
    for (const entry of clone.ports) {
      ownerOfPort.set(entry.port, { clone, role: entry.role.id });
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
      records.push({ ...base, state: 'crossed', port: listener.port, tookPortOf: owner.clone });
      continue;
    }
    records.push({ ...base, state: 'serving', port: listener.port });
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

/** Long enough to identify a server, short enough that a table stays a table. */
const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, width - 1)}\u2026`;

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

const PAINT: Record<ServerState, (text: string) => string> = {
  untracked: pc.yellow,
  stray: pc.magenta,
  crossed: pc.red,
  serving: pc.green,
  silent: pc.dim,
  recycled: pc.yellow,
  stale: pc.dim,
};

/** One table row for a record. PURE, and the only place a state is spelled for a human. */
export const serverRow = (record: ServerRecord): string[] => [
  PAINT[record.state](record.state),
  record.name,
  record.port === undefined ? pc.dim('—') : String(record.port),
  `pid ${String(record.pid)}`,
  record.command === undefined ? pc.dim('(gone)') : clip(shortCommand(record.command), 76),
];

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

  for (const clone of clones) {
    const mine = shown.filter((r) => r.clone.index === clone.index);
    if (mine.length === 0) continue;
    heading(cloneLabel(clone));
    table(mine.map(serverRow));
    for (const record of mine) {
      for (const line of serverDetail(record)) note(`pid ${String(record.pid)}: ${line}`);
    }
    blank();
  }

  for (const line of serversSummary(shown, scan.scanned)) {
    if (scan.scanned) raw(line);
    else warn(line);
  }
};
