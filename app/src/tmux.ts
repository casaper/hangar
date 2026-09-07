import type { Clone } from './fleet.ts';
import { run } from './exec.ts';
import type { Hangar } from './hangar.ts';
import { orUndefined } from './terminal/types.ts';

/**
 * tmux -- every window `hangar open` creates, and the pane a `SYNC PAUSE` lands in.
 *
 * A clone gets ONE tmux session with one window per `terminal.tabs[]` role, and the developer's
 * emulator gets one tab or window attached to it. So everything that could ever have differed
 * between emulators -- creating a window, naming it, ordering the roles, finding the clone again,
 * typing into a live session -- happens here instead, identically on macOS and on Linux, because
 * it is the same program on both.
 *
 * | Hangar          | tmux           | why                                                     |
 * | --------------- | -------------- | ------------------------------------------------------- |
 * | a clone         | a **session**  | a session is what a developer attaches to               |
 * | a `tabs[]` role | a **window**   | tmux's window list is the tab bar                       |
 * | which hangar    | the **socket** | `-L hangar-<id>`; nothing inside it has to carry the id |
 *
 * ## The socket is this hangar's own, and that is what makes the layer safe to be opinionated in
 *
 * `tmux -L hangar-<id>`. No session of the developer's own lives on that server, so prefix keys,
 * status-line format and -- the reason it has to be private -- SERVER options are this hangar's to
 * set. `extended-keys`, which is what makes Shift+Enter a newline in Claude Code, is a server
 * option, and writing one onto the server somebody keeps their own work on is not a trade this
 * tool gets to make on their behalf. Two hangars are two sockets, so one hangar mistaking
 * another's session for its own is unreachable rather than checked.
 *
 * The cost is real and is printed rather than hidden: these sessions are invisible to a bare
 * `tmux ls` and `tmux attach`. `hangar open` names the `-L` line, and so does `hangar doctor`.
 *
 * ## The session NAME is the identity
 *
 * There is nothing to stamp on a window and read back. A window can be split, renamed, or `cd`'d
 * clean out of the clone and still be that clone's window, because the session it sits in is what
 * says so -- which turns "is this clone already open" from an inference about where some shell
 * happens to be standing into `has-session`. `@hangar_clone` is set per session anyway, so a
 * session made by hand on this socket (it carries the conf's global `@hangar_id` and no
 * `@hangar_clone`) reads as foreign on a fact rather than on a heuristic.
 */

/** The private socket. It is addressable from outside the hangar, so it carries the id. */
export const tmuxSocketName = (hangarId: string): string => `hangar-${hangarId}`;

/**
 * The socket a `$TMUX` value names, or undefined when the variable is absent or malformed.
 *
 * `$TMUX` is `<socket path>,<server pid>,<session id>`, and the socket's BASENAME is what `-L`
 * takes -- so this is how a run inside a tmux tells whether it is inside THIS hangar's server or
 * the developer's own. That distinction is the whole reason a private socket is worth having:
 * being inside some tmux is not a fact about which clone, or even which fleet, is on screen.
 */
export const tmuxSocketOf = (tmuxEnv: string | undefined): string | undefined => {
  const path = (tmuxEnv ?? '').split(',')[0];
  if (path === undefined || path === '') return undefined;
  return path.split('/').pop();
};

/**
 * A clone's session name.
 *
 * `.` and `:` are replaced because they are tmux's own target separators -- `clone:1` as a target
 * means window `1` of session `clone`. Measured on tmux 3.7c: `new-session -s 'a.b'` and
 * `-s 'c:d'` are both ACCEPTED, so nothing downstream would refuse such a name; it would simply
 * become unaddressable. A rewrite here rather than a refusal, for that reason.
 */
export const tmuxSessionName = (clone: Clone): string => clone.name.replace(/[.:]/g, '_');

