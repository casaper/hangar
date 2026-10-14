import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

import { claudeTranscriptsIn, headline, type ClaudeTranscript } from '../claude-sessions.ts';
import { CliError, run } from '../exec.ts';
import { discoverClones } from '../fleet.ts';
import {
  BAR_OPTIONS,
  KEY_BINDINGS,
  claudeTmuxConfArtifact,
  modeWindowFormat,
} from '../generate/claude-tmux-conf.ts';
import { applyArtifact } from '../generate/index.ts';
import type { Hangar } from '../hangar.ts';
import { MODE_COLOURS } from '../palette.ts';
import { tildify } from '../user-paths.ts';
import { claudeSocketName, tmuxBinary, tmuxSocketOf } from '../tmux.ts';
import { confirm, note, ok, step, warn } from '../ui.ts';
import { resumeChoice, type ResumeChoice } from './open.ts';

/**
 * `hangar up` -- both hangar-root modes and a shell, in one tmux window, as three tabs.
 *
 * A hangar-root session is either driving the fleet or changing the CLI, and which one it is
 * decides its permissions and its remit. This command starts a tmux session on its own socket
 * with operator in window 1, developer in window 2 and a plain shell at the hangar root in window
 * 3, and attaches the terminal you typed in to it, on the shell tab unless `--select` says
 * otherwise.
 *
 * ## The mode is the shim's, and this command only places it
 *
 * A mode is four flags plus a working directory, and `.local/bin/claude` is the one place the
 * four are written: a bare `claude` at the hangar root is operator mode and one in `app/` is
 * developer mode. Each mode tab runs that shim by absolute path from its own directory, so a tab
 * and a `claude` typed by hand are the same launch and cannot drift apart. This command takes
 * none of claude's arguments; it has options of its own.
 *
 * ## The shell tab is a third WINDOW and not a third MODE
 *
 * `Mode` stays a pair and `--select shell` is a TAB rather than a mode. Its `HANGAR_MODE` is
 * explicitly EMPTY, which is the one that would bite: a window created without that flag inherits
 * the SESSION's value, so leaving it off would badge the shell tab `OPS`.
 *
 * ## The root `CLAUDE.md` loads in both modes and cannot be suppressed
 *
 * Two flags would skip it and neither is usable. `--bare` skips `CLAUDE.md` discovery but makes
 * Anthropic auth strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`, with OAuth and the keychain
 * never read -- this machine logs in with a subscription, so a `--bare` session cannot start.
 * `--safe-mode` disables it too, along with the skills, hooks and plugins operator mode exists
 * to use. So each mode file CORRECTS the fleet map rather than replacing it, starting with "you
 * are not in a clone", which that file does not say and a hangar-root session has no other way
 * to learn.
 */

export type Mode = 'ops' | 'dev';

export const MODES: readonly Mode[] = ['ops', 'dev'];

/** Everything about a mode that is not its colour. The hue and the purpose are in `palette.ts`. */
type ModeSpec = {
  /** Where the session's working directory is -- which decides which mode the shim starts. */
  readonly dir: (hangar: Hangar) => string;
  readonly window: number;
};

/**
 * Developer mode runs in `app/` so that `app/CLAUDE.md` is loaded on turn one rather than
 * lazily, and operator mode at the root so it is not. The shim reads the same two directories.
 */
const SPECS: Readonly<Record<Mode, ModeSpec>> = {
  ops: { dir: (h) => h.root, window: 1 },
  dev: { dir: (h) => join(h.root, 'app'), window: 2 },
};

export const isMode = (value: string): value is Mode => MODES.includes(value as Mode);

/**
 * The shell tab: window 3, the hangar root, and whichever shell tmux starts by default.
 *
 * Deliberately NOT an entry in `SPECS`, because it is not a mode -- no settings file, no remit,
 * no `-n`, and no `HANGAR_MODE` (see the header). It is there so the hand-run half of fleet work
 * -- `hangar list`, `git log`, `pnpm golden` -- has somewhere to live that is not a tool call
 * inside one of the two sessions, and it is the tab a fresh `hangar up` lands on.
 */
const SHELL_WINDOW = 3;
const SHELL_NAME = 'shell';
/** What the tab is for, in the same voice as a mode's purpose. A literal: it has no hue to read. */
const SHELL_PURPOSE = 'a shell at the root';

/** The column every tab name is reported in. `shell` is the longest of the three. */
const TAB_COLUMN = 5;

