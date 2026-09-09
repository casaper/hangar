import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

import { CliError, run } from '../exec.ts';
import { discoverClones } from '../fleet.ts';
import {
  BAR_OPTIONS,
  claudeTmuxConfArtifact,
  modeWindowFormat,
} from '../generate/claude-tmux-conf.ts';
import { applyArtifact } from '../generate/index.ts';
import type { Hangar } from '../hangar.ts';
import { MODE_COLOURS } from '../palette.ts';
import { claudeSocketName, tmuxBinary, tmuxSocketOf } from '../tmux.ts';
import { confirm, note, ok, step, warn } from '../ui.ts';

/**
 * `hangar claude` -- both hangar-root modes and a shell, in one tmux window, as three tabs.
 *
 * A hangar-root session is either driving the fleet or changing the CLI, and which one it is
 * decides its permissions and its remit. This command is the only way into either: it starts a
 * tmux session on its own socket with operator in window 1, developer in window 2 and a plain
 * shell at the hangar root in window 3, and attaches the terminal you typed in to it.
 *
 * ## The shell tab is a third WINDOW and not a third MODE
 *
 * A mode is the three flags below plus a working directory, and a shell has none of them. So
 * `Mode` stays a pair, `-m shell` is an error, and `C-b 3` is how that tab is reached. Its
 * `HANGAR_MODE` is explicitly EMPTY, which is the one that would bite: a window created without
 * that flag inherits the SESSION's value, and the shell tab is exactly where someone types
 * `claude` -- so leaving it off would badge a session `OPS` with none of operator's rules.
 *
 * ## A mode is three flags and a working directory, and nothing in a session can change them
 *
 * `--settings <mode>.settings.json` carries the permission rules, `--append-system-prompt-file
 * <mode>.md` the remit, and `-n "hangar <mode>"` puts the mode in the prompt box, the terminal
 * title and the `/resume` picker. Claude Code reads all three once, at startup.
 *
 * `--append-system-prompt-file` also turns the system-prompt SNAPSHOT off, which is what makes
 * `hangar claude --resume <id> -m ops` resume back INTO operator mode -- the remit is re-applied
 * on every launch rather than frozen into the conversation. A bare `claude --resume` of the same
 * session comes back with no mode at all, which is what the red `NO MODE` badge is for.
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
 *
 * ## Everything else is passed straight through
 *
 * Hangar adds `-m|--mode` and `--replace` and takes nothing else. `-m` and `--mode` are both
 * free in claude's flag space; `-n, --name` is NOT -- it is claude's own, and it is what the
 * mode badge is written with -- so hangar supplies its own only when the caller named neither.
 *
 * **`-n` is therefore not a dry run here**, the one place in this CLI besides `hangar resume`
 * where it is not. `--dry-run` is spelled out in full, because the alternative is shadowing a
 * flag of claude's that a caller has every reason to pass.
 */

export type Mode = 'ops' | 'dev';

export const MODES: readonly Mode[] = ['ops', 'dev'];

/** Everything about a mode that is not its colour. The hue and the purpose are in `palette.ts`. */
type ModeSpec = {
  /** Where the session's working directory is -- which decides which `CLAUDE.md` loads. */
  readonly dir: (hangar: Hangar) => string;
  readonly window: number;
};

/**
 * Developer mode runs in `app/` so that `app/CLAUDE.md` is loaded on turn one rather than
 * lazily, and operator mode at the root so it is not.
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
 * inside one of the two sessions.
 */
const SHELL_WINDOW = 3;
const SHELL_NAME = 'shell';
/** What the tab is for, in the same voice as a mode's purpose. A literal: it has no hue to read. */
const SHELL_PURPOSE = 'a shell at the root';

/** The column every tab name is reported in. `shell` is the longest of the three. */
const TAB_COLUMN = 5;

/**
 * Every tab's window index, DERIVED rather than retyped.
 *
 * Exported for the one property worth asserting about it: no two tabs share an index. tmux
 * refuses `new-window -t` on an occupied one, so a collision here is a command that cannot
 * rebuild its own workspace. A hand-written copy of this table would pin itself and prove
 * nothing.
 */