/**
 * How to name a session to `-t`, and it is the trailing colon that is load-bearing.
 *
 * `=` means "exact match": a target falls through exact name, then name PREFIX, then glob, so a
 * bare `clone_0` matches `clone_01`, and a hangar whose `clones.pad` somebody widened would start
 * writing options onto the wrong clone's session. Measured, with sessions `clone_01` and
 * `clone_1` both on the socket:
 *
 *     set -t 'clone_0:'  @q v   ->  succeeded, on a PREFIX match
 *     set -t '=clone_0:' @q v   ->  no such session: =clone_0:
 *
 * And the colon is why this is one helper rather than a rule per subcommand. `set-option` and
 * `new-window` take a target-PANE/-WINDOW, where the session part is only recognised before a
 * `:` -- so `set -t '=clone_01'` fails with `no such session: =clone_01` while `'=clone_01:'`
 * works. `has-session`, `list-clients` and `list-windows` accept both forms. One spelling that is
 * correct everywhere beats five call sites remembering which kind of target they are passing.
 */
export const tmuxTarget = (clone: Clone): string => `=${tmuxSessionName(clone)}:`;

/** Cosmetic. Every `-t` targets a captured `#{window_id}` or `tmuxTarget`, never this. */
export const tmuxWindowName = (clone: Clone, role: string): string => `${clone.name} ${role}`;

/**
 * `-L`, and `-f` where the invocation may START the server.
 *
 * Both are PRE-COMMAND globals, and the ordering is the whole reason this is a builder: the
 * SYNOPSIS is `tmux [-f file] [-L socket-name] [command ...]`, while `new-session`'s own `-f` is
 * "a comma-separated list of client flags". Written after the subcommand it typechecks, runs, and
 * loads no config -- and since a missing `-f` file is silently ignored too (measured: exit 0, no
 * output, session created unconfigured), nothing downstream would ever say so. That is also why
 * `hangar open` checks the conf exists itself rather than waiting for tmux to complain.
 *
 * `withConf` only on the subcommand that can start a server. The reads cannot start one --
 * measured: `has-session` and `list-sessions` on a dead socket exit 1 and leave no socket file
 * behind, which is what makes `hangar open -n` genuinely side-effect free.
 */
export const tmuxArgv = (
  hangar: Hangar,
  args: readonly string[],
  opts: { readonly withConf?: boolean } = {},
): string[] => [
  ...(opts.withConf === true ? ['-f', hangar.paths.tmuxConf] : []),
  '-L',
  tmuxSocketName(hangar.id),
  ...args,
];

/**
 * tmux's ABSOLUTE path, because the command line below is run with no shell.
 *
 * Measured, and this was the whole bug: iTerm2's `command` parameter starts the process directly
 * rather than through a shell, so it gets the application's inherited PATH -- which on this
 * machine does not include `/opt/homebrew/bin`, where tmux lives. A bare `tmux` was silently not
 * found, the tab opened empty, and nothing anywhere said so. With the absolute path a client is
 * attached before the first 100ms poll.
 *
 * `command -v` through `sh` rather than a hardcoded prefix list: tmux is at `/opt/homebrew/bin`
 * on Apple silicon, `/usr/local/bin` on Intel, `/usr/bin` on most Linux, and somewhere else
 * entirely under Nix. Cached per process -- this runs once per `open`, not once per clone.
 */
let cachedBinary: string | undefined;
export const tmuxBinary = (): string => {
  if (cachedBinary !== undefined) return cachedBinary;
  const res = run('sh', ['-c', 'command -v tmux 2>/dev/null']);
  cachedBinary = res.ok && res.stdout.trim() !== '' ? res.stdout.trim() : 'tmux';
  return cachedBinary;
};

/** Quote only what needs it, so the common line carries no quotes at all. */
/** A synchronous pause, which Node offers no other way to do. */
const sleepSync = (ms: number): void => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Intentionally empty: see `awaitClient`.
  }
};

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The command an emulator runs to put a clone's session on screen.
 *
 * One rendering for every driver, and it is an ARGV line rather than a shell script, because the
 * emulators consume it differently and only the least capable of them gets a shell:
 *
 * - **No `exec`.** iTerm2 runs this without a shell at all, so a builtin is simply not available
 *   -- measured: a `command` beginning with `exec` starts nothing and reports success. It is not
 *   needed either, since with no shell the tmux client IS the session's process and the tab
 *   closes when it detaches. Konsole and GNOME Terminal, which do wrap this in `sh -c`, append
 *   their own `; exec $SHELL` so that a tmux that refuses to start leaves something to read.
 * - **The absolute tmux path**, for the reason `tmuxBinary` records. It also settles the shell
 *   alias question by construction: there is no shell to expand an alias in.
 * - **`env -u TMUX -u TMUX_PANE`**, because on Linux the emulator child inherits this process's
 *   environment, and a set `$TMUX` makes `new-session` refuse to nest. Invisible on macOS, where
 *   the emulator comes up through the window server rather than as a child -- so exactly the kind
 *   of Linux-only failure the platform seam exists for.
 * - **`new-session -A`**, which attaches an existing session and creates one otherwise, so one
 *   string is right for a first open and for reattaching after the tab was closed. `open` always
 *   creates the session first, so the create branch is only reachable if the server died in
 *   between -- and what it produces then is a session with one unnamed window and no roles, which
 *   is why `open` waits for the client and checks the roles are still there rather than trusting
 *   this to have attached to what it built.
 */