export type Tab = Mode | typeof SHELL_NAME;

/** The tab selected when `--select` is absent: the one a person types into first. */
export const DEFAULT_TAB: Tab = SHELL_NAME;

/**
 * Every tab's window index, DERIVED rather than retyped.
 *
 * Exported for the one property worth asserting about it: no two tabs share an index. tmux
 * refuses `new-window -t` on an occupied one, so a collision here is a command that cannot
 * rebuild its own workspace. A hand-written copy of this table would pin itself and prove
 * nothing.
 */
export const TAB_WINDOWS: Readonly<Record<Tab, number>> = {
  ops: SPECS.ops.window,
  dev: SPECS.dev.window,
  [SHELL_NAME]: SHELL_WINDOW,
};

// ---------------------------------------------------------------------------------------------
// The pure half: each callable without a tmux server or a filesystem.
// ---------------------------------------------------------------------------------------------

/** `--select`'s value, refused rather than defaulted when it names no tab. */
export const asTab = (value: string): Tab => {
  if (isMode(value) || value === SHELL_NAME) return value;
  throw new CliError(`unknown tab "${value}" (expected ops, dev or shell)`);
};

/** `--restart`'s value, as the modes it names. The shell tab is not restartable: `exit` it. */
export const restartTargets = (value: string): readonly Mode[] => {
  if (value === 'all') return MODES;
  if (isMode(value)) return [value];
  throw new CliError(
    `cannot restart "${value}" (expected ops, dev or all)`,
    value === SHELL_NAME
      ? 'the shell tab has no claude to restart -- `exit` it and run this again'
      : undefined,
  );
};

/** The shim a mode tab runs, by absolute path. */
export const shimPath = (hangar: Hangar): string => join(hangar.root, '.local', 'bin', 'claude');

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The command a mode tab runs: the shim, by ABSOLUTE path, never a bare `claude`.
 *
 * Absolute because the tmux server inherits whatever PATH started it, and a bare name could reach
 * the real binary -- a session in no mode at all, wearing the tab's badge. The shim reads the mode
 * off the tab's working directory and puts its four flags ahead of `--resume`, which is what
 * makes a resumed tab come back INTO its mode.
 */
export const modeTabCommand = (hangar: Hangar, resumeId: string | undefined): string =>
  [shimPath(hangar), ...(resumeId === undefined ? [] : ['--resume', resumeId])]
    .map(shellQuote)
    .join(' ');

/**
 * The session a RESTARTED tab resumes: the conversation it holds right now.
 *
 * Not `resumeChoice`, whose rule is right for an absent tab and wrong here -- the session wanted
 * is live until the kill lands, so "newest, unless live" would answer `live` every time and start
 * a fresh one. This is `reload`'s rule instead: the newest LIVE transcript in the directory,
 * named before anything is killed. It over-counts as `reload`'s does -- a `claude` typed in the
 * shell tab is live at the root too -- which is why the id is printed first.
 */
export const restartChoice = (transcripts: readonly ClaudeTranscript[]): ResumeChoice => {
  let newest: ClaudeTranscript | undefined;
  for (const t of transcripts) {
    if (!t.live) continue;
    if (newest === undefined || t.lastActiveAtMs > newest.lastActiveAtMs) newest = t;
  }
  return newest === undefined ? { kind: 'none' } : { kind: 'resume', session: newest };
};

/** One line for what `--resume-last` does in one tab. Pure; `warn` picks the channel. */
export const describeTabResume = (
  mode: Mode,
  choice: ResumeChoice,
  done: boolean,
): { readonly text: string; readonly warn: boolean } => {
  const fresh = done ? 'started a fresh session' : 'would start a fresh session';
  switch (choice.kind) {
    case 'resume':
      return {
        text: `${mode}: ${done ? 'resuming' : 'would resume'} ${headline(choice.session)} (${choice.session.id.slice(0, 8)})`,
        warn: false,
      };
    case 'live':
      return {
        text: `${mode}: a claude is running in ${tildify(choice.session.cwd)} and may be its last session — ${fresh} instead`,
        warn: true,
      };
    case 'gone':
      return {
        text: `${mode}: its last session was in ${tildify(choice.session.cwd)}, which no longer exists — ${fresh} instead`,
        warn: true,
      };
    case 'none':
      return { text: `${mode}: no resumable session — ${fresh}`, warn: true };
    case 'window-exists':
    case 'no-window':
      return {
        text: `${mode}: the tab is running, so nothing is resumed — \`--restart ${mode} -r\` resumes it`,
        warn: false,
      };
  }
};