export const TAB_WINDOWS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(MODES.map((mode) => [mode, SPECS[mode].window])),
  [SHELL_NAME]: SHELL_WINDOW,
};

// ---------------------------------------------------------------------------------------------
// The pure half: four builders, each callable without a tmux server or a filesystem.
// ---------------------------------------------------------------------------------------------

export type ClaudeInvocation = {
  readonly mode: Mode;
  readonly replace: boolean;
  readonly yes: boolean;
  readonly help: boolean;
  readonly dryRun: boolean;
  /** Everything hangar did not consume, in the order it was given. */
  readonly passthrough: readonly string[];
};

/** The default when `-m` is absent: driving the fleet is the common case. */
const DEFAULT_MODE: Mode = 'ops';

const asMode = (value: string): Mode => {
  if (!isMode(value)) throw new CliError(`unknown mode "${value}" (expected ops or dev)`);
  return value;
};

/**
 * Split `hangar claude`'s own flags out of an argv that otherwise belongs to claude.
 *
 * Raw argv rather than commander, and that is not laziness. Commander with
 * `allowUnknownOption` cannot tell `--model sonnet` (an option and its value) from an option
 * followed by a positional, so `sonnet` would be lifted out of sequence and claude would be
 * handed `--model` with nothing after it. `passThroughOptions` fixes the parsing and breaks the
 * ergonomics instead: it stops at the first unknown token, so `--resume <id> -m dev` -- with the
 * mode flag LAST, which is how a person actually types it -- would pass `-m dev` to claude.
 *
 * `sync`'s `forcedStrategy` and `merge-default` read `process.argv` for the same class of
 * reason, so this is the house route rather than an exception to it.
 *
 * Unknown-to-hangar tokens are never inspected, only forwarded, which is what keeps this correct
 * against a claude that grows a flag tomorrow.
 */
export const splitClaudeArgv = (argv: readonly string[]): ClaudeInvocation => {
  let mode: Mode | undefined;
  let replace = false;
  let yes = false;
  let help = false;
  let dryRun = false;
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    // `--` ends hangar's interest entirely: everything after it is claude's, verbatim, even a
    // literal `-m`. That is the escape hatch for a future claude flag that collides with ours.
    if (token === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    const eq = /^--mode=(.*)$/.exec(token);
    if (eq !== null) {
      mode = asMode(eq[1] ?? '');
      continue;
    }
    if (token === '-m' || token === '--mode') {
      const value = argv[i + 1];
      if (value === undefined) throw new CliError('-m needs a mode: ops or dev');
      mode = asMode(value);
      i += 1;
      continue;
    }
    if (token === '--replace') {
      replace = true;
      continue;
    }
    if (token === '--yes') {
      yes = true;
      continue;
    }
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token === '-h' || token === '--help') {
      help = true;
      continue;
    }
    passthrough.push(token);
  }

  return { mode: mode ?? DEFAULT_MODE, replace, yes, help, dryRun, passthrough };
};

/**
 * The tokens that follow the `claude` subcommand, out of the raw process argv.
 *
 * `process.argv` is `[node, cli.ts, ...global options..., 'claude', ...claude's own...]`. The
 * only global option taking a value is `--hangar <path>`, so a hangar directory actually NAMED
 * `claude` is the single thing that could be mistaken for the subcommand -- and skipping that
 * option's value is what rules it out. `sync`'s `forcedStrategy` scans argv the same way and
 * stops at its own subcommand name for the same reason.
 */
export const claudeArgvFromProcess = (argv: readonly string[]): string[] => {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (token === '--hangar') {
      i += 1;
      continue;
    }
    if (token === 'claude') return [...argv.slice(i + 1)];
  }
  return [];
};

/** True when the caller already named the session, so hangar must not override them. */
const namesSession = (passthrough: readonly string[]): boolean =>
  passthrough.some((t) => t === '-n' || t === '--name' || t.startsWith('--name='));

/**
 * The argv claude is launched with.
 *
 * **The ordering is what makes resuming into a mode work**, and it is the reason this is a pure
 * builder with a test rather than a template string: `--settings` and
 * `--append-system-prompt-file` come FIRST, so a passed-through `--resume <id>` is resumed with
 * the mode's permissions and remit already in force. Reversed, a resumed session would come back
 * as a mode-less one wearing the right badge, which is the failure that looks like success.
 */