export const attachCommand = (hangar: Hangar, clone: Clone): string =>
  [
    '/usr/bin/env',
    '-u',
    'TMUX',
    '-u',
    'TMUX_PANE',
    tmuxBinary(),
    ...tmuxArgv(hangar, ['new-session', '-A', '-s', tmuxSessionName(clone)], { withConf: true }),
  ]
    .map(shellQuote)
    .join(' ');

/** The line to print for a developer who has to get back in by hand. */
export const attachHint = (hangar: Hangar, clone: Clone): string =>
  `tmux ${tmuxArgv(hangar, ['attach', '-t', tmuxTarget(clone)]).join(' ')}`;

/**
 * One window of a clone's session -- a `terminal.tabs[]` entry resolved against the clone.
 *
 * `role` is free text because the config chooses it: nothing may match on a particular value.
 */
export type TabSpec = {
  readonly cwd: string;
  /** Command to run once the window exists, e.g. `claude`. Omit for a plain shell. */
  readonly command?: string | undefined;
  readonly clone: string;
  readonly role: string;
};

/** One session on our socket, as `list-sessions` reports it. */
export type TmuxSessionRow = {
  readonly name: string;
  /** The clone it belongs to. Undefined for a session made by hand on this socket. */
  readonly clone: string | undefined;
  readonly attached: boolean;
};

/**
 * ASCII unit separator (U+001F) between `-F` fields.
 *
 * Not `|` or a space: the fields include a `pane_tty` and a free-text role, and a role may
 * legally contain either. U+001F is what the encoding reserves for exactly this.
 */
const SEP = '\u001f';

export type TmuxServer = {
  /** tmux is on PATH at all. Everything else here is pointless without it. */
  readonly installed: () => boolean;
  /** A server is up on OUR socket. Never starts one. */
  readonly running: () => boolean;
  /**
   * The session this process is running inside, when that is a session on OUR socket.
   *
   * Undefined outside tmux, and undefined inside the developer's own tmux -- which is the answer
   * that matters. `open` uses it for one thing: not opening a second window onto the clone the
   * developer is already looking at.
   */
  readonly currentSession: () => string | undefined;
  readonly hasSession: (clone: Clone) => boolean;
  readonly sessions: () => TmuxSessionRow[];
  /**
   * Sessions naming a clone that no longer exists, with nobody attached.
   *
   * Reported, never killed: a detached session can still hold a live agent, and `remove-clone`
   * is where killing one is the point of the command rather than a side effect of a check.
   */
  readonly staleSessions: (clones: readonly Clone[]) => TmuxSessionRow[];
  /** The ttys of every client attached to this clone. Empty means nobody is looking at it. */
  readonly clientTtys: (clone: Clone) => string[];
  /**
   * Wait for a client to attach to this clone, up to `timeoutMs`. The tty, or undefined.
   *
   * `open` needs this for two reasons, and the first one is a bug it found. An emulator returns
   * as soon as it has CREATED a tab, well before the process in it has attached -- so a second
   * `hangar open` moments later saw no client, could not tell that from a genuinely detached
   * session, and opened a second tab onto the same clone. Measured: with tmux named by absolute
   * path a client appears in under 100ms, so waiting costs nothing when it works.
   *
   * The second is honesty. An emulator that opened a tab and then failed to run the line reports
   * success, and without this `open` would repeat that claim.
   */
  readonly awaitClient: (clone: Clone, timeoutMs: number) => string | undefined;
  /** The roles that already have a window in this clone's session. */
  readonly roles: (clone: Clone) => string[];
  /** Create the session on its first role's window, tagged and painted. False if tmux refused. */
  readonly createSession: (clone: Clone, first: TabSpec) => boolean;
  readonly addWindow: (clone: Clone, tab: TabSpec) => boolean;
  /** Bring one role's window forward inside the session. Cosmetic; failure is ignored. */
  readonly selectRole: (clone: Clone, role: string) => void;
  /** `SYNC PAUSE`. False when no pane on our socket is on that tty. */
  readonly sendLine: (tty: string, text: string) => boolean;
  /** One live option, for `doctor` to compare with `TMUX_SETTINGS`. */
  readonly setting: (showFlags: string, name: string) => string | undefined;
  readonly killSession: (clone: Clone) => boolean;
};