// ---------------------------------------------------------------------------------------------
// The half that touches a live server.
// ---------------------------------------------------------------------------------------------

export const SESSION = 'claude';
export const TARGET = `=${SESSION}:`;
/** U+001F, for the same reason `tmux.ts` uses it: no window name or mode can contain it. */
const SEP = '\u001f';

const trimmed = (out: string): string[] =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

export type WindowRow = {
  readonly index: number;
  readonly mode: string | undefined;
  readonly shell: boolean;
  readonly pid: string;
};

export type Server = {
  readonly socket: string;
  readonly tmux: (args: readonly string[], withConf?: boolean) => ReturnType<typeof run>;
  readonly running: () => boolean;
  readonly windows: () => WindowRow[];
  readonly clientTtys: () => string[];
};

export const server = (hangar: Hangar): Server => {
  const socket = claudeSocketName(hangar.id);
  const tmux = (args: readonly string[], withConf = false): ReturnType<typeof run> =>
    run(tmuxBinary(), [
      ...(withConf ? ['-f', hangar.paths.claudeTmuxConf] : []),
      '-L',
      socket,
      ...args,
    ]);

  return {
    socket,
    tmux,
    running: () => tmux(['has-session', '-t', TARGET]).ok,
    /**
     * Every window, keyed on its TAG -- never on the index or the name, both of which a developer
     * can change from inside tmux without meaning anything by it.
     *
     * Two tags rather than one that holds `ops | dev | shell`, and that is a migration rather
     * than a taste: renaming `@hangar_mode` would leave every window of a server that is already
     * running untagged, and the next run would try `new-window -t` on an index tmux says is
     * occupied. A second tag beside the first needs no `kill-server`.
     */
    windows: () => {
      const res = tmux([
        'list-windows',
        '-t',
        TARGET,
        '-F',
        ['#{window_index}', '#{@hangar_mode}', '#{@hangar_shell}', '#{pane_pid}'].join(SEP),
      ]);
      if (!res.ok) return [];
      return trimmed(res.stdout).flatMap((line) => {
        const [index, mode, shell, pid] = line.split(SEP);
        if (index === undefined) return [];
        return [
          {
            index: Number(index),
            mode: mode === undefined || mode === '' ? undefined : mode,
            shell: shell === 'yes',
            pid: pid ?? '',
          },
        ];
      });
    },
    /** The ttys of every attached client, so taking one over can say what it took. */
    clientTtys: () => {
      const res = tmux(['list-clients', '-t', TARGET, '-F', '#{client_tty}']);
      return res.ok ? trimmed(res.stdout) : [];
    },
  };
};

/** How long a tab's claude has been up -- the fact `--restart` has to justify itself with. */
export const uptimeOf = (pid: string): string => {
  if (pid === '') return 'an unknown time';
  const res = run('ps', ['-p', pid, '-o', 'etime=']);
  const out = res.stdout.trim();
  return res.ok && out !== '' ? out : 'an unknown time';
};

/**
 * The real `claude`, found on PATH with this hangar's own shim directory skipped.
 *
 * Nothing here runs it: every mode tab runs the shim. It is looked for so that a machine with no
 * Claude Code is told so up front -- the shim would exit 127 inside a tab, and tmux closes a
 * window whose command exits, so the tab would simply never appear. Skipping the shim's own
 * directory is what keeps that check honest: the shim is always on the hangar's PATH, and finding
 * it would answer "installed" on a machine where it is not.
 */
export const resolveClaudeBinary = (
  pathEnv: string | undefined,
  hangarRoot: string,
  // The name is a parameter so the positive case can be asserted against a binary that exists
  // on every machine this suite runs on. Nothing but a test passes it.
  name = 'claude',
): string | undefined => {
  const shim = join(hangarRoot, '.local', 'bin');
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '') continue;
    if (resolve(dir) === resolve(shim)) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

/** Identity and presentation, both at window scope, both read back by the bar. */
const tagWindow = (srv: Server, mode: Mode): void => {
  const target = `${TARGET}${String(SPECS[mode].window)}`;
  srv.tmux(['set', '-w', '-t', target, '@hangar_mode', mode]);
  srv.tmux(['set', '-w', '-t', target, '@hangar_purpose', MODE_COLOURS[mode].purpose]);
  srv.tmux(['set', '-w', '-t', target, 'window-status-current-format', modeWindowFormat(mode)]);
};