export const claudeArgvFor = (
  hangar: Hangar,
  mode: Mode,
  passthrough: readonly string[],
): string[] => [
  '--settings',
  join(hangar.root, '.claude', 'modes', `${mode}.settings.json`),
  '--append-system-prompt-file',
  join(hangar.root, '.claude', 'modes', `${mode}.md`),
  ...(namesSession(passthrough) ? [] : ['-n', `hangar ${mode}`]),
  ...passthrough,
];

/**
 * The real `claude`, found on PATH with this hangar's own shim directory skipped.
 *
 * `.local/bin/claude` is what a bare `claude` in the hangar root reaches, and all it does is call
 * this command -- so resolving the first `claude` on PATH from here would find the proxy that
 * invoked us and recurse until the process table gave up. Skipping one directory is the whole
 * guard, and it is exact rather than a substring test.
 *
 * `.local/bin` and not `bin`: the hangar's `.envrc` adds both, but every CLONE's own
 * `.envrc.private` repeats `PATH_add <hangar>/bin` -- it has to, that is how `hangar` is reached
 * from a clone. A shim in `bin/` would therefore have been on PATH inside every clone, where
 * `terminal.tabs[]`'s default `command: 'claude'` starts every clone session. The split is what
 * makes the proxy reachable in exactly one directory and invisible everywhere else.
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

/** The row `--help` gains, in claude's own two-column shape. */
const MODE_HELP_TERM = '  -m, --mode <ops|dev>';
const MODE_HELP_TEXT = 'Which hangar-root mode this session runs in (default: ops)';

/** How far into a help line the description column starts. */
const indentOf = (line: string): number => {
  const term = /^(\s+\S+(?:, \S+)?(?: <[^>]+>)?\s+)/.exec(line);
  return term?.[1]?.length ?? 40;
};

/**
 * The right margin claude's help actually wraps at.
 *
 * The plain maximum is wrong, and measurably: claude's help wraps at 80 but carries one row of
 * 117 characters, so `Math.max` reads the outlier as the margin and nothing ever wraps. Lines
 * over 100 are therefore ignored -- that keeps this derived from the page rather than hardcoded
 * to 80, so a claude that rewraps at a different width still gets a matching row.
 */
const marginOf = (rows: readonly string[]): number => {
  const widths = rows.map((r) => r.length).filter((n) => n <= 100);
  return widths.length === 0 ? 80 : Math.max(...widths);
};

/** Greedy wrap, so an inserted help row obeys the same right margin as the page around it. */
const wrap = (text: string, width: number): string[] => {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out;
};

/**
 * claude's own help, with hangar's one added flag put where a reader would scan for it.
 *
 * Insert before claude's `--model` row, which is where `-m, --mode` sorts. claude's help layout
 * is not a contract, so a missing anchor is expected rather than exceptional: the flag is then
 * appended in a block of its own, which documents it either way and cannot fail. Losing the
 * anchor costs the reader a scroll; treating it as an error would cost them `--help` entirely.
 */
export const claudeHelpWith = (helpText: string): string => {
  const rows = helpText.split('\n');
  const at = rows.findIndex((line) => /^\s+--model /.test(line));
  if (at !== -1) {
    // Match claude's own column AND its wrap, so the row is indistinguishable from the rest.
    // Lining the term up and letting the text run past the right margin looks more wrong than
    // not inserting it at all -- the reader sees one row that does not obey the page.
    const column = indentOf(rows[at] ?? '');
    const width = marginOf(rows);
    const wrapped = wrap(MODE_HELP_TEXT, Math.max(20, width - column));
    const inserted = wrapped.map((line, i) =>
      i === 0 ? `${MODE_HELP_TERM.padEnd(column)}${line}` : `${' '.repeat(column)}${line}`,
    );
    return [...rows.slice(0, at), ...inserted, ...rows.slice(at)].join('\n');
  }
  // Two headings, because this block also answers when there is no page at all: `claude` not
  // installed yet. "Everything else above" then names nothing, so it says what is true instead.
  const page = helpText.replace(/\n+$/, '');
  return [
    ...(page === '' ? [] : [page, '']),
    page === ''
      ? "Added by hangar (claude's own help is unavailable; every other flag reaches it unchanged):"
      : 'Added by hangar (everything else above is passed straight through to claude):',
    `${MODE_HELP_TERM}  ${MODE_HELP_TEXT}`,
    '  --replace             end the claude already in that tab and start this one there',
    '  --dry-run             report what would be created, change nothing',
    '',
  ].join('\n');
};