export const tmuxServer = (hangar: Hangar): TmuxServer => {
  const tmux = (
    args: readonly string[],
    opts?: { readonly withConf?: boolean },
  ): { readonly ok: boolean; readonly out: string } => {
    const res = run('tmux', tmuxArgv(hangar, args, opts));
    return { ok: res.ok, out: res.stdout.trim() };
  };

  const lines = (out: string): string[] => (out === '' ? [] : out.split('\n'));

  const readSessions = (): TmuxSessionRow[] => {
    const res = tmux([
      'list-sessions',
      '-F',
      ['#{session_name}', '#{@hangar_clone}', '#{session_attached}'].join(SEP),
    ]);
    if (!res.ok) return [];
    return lines(res.out).flatMap((line) => {
      const [name, clone, attached] = line.split(SEP);
      if (name === undefined) return [];
      return [{ name, clone: orUndefined(clone), attached: attached !== '0' }];
    });
  };

  /**
   * Run a window's command with `send-keys` rather than `new-window -- <command>`.
   *
   * A window whose command IS its process exits the moment that process does, so a `claude`
   * window would vanish on `/exit` instead of leaving the shell the developer expects to find.
   * `-l` sends the text literally, so a word like `Enter` inside it stays a word, and `--` guards
   * a command beginning with a dash; the newline is a separate `Enter` because `-l` really is
   * literal -- without it the line would sit unsent on the shell's input.
   */
  const runIn = (window: string, tab: TabSpec): void => {
    if (tab.command === undefined) return;
    tmux(['send-keys', '-t', window, '-l', '--', tab.command]);
    tmux(['send-keys', '-t', window, 'Enter']);
  };

  const tagWindow = (window: string, tab: TabSpec): void => {
    tmux(['set', '-w', '-t', window, '@hangar_role', tab.role]);
  };

  /**
   * Session-scope options: whose session this is, and its hue on the status line.
   *
   * Session scope and not the window scope the shell hook uses, for two reasons. The status bar
   * has to be right the instant the client attaches, which is before any shell has printed a
   * prompt and so before the hook has run once. And `status-left` IS a session option -- the hook
   * could only reach it with `-g`, which would have whichever clone was entered last recolour the
   * status bar of every other session on the socket.
   *
   * `@hangar_clone` needs only this one write: measured on tmux 3.7c, a session-scope user option
   * is visible from a pane-context format too (`list-panes -a -F '#{@hangar_clone}'` answered for
   * all four panes of the session), so nothing has to be written twice to keep a split pane
   * attributed to its clone.
   */
  const paintSession = (clone: Clone): void => {
    const target = tmuxTarget(clone);
    tmux(['set', '-t', target, '@hangar_clone', clone.name]);
    tmux([
      'set',
      '-t',
      target,
      'status-left',
      `#[fg=${clone.colour.main},bold] ${clone.name} #[default] `,
    ]);
  };

  return {
    installed: () => run('sh', ['-c', 'command -v tmux >/dev/null 2>&1']).ok,
    running: () => tmux(['list-sessions']).ok,
    currentSession: () => {
      if (tmuxSocketOf(process.env['TMUX']) !== tmuxSocketName(hangar.id)) return undefined;
      const res = tmux(['display-message', '-p', '#{session_name}']);
      return res.ok ? orUndefined(res.out) : undefined;
    },
    hasSession: (clone) => tmux(['has-session', '-t', tmuxTarget(clone)]).ok,
    sessions: readSessions,
    staleSessions: (clones) => {
      const alive = new Set(clones.map((clone) => clone.name));
      return readSessions().filter(
        (row) => row.clone !== undefined && !alive.has(row.clone) && !row.attached,
      );
    },
    awaitClient: (clone, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const res = tmux(['list-clients', '-t', tmuxTarget(clone), '-F', '#{client_tty}']);
        const [tty] = res.ok ? lines(res.out) : [];
        if (tty !== undefined) return tty;
        if (Date.now() >= deadline) return undefined;
        // A busy wait, deliberately: this is a synchronous CLI and 60ms of `spawnSync` latency
        // per poll is the sleep. Node has no sync sleep that is not worse than this.
        sleepSync(60);
      }
    },
    clientTtys: (clone) => {
      const res = tmux(['list-clients', '-t', tmuxTarget(clone), '-F', '#{client_tty}']);
      return res.ok ? lines(res.out) : [];
    },
    roles: (clone) => {
      const res = tmux(['list-windows', '-t', tmuxTarget(clone), '-F', '#{@hangar_role}']);
      return res.ok ? lines(res.out).filter((role) => role !== '') : [];
    },
    createSession: (clone, first) => {
      /*
       * DETACHED, and the emulator attaches to it afterwards -- in that order.
       *
       * Detached is the only kind a subprocess can create: tmux attaches CLIENTS, and `hangar` is
       * not one. It also puts the server's options in place before any client arrives, which is
       * what `extended-keys` needs in order to reach the client that is about to attach.
       *
       * The window `new-session` unavoidably creates BECOMES the first role's window rather than
       * being left beside it. A spare window carrying no role is a window nothing can name.
       */
      const created = tmux(
        [
          'new-session',
          '-d',
          '-s',
          tmuxSessionName(clone),
          '-c',
          first.cwd,
          '-n',
          tmuxWindowName(clone, first.role),
          '-P',
          '-F',
          `#{session_id}${SEP}#{window_id}`,
        ],
        { withConf: true },
      );
      if (!created.ok) return false;
      const [, window] = created.out.split(SEP);
      if (window === undefined || window === '') return false;
      paintSession(clone);
      tagWindow(window, first);
      runIn(window, first);
      return true;
    },
    addWindow: (clone, tab) => {
      // `-d` so the developer still lands on the first role rather than on the last one created,
      // and `-c` sets the START directory, so nothing has to `cd`.
      const created = tmux([
        'new-window',
        '-d',
        '-t',
        tmuxTarget(clone),
        '-c',
        tab.cwd,
        '-n',
        tmuxWindowName(clone, tab.role),
        '-P',
        '-F',
        '#{window_id}',
      ]);
      if (!created.ok || created.out === '') return false;
      tagWindow(created.out, tab);
      runIn(created.out, tab);
      return true;
    },
    selectRole: (clone, role) => {
      const res = tmux([
        'list-windows',
        '-t',
        tmuxTarget(clone),
        '-F',
        `#{window_id}${SEP}#{@hangar_role}`,
      ]);
      if (!res.ok) return;
      for (const line of lines(res.out)) {
        const [window, found] = line.split(SEP);
        if (window !== undefined && found === role) {
          tmux(['select-window', '-t', window]);
          return;
        }
      }
    },
    sendLine: (tty, text) => {
      const want = tty.replace(/^\/dev\//, '');
      const res = tmux(['list-panes', '-a', '-F', `#{pane_id}${SEP}#{pane_tty}`]);
      if (!res.ok) return false;
      for (const line of lines(res.out)) {
        const [pane, found] = line.split(SEP);
        if (pane === undefined || found === undefined) continue;
        if (found.replace(/^\/dev\//, '') !== want) continue;
        if (!tmux(['send-keys', '-t', pane, '-l', '--', text]).ok) return false;
        return tmux(['send-keys', '-t', pane, 'Enter']).ok;
      }
      return false;
    },
    setting: (showFlags, name) => {
      const res = tmux(['show', showFlags, name]);
      return res.ok ? res.out : undefined;
    },
    killSession: (clone) => tmux(['kill-session', '-t', tmuxTarget(clone)]).ok,
  };
};