/**
 * All three windows present and each tagged. A tab that is already there is left alone; one that
 * is missing is created, with `resumes` naming the session a mode tab comes back as.
 *
 * Each lands at its own fixed index, which is what `renumber-windows off` in the conf protects.
 *
 * `-e HANGAR_MODE` on every MODE creation and never by inheritance: measured on tmux 3.7c, a
 * window created without it silently picks up the SESSION's value. The shim exports the same
 * value itself, so this is belt and braces for a mode tab -- but not for the shell tab, which
 * runs no shim and is where the inheritance would actually land.
 */
const ensureSession = (
  hangar: Hangar,
  srv: Server,
  resumes: Readonly<Partial<Record<Mode, string>>>,
): void => {
  for (const mode of MODES) {
    const spec = SPECS[mode];
    if (srv.running() && srv.windows().some((w) => w.mode === mode)) continue;

    const shared = [
      '-n',
      mode,
      '-c',
      spec.dir(hangar),
      '-e',
      `HANGAR_MODE=${mode}`,
      modeTabCommand(hangar, resumes[mode]),
    ];
    const res = srv.running()
      ? srv.tmux(['new-window', '-d', '-t', `${TARGET}${String(spec.window)}`, ...shared])
      : srv.tmux(['new-session', '-d', '-s', SESSION, ...shared], true);
    if (!res.ok) {
      throw new CliError(
        `tmux would not create the ${mode} tab`,
        (res.stderr || res.stdout).trim(),
      );
    }
    tagWindow(srv, mode);
    ok(`${mode.padEnd(TAB_COLUMN)} tab   ${MODE_COLOURS[mode].purpose}`);
  }

  // Last, and after the loop for a reason: a mode tab's is the creation that makes the session,
  // so the shell is always a `new-window` and never has to know how to be the first one.
  //
  // No command, so tmux starts `default-shell` as a login shell -- the developer's own, rather
  // than one this CLI picked for them. No per-window format either: with no hue to bake in, the
  // tab falls back to the conf's neutral entry, which says what it is.
  //
  // `-e HANGAR_MODE=` is EMPTY and not omitted, and that is measured rather than tidy. Omitting
  // it inherits the session's value -- verified by reading `printenv HANGAR_MODE` out of the
  // pane: a window created with no `-e` answered `ops`. Empty reaches `statusline.sh`'s
  // `${HANGAR_MODE:-}` as unset does. A `claude` typed here goes through the shim, which sets
  // its own.
  if (!srv.windows().some((w) => w.shell)) {
    const target = `${TARGET}${String(SHELL_WINDOW)}`;
    const res = srv.tmux([
      'new-window',
      '-d',
      '-t',
      target,
      '-n',
      SHELL_NAME,
      '-c',
      hangar.root,
      '-e',
      'HANGAR_MODE=',
    ]);
    if (!res.ok) {
      throw new CliError('tmux would not create the shell tab', (res.stderr || res.stdout).trim());
    }
    srv.tmux(['set', '-w', '-t', target, '@hangar_shell', 'yes']);
    ok(`${SHELL_NAME.padEnd(TAB_COLUMN)} tab   ${SHELL_PURPOSE}`);
  }
};

/**
 * The bar, written onto whatever server is there.
 *
 * The conf carries every one of these and is read once, when the server starts -- so this is
 * what reaches a session that was already up when the table changed. Same table, so the two
 * cannot disagree; this is the split `clone-tmux.conf` and `TmuxServer.restyle` already live on.
 */
const applyBar = (srv: Server): void => {
  for (const option of BAR_OPTIONS) srv.tmux(['set', '-g', option.name, option.value]);
  /*
   * And the key, for the same reason and with the same table -- but it has to be ISSUED rather
   * than written, because a binding is a command and there is nothing for `set` to carry it.
   * Without this line the click reaches only servers that start after the conf changed, which is
   * the half of the split that is easy to forget: the options here already close that gap and a
   * binding left out of it works for whoever last restarted and nobody else.
   */
  for (const binding of KEY_BINDINGS) srv.tmux(binding);
};

/**
 * Attach this terminal, taking the session over from any other client.
 *
 * `-d` is what makes the pair a singleton in practice: two clients on one session mirror each
 * other's window selection, so switching tabs in one moves the other and the bar appears to
 * change on its own. Detaching is recoverable in a keystroke and both sessions keep running, so
 * this needs no confirmation the way `--restart` does.
 *
 * `TMUX`/`TMUX_PANE` are unset so this works from inside another tmux, and stdio is inherited
 * because from here on the client IS this terminal.
 */