// ---------------------------------------------------------------------------------------------
// The half that touches a live server.
// ---------------------------------------------------------------------------------------------

const SESSION = 'claude';
const TARGET = `=${SESSION}:`;
/** U+001F, for the same reason `tmux.ts` uses it: no window name or mode can contain it. */
const SEP = '\u001f';

const trimmed = (out: string): string[] =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

type WindowRow = {
  readonly index: number;
  readonly mode: string | undefined;
  readonly shell: boolean;
  readonly pid: string;
};

type Server = {
  readonly socket: string;
  readonly tmux: (args: readonly string[], withConf?: boolean) => ReturnType<typeof run>;
  readonly running: () => boolean;
  readonly windows: () => WindowRow[];
  readonly clientTtys: () => string[];
};

const server = (hangar: Hangar): Server => {
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

/** How long a tab's claude has been up -- the fact `--replace` has to justify itself with. */
const uptimeOf = (pid: string): string => {
  if (pid === '') return 'an unknown time';
  const res = run('ps', ['-p', pid, '-o', 'etime=']);
  const out = res.stdout.trim();
  return res.ok && out !== '' ? out : 'an unknown time';
};

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** The command a mode's window runs. Absolute claude, so the shim on PATH is never re-entered. */
const windowCommand = (binary: string, argv: readonly string[]): string =>
  [binary, ...argv].map(shellQuote).join(' ');

/** Identity and presentation, both at window scope, both read back by the bar. */
const tagWindow = (srv: Server, mode: Mode): void => {
  const target = `${TARGET}${String(SPECS[mode].window)}`;
  srv.tmux(['set', '-w', '-t', target, '@hangar_mode', mode]);
  srv.tmux(['set', '-w', '-t', target, '@hangar_purpose', MODE_COLOURS[mode].purpose]);
  srv.tmux(['set', '-w', '-t', target, 'window-status-current-format', modeWindowFormat(mode)]);
};

/**
 * All three windows present, each tagged, and only the mode being launched gets the caller's
 * arguments.
 *
 * The other windows are created bare when they are missing, because the three of them ARE the
 * workspace. Each lands at its own fixed index, which is what `renumber-windows off` in the conf
 * protects.
 *
 * `-e HANGAR_MODE` on every MODE creation and never by inheritance: measured on tmux 3.7c, a
 * window created without it silently picks up the SESSION's value, so the developer tab would
 * carry an `OPS` badge and the status line would be confidently wrong. The shell window is the
 * one that gets none, for the same reason read the other way -- it has no mode to declare, and a
 * value there would be inherited by a `claude` typed in it.
 */
const ensureSession = (
  hangar: Hangar,
  srv: Server,
  wanted: Mode,
  binary: string,
  wantedArgv: readonly string[],
): void => {
  for (const mode of MODES) {
    const spec = SPECS[mode];
    if (srv.running() && srv.windows().some((w) => w.mode === mode)) continue;

    const argv = mode === wanted ? wantedArgv : claudeArgvFor(hangar, mode, []);
    const shared = [
      '-n',
      mode,
      '-c',
      spec.dir(hangar),
      '-e',
      `HANGAR_MODE=${mode}`,
      windowCommand(binary, argv),
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

  // Last, and after the loop for a reason: operator's is the creation that makes the session, so
  // the shell is always a `new-window` and never has to know how to be the first one.
  //
  // No command, so tmux starts `default-shell` as a login shell -- the developer's own, rather
  // than one this CLI picked for them. No per-window format either: with no hue to bake in, the
  // tab falls back to the conf's neutral entry, which says what it is.
  //
  // `-e HANGAR_MODE=` is EMPTY and not omitted, and that is measured rather than tidy. Omitting
  // it inherits the session's value -- the same tmux 3.7c behaviour that makes the mode windows
  // pass their own, verified here by reading `printenv HANGAR_MODE` out of the pane: a window
  // created with no `-e` answered `ops`. So the shell tab would have carried operator's badge,
  // and a `claude` started in it would have worn a mode it does not have. Empty reaches
  // `statusline.sh`'s `${HANGAR_MODE:-}` as unset does, which is the honest red `NO MODE`.
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
};

/**
 * Attach this terminal, taking the session over from any other client.
 *
 * `-d` is what makes the pair a singleton in practice: two clients on one session mirror each
 * other's window selection, so switching tabs in one moves the other and the bar appears to
 * change on its own. Detaching is recoverable in a keystroke and both sessions keep running, so
 * this needs no confirmation the way `--replace` does.
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

const reportPlan = (
  hangar: Hangar,
  srv: Server,
  inv: ClaudeInvocation,
  existing: readonly WindowRow[],
  live: WindowRow | undefined,
): void => {
  step(`socket       ${srv.socket}`);
  step(`conf         ${hangar.paths.claudeTmuxConf}`);
  for (const mode of MODES) {
    const has = existing.some((w) => w.mode === mode);
    step(`${mode.padEnd(TAB_COLUMN)} tab      ${has ? 'already running' : 'would be created'}`);
  }
  const hasShell = existing.some((w) => w.shell);
  step(
    `${SHELL_NAME.padEnd(TAB_COLUMN)} tab      ${hasShell ? 'already running' : 'would be created'}`,
  );
  step(`select       ${inv.mode}`);
  if (inv.passthrough.length > 0) {
    step(
      `claude args  ${inv.passthrough.join(' ')}` +
        (live === undefined ? '' : '   (that tab is live -- this would refuse)'),
    );
  }
  note('nothing was created, and no client was attached');
};

/**
 * A clone shell is not where this belongs, and the reason is not tidiness.
 *
 * `.local/bin` keeps a bare `claude` out of every clone, but `hangar` itself is on a clone's PATH
 * by design -- so `hangar claude` typed in a clone would still reach here and start a session
 * with fleet-wide reach from a directory that owns exactly one clone.
 */
const refuseFromInsideAClone = (hangar: Hangar): void => {
  const cwd = resolve(process.cwd());
  for (const clone of discoverClones(hangar)) {
    const root = resolve(clone.path);
    if (cwd !== root && !cwd.startsWith(root + sep)) continue;
    throw new CliError(
      `\`hangar claude\` belongs at the hangar root, and you are in ${clone.name}`,
      `cd ${hangar.root} && claude`,
    );
  }
};

/**
 * The structural half of the escalation guard, which does not depend on a permission list.
 *
 * `.claude/modes/ops.settings.json` denies operator mode `Bash(hangar claude:*)`, because
 * `hangar claude -m dev -p '...'` would otherwise hand an operator session everything developer
 * mode may do -- editing `app/**` included -- and the existing `Bash(hangar dev)` denial does
 * not match a `claude` subcommand. A deny list is a file somebody can edit; this is not.
 *
 * `CLAUDECODE` is set in every tool subprocess, measured alongside `CLAUDE_CODE_ENTRYPOINT` and
 * `CLAUDE_CODE_SESSION_ID` -- and unlike `CLAUDE_PROJECT_DIR`, which is injected per hook. There
 * is no legitimate call from inside a session anyway: attaching a tmux client needs a terminal.
 */
const refuseFromInsideASession = (): void => {
  if ((process.env['CLAUDECODE'] ?? '') === '') return;
  throw new CliError(
    'a hangar-root session cannot be started from inside a Claude Code session',
    'run `hangar claude` from a terminal -- a session that could start one in another mode ' +
      'would be a way around its own permissions.',
  );
};

/**
 * Already inside this session? Then all the work still applies and only the attach must not.
 *
 * The shell tab stands at the hangar root with direnv loaded, so `.local/bin/claude` and `hangar`
 * are both on its PATH -- which makes a run from inside the session the normal case rather than a
 * mistake. Everything up to `select-window` works from there and is WANTED: a tab that has been
 * exited is recreated, the bar is re-applied, and selecting a window moves the client that is
 * already here, which is precisely "switch to that tab". Only `attach` breaks, and it breaks
 * badly -- it unsets `TMUX` so tmux cannot see the nesting, and `-d` then detaches this terminal
 * from inside its own pane.
 *
 * So this skips one call and refuses nothing. A refusal would have blocked
 * `hangar claude -m dev --replace` from the shell tab, which is where restarting a wedged tab is
 * naturally typed, and would leave an exited tab unreachable without detaching first.
 *
 * The escalation guard is elsewhere and is unaffected: `refuseFromInsideASession` reads
 * `CLAUDECODE`, which is independent of `TMUX` and still fires for a Bash tool call from either
 * mode tab. This branch only ever admits a human at a shell prompt, where there is nothing to
 * escalate. Exact equality on the socket name, the comparison `currentSession` in `tmux.ts`
 * already uses, so it never prefix-matches the clone socket.
 */
const alreadyInSession = (hangar: Hangar): boolean =>
  tmuxSocketOf(process.env['TMUX']) === claudeSocketName(hangar.id);

export type ClaudeOptions = { readonly argv: readonly string[] };

export const claude = (hangar: Hangar, opts: ClaudeOptions): void => {
  const inv = splitClaudeArgv(opts.argv);
  const binary = resolveClaudeBinary(process.env['PATH'], hangar.root);

  // Ahead of every guard, and ahead of the missing-binary refusal below: `--help` is a question
  // about this command, not a request to start one. With no claude installed there is no page to
  // fold `-m, --mode` into -- and `claudeHelpWith` then answers with hangar's own rows alone,
  // which is the most useful thing this command can say on a machine that cannot yet run it.
  if (inv.help) {
    const res = binary === undefined ? undefined : run(binary, ['--help']);
    process.stdout.write(claudeHelpWith(res?.ok === true ? res.stdout : ''));
    return;
  }

  if (binary === undefined) {
    throw new CliError(
      'claude is not on PATH',
      'install Claude Code, or check that `command -v claude` answers outside this hangar.',
    );
  }

  const srv = server(hangar);
  const existing = srv.running() ? srv.windows() : [];
  const live = existing.find((w) => w.mode === inv.mode);

  // A dry run reports and returns, ahead of both refusals below, because it creates nothing and
  // attaches nothing -- so neither refusal has anything to protect, and answering "what would
  // this do" is useful from exactly the places that may not do it.
  if (inv.dryRun) {
    reportPlan(hangar, srv, inv, existing, live);
    return;
  }

  refuseFromInsideAClone(hangar);
  refuseFromInsideASession();

  // Args plus a live tab is the one cell that cannot be honoured: a running claude takes no new
  // arguments. Attaching anyway would land the caller in a session they did not name, which is
  // the failure worth a hard stop rather than a warning they have already scrolled past.
  if (live !== undefined && inv.passthrough.length > 0 && !inv.replace) {
    throw new CliError(
      `the ${inv.mode} tab is already running claude, so it cannot take these arguments`,
      [
        `${`hangar claude -m ${inv.mode}`.padEnd(22)}switch to that tab as it is`,
        `${'--replace'.padEnd(22)}end that session and start this one in its place`,
        'or /exit in that tab and run this again, which keeps the arguments',
      ].join('\n'),
    );
  }

  if (live !== undefined && inv.replace) {
    const up = uptimeOf(live.pid);
    const question = `End the claude in the ${inv.mode} tab (up ${up}) and start a new one?`;
    if (!inv.yes && !confirm(question)) throw new CliError('nothing was replaced');
    warn(`ending the claude in the ${inv.mode} tab, up ${up}`);
    srv.tmux(['kill-window', '-t', `${TARGET}${String(live.index)}`]);
  }

  mkdirSync(dirname(hangar.paths.claudeTmuxConf), { recursive: true });
  applyArtifact(claudeTmuxConfArtifact(hangar), false);

  ensureSession(hangar, srv, inv.mode, binary, claudeArgvFor(hangar, inv.mode, inv.passthrough));
  applyBar(srv);
  srv.tmux(['select-window', '-t', `${TARGET}${String(SPECS[inv.mode].window)}`]);

  if (alreadyInSession(hangar)) {
    note(`the ${inv.mode} tab is selected -- this client is already attached, C-b d to leave`);
    return;
  }
  attach(srv);
};