const attach = (srv: Server): void => {
  const others = srv.clientTtys();
  if (others.length > 0) warn(`detaching ${others.join(', ')} -- one client at a time`);
  const res = run(
    '/usr/bin/env',
    ['-u', 'TMUX', '-u', 'TMUX_PANE', tmuxBinary(), '-L', srv.socket, 'attach', '-d', '-t', TARGET],
    { inherit: true },
  );
  if (!res.ok) note(`reattach with: ${tmuxBinary()} -L ${srv.socket} attach -t '${TARGET}'`);
};

/**
 * A clone shell is not where this belongs, and the reason is not tidiness.
 *
 * `hangar` itself is on a clone's PATH by design -- so `hangar up` typed in a clone would reach
 * here and start sessions with fleet-wide reach from a directory that owns exactly one clone.
 */
const refuseFromInsideAClone = (hangar: Hangar): void => {
  const cwd = resolve(process.cwd());
  for (const clone of discoverClones(hangar)) {
    const root = resolve(clone.path);
    if (cwd !== root && !cwd.startsWith(root + sep)) continue;
    throw new CliError(
      `\`hangar up\` belongs at the hangar root, and you are in ${clone.name}`,
      `cd ${hangar.root} && hangar up`,
    );
  }
};

/**
 * The structural half of the escalation guard, which does not depend on a permission list.
 *
 * `.claude/modes/ops.settings.json` denies operator mode `Bash(hangar up:*)`, because
 * `hangar up --restart dev` would otherwise let an operator session start a developer session --
 * and the existing `Bash(hangar dev)` denial does not match an `up` subcommand. A deny list is a
 * file somebody can edit; this is not. The shim carries the same test for a bare `claude`.
 *
 * `CLAUDECODE` is set in every tool subprocess, measured alongside `CLAUDE_CODE_ENTRYPOINT` and
 * `CLAUDE_CODE_SESSION_ID` -- and unlike `CLAUDE_PROJECT_DIR`, which is injected per hook. There
 * is no legitimate call from inside a session anyway: attaching a tmux client needs a terminal.
 */
const refuseFromInsideASession = (): void => {
  if ((process.env['CLAUDECODE'] ?? '') === '') return;
  throw new CliError(
    'the hangar-root window cannot be opened from inside a Claude Code session',
    'run `hangar up` from a terminal -- a session that could start one in another mode ' +
      'would be a way around its own permissions.',
  );
};

/**
 * Already inside this session? Then all the work still applies and only the attach must not.
 *
 * The shell tab stands at the hangar root with direnv loaded, so `hangar` is on its PATH --
 * which makes a run from inside the session the normal case rather than a mistake. Everything up
 * to `select-window` works from there and is WANTED: a tab that has been exited is recreated, a
 * `--restart` lands, the bar is re-applied, and selecting a window moves the client that is
 * already here. Only `attach` breaks, and it breaks badly -- it unsets `TMUX` so tmux cannot see
 * the nesting, and `-d` then detaches this terminal from inside its own pane.
 *
 * So this skips one call and refuses nothing. A refusal would have blocked
 * `hangar up --restart dev` from the shell tab, which is where restarting a wedged tab is
 * naturally typed.
 *
 * The escalation guard is elsewhere and is unaffected: `refuseFromInsideASession` reads
 * `CLAUDECODE`, which is independent of `TMUX` and still fires for a Bash tool call from either
 * mode tab. Exact equality on the socket name, the comparison `currentSession` in `tmux.ts`
 * already uses, so it never prefix-matches the clone socket.
 */
const alreadyInSession = (hangar: Hangar): boolean =>
  tmuxSocketOf(process.env['TMUX']) === claudeSocketName(hangar.id);

export type UpOptions = {
  readonly select?: string | undefined;
  readonly resumeLast?: boolean | undefined;
  readonly restart?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
};

/** What `-r` does per mode tab, decided before anything is killed. */
const resumePlan = (
  hangar: Hangar,
  existing: readonly WindowRow[],
  restarting: readonly Mode[],
): Record<Mode, ResumeChoice> => {
  const choiceFor = (mode: Mode): ResumeChoice => {
    const dir = SPECS[mode].dir(hangar);
    if (restarting.includes(mode)) return restartChoice(claudeTranscriptsIn(dir));
    if (existing.some((w) => w.mode === mode)) return { kind: 'window-exists' };
    return resumeChoice(claudeTranscriptsIn(dir), existsSync);
  };
  return { ops: choiceFor('ops'), dev: choiceFor('dev') };
};

export const up = (hangar: Hangar, opts: UpOptions): void => {
  const select = asTab(opts.select ?? DEFAULT_TAB);
  const restart = opts.restart === undefined ? [] : restartTargets(opts.restart);
  const dryRun = opts.dryRun === true;

  if (resolveClaudeBinary(process.env['PATH'], hangar.root) === undefined) {
    throw new CliError(
      'claude is not on PATH',
      'install Claude Code, or check that `command -v claude` answers outside this hangar.',
    );
  }

  const srv = server(hangar);
  const existing = srv.running() ? srv.windows() : [];
  const liveOf = (mode: Mode): WindowRow | undefined => existing.find((w) => w.mode === mode);
  const restarting = restart.filter((mode) => liveOf(mode) !== undefined);
  const resumes = opts.resumeLast === true ? resumePlan(hangar, existing, restarting) : undefined;

  // A dry run reports and returns, ahead of both refusals below, because it creates nothing and
  // attaches nothing -- so neither refusal has anything to protect, and answering "what would
  // this do" is useful from exactly the places that may not do it.
  if (dryRun) {
    step(`socket       ${srv.socket}`);
    step(`conf         ${hangar.paths.claudeTmuxConf}`);
    for (const mode of MODES) {
      const state = restarting.includes(mode)
        ? `would be restarted (up ${uptimeOf(liveOf(mode)?.pid ?? '')})`
        : liveOf(mode) === undefined
          ? 'would be created'
          : 'already running';
      step(`${mode.padEnd(TAB_COLUMN)} tab      ${state}`);
    }
    const hasShell = existing.some((w) => w.shell);
    step(
      `${SHELL_NAME.padEnd(TAB_COLUMN)} tab      ${hasShell ? 'already running' : 'would be created'}`,
    );
    for (const mode of restart.filter((m) => !restarting.includes(m))) {
      note(`${mode}: not running, so there is nothing to restart -- it would be created`);
    }
    if (resumes !== undefined) {
      for (const mode of MODES) {
        const line = describeTabResume(mode, resumes[mode], false);
        (line.warn ? warn : step)(line.text);
      }
    }
    step(`select       ${select}`);
    note('nothing was created, and no client was attached');
    return;
  }

  refuseFromInsideAClone(hangar);
  refuseFromInsideASession();

  // Every resume line BEFORE anything is killed: a restarted tab's id is the one fact that cannot
  // be read back afterwards, and the over-count means it is worth a look.
  const resumeIds: Partial<Record<Mode, string>> = {};
  if (resumes !== undefined) {
    for (const mode of MODES) {
      const choice = resumes[mode];
      const line = describeTabResume(mode, choice, true);
      (line.warn ? warn : step)(line.text);
      if (choice.kind === 'resume') resumeIds[mode] = choice.session.id;
    }
  }

  for (const mode of restart.filter((m) => !restarting.includes(m))) {
    note(`${mode}: not running, so there is nothing to restart -- creating it`);
  }
  if (restarting.length > 0) {
    const uptimes = restarting.map((mode) => `${mode} (up ${uptimeOf(liveOf(mode)?.pid ?? '')})`);
    const question = `End the claude in ${uptimes.join(' and ')} and start ${restarting.length === 1 ? 'a new one' : 'new ones'}?`;
    if (opts.yes !== true && !confirm(question)) throw new CliError('nothing was restarted');
    for (const mode of restarting) {
      const row = liveOf(mode);
      if (row === undefined) continue;
      warn(`ending the claude in the ${mode} tab`);
      srv.tmux(['kill-window', '-t', `${TARGET}${String(row.index)}`]);
    }
  }

  mkdirSync(dirname(hangar.paths.claudeTmuxConf), { recursive: true });
  applyArtifact(claudeTmuxConfArtifact(hangar), false);

  ensureSession(hangar, srv, resumeIds);
  applyBar(srv);
  srv.tmux(['select-window', '-t', `${TARGET}${String(TAB_WINDOWS[select])}`]);

  if (alreadyInSession(hangar)) {
    note(`the ${select} tab is selected -- this client is already attached, C-b d to leave`);
    return;
  }
  attach(srv);
};
