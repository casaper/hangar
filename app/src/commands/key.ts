import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { requireClone, type Clone } from '../fleet.ts';
import { CliError, run } from '../exec.ts';
import { pick, pickMany } from '../fuzzy.ts';
import { git } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { inferTicket, ticketKeyOf } from '../jira.ts';
import { KEY_TABLE, keyHelpLines } from '../keys.ts';
import { defaultExtensionsDir, keysExtensionState } from '../editor/keys-extension.ts';
import { home } from '../user-paths.ts';
import {
  ALL_ROW,
  isServerRow,
  runnerAction,
  runnerRole,
  type RunnerEntry,
  type RunnerPane,
} from '../runner.ts';
import {
  scrubbedEnv,
  tmuxArgv,
  tmuxBinary,
  tmuxServer,
  tmuxTarget,
  type TmuxServer,
} from '../tmux.ts';
import { SHELL_COMMANDS } from './reload.ts';
import { scanFleet, startPlan } from './servers.ts';
import { editorsToOpen, openEditors } from './open.ts';

/**
 * `hangar key <action> <clone>` -- what a hangar key in a clone's tmux session runs.
 *
 * HIDDEN, and nothing about it is promised to an operator: it is the far end of `KEY_TABLE`
 * (`src/keys.ts`), and a key is how it is meant to be reached. Running one by hand does the same
 * thing and prints the same line.
 *
 * **Every action reports by itself, on the bar of the clone it acted on**, as well as on stdout.
 * A key bound with `if-shell` can only choose between two fixed lines, and an action's answer --
 * which remote failed, what git said -- is neither. So an action that could run exits 0 whatever
 * it found, having said what that was; only one that could not run at all reaches the binding's
 * failure line.
 */

/**
 * One line on the clone's bar, and the same line on stdout.
 *
 * `display-message -t` on the clone's session reaches every client attached to it, which is the
 * developer who pressed the key. A clone with no session, or no server, gets stdout only: the
 * command was run by hand.
 */
const say = (hangar: Hangar, clone: Clone, line: string): void => {
  console.log(line);
  run(tmuxBinary(), tmuxArgv(hangar, ['display-message', '-t', tmuxTarget(clone), line]), {
    env: scrubbedEnv(process.env),
  });
};

/** The first line of git's complaint, which is the one that names what went wrong. Pure. */
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? 'no output';

/**
 * What a fetch press reports. PURE.
 *
 * `--all` names every sibling clone as well as origin, because each one is a remote of every
 * other: the failure that matters there is usually a sibling, and the line says which.
 */
export const fetchReport = (
  clone: string,
  all: boolean,
  result: { readonly ok: boolean; readonly stderr: string },
): string => {
  const what = all ? 'every remote' : 'origin';
  return result.ok
    ? `${clone}: fetched ${what}`
    : `${clone}: fetch from ${what} failed -- ${firstLine(result.stderr)}`;
};

export const keyFetch = (
  hangar: Hangar,
  ref: string,
  opts: { all?: boolean | undefined },
): void => {
  const clone = requireClone(hangar, ref);
  const all = opts.all === true;
  const result = git(clone.path, ['fetch', all ? '--all' : 'origin']);
  say(hangar, clone, fetchReport(clone.name, all, result));
};

/**
 * What a gate press reports: the gate's own first line, or its refusal. PURE.
 *
 * The gate prints what it did on stdout and why it refused on stderr; either way its FIRST line is
 * the sentence, and the rest is detail a bar has no room for.
 */
export const gateReport = (
  clone: string,
  result: { readonly ok: boolean; readonly stdout: string; readonly stderr: string },
): string => `${clone}: ${firstLine(result.ok ? result.stdout : result.stderr || result.stdout)}`;

/**
 * `C-b C-g`: `hangar-commit-gate toggle`, run IN the clone -- the gate finds its repository from
 * its working directory, and a key runs in whichever directory the pane is in.
 *
 * The script and not a reimplementation: the gate's state file has three readers already (the
 * hook, the bar, `status`), and only the script writes it. `toggle` is guarded by the gate's own
 * hook under this command's name too, so an agent cannot release its gate through the key.
 */
export const keyGate = (hangar: Hangar, ref: string): void => {
  const clone = requireClone(hangar, ref);
  const result = run(join(hangar.root, 'bin', 'hangar-commit-gate'), ['toggle'], {
    cwd: clone.path,
  });
  say(hangar, clone, gateReport(clone.name, result));
};

/**
 * The help table, in the popup `C-b C-k` opens, until a key is pressed.
 *
 * The clone is accepted and unused, so every key in the table runs the same way. Waiting only on a
 * terminal: a pipe has nobody to press anything, and a popup closes the moment its command exits.
 */
export const keyHelp = (): void => {
  console.log(keyHelpLines(KEY_TABLE).join('\n'));
  if (!process.stdin.isTTY) return;
  console.log('\n(any key closes this)');
  process.stdin.setRawMode(true);
  try {
    // A raw stdin can be non-blocking, and then a read with nothing typed yet is EAGAIN rather
    // than a wait.
    for (;;) {
      try {
        readSync(0, Buffer.alloc(8));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
  }
};

// ---- the pickers: C-b C-e, C-b C-t, C-b C-p -------------------------------------------------

/** The first row of `C-b C-e`'s picker: the clone itself, opened as `hangar edit` would. */
export const WORKSPACE_ROW = '(workspace)';

/**
 * `C-b C-e`'s rows: the workspace, then every directory and file of the clone. PURE.
 *
 * The files are git's (`ls-files -co --exclude-standard`: tracked and untracked, ignored left
 * out), which keeps `node_modules` and a multi-GB `tmp/` out of a list a person scrolls. The
 * directories are their parents, each once, with a trailing `/` -- that slash is how a row says
 * which of the two it is, both to the person and to `openPicked`.
 */
export const editRows = (files: readonly string[]): string[] => {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [WORKSPACE_ROW, ...[...dirs].sort(), ...files];
};

/**
 * `C-b C-t`'s rows: the ticket's directory first, then every file under it. PURE.
 *
 * The directory first, so Enter with nothing typed reveals the whole folder -- the press asked
 * about the ticket, and the folder is the ticket.
 */
export const ticketRows = (key: string, files: readonly string[]): string[] => [
  `tmp/${key}/`,
  ...files.map((file) => `tmp/${key}/${file}`),
];

/**
 * `C-b C-p`'s rows: the clone's own plans, newest first, then the ticket's `plan_<KEY>.md`. PURE.
 *
 * `<clone>/.claude/plans/` holds only the plans of sessions still alive in this clone --
 * `plans collect` moves a plan out at its session's end -- so the newest file there is the plan
 * being worked on, however long ago it was last written. A transcript scan would miss a session
 * that has been quiet for half an hour.
 */
export const planRows = (
  plans: readonly { readonly path: string; readonly mtimeMs: number }[],
  ticketPlan: string | undefined,
): string[] => [
  ...[...plans].sort((a, b) => b.mtimeMs - a.mtimeMs).map((p) => p.path),
  ...(ticketPlan === undefined ? [] : [ticketPlan]),
];

/** Every file under `dir`, relative to it: links followed, dotfiles left out, `depth` levels. */
const filesUnder = (dir: string, depth = 4): string[] => {
  const out: string[] = [];
  const walk = (at: string, left: number): void => {
    for (const name of readdirSync(at).sort()) {
      if (name.startsWith('.')) continue;
      const full = join(at, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue; // a dangling link
      }
      if (!isDir) out.push(relative(dir, full));
      else if (left > 0) walk(full, left - 1);
    }
  };
  walk(dir, depth);
  return out;
};

/**
 * A VS Code window with the hangar extension open on the clone, or undefined.
 *
 * The extension writes `<clone>/tmp/.hangar-ide/window.json` with its pid when it activates and
 * removes it when it goes. A pid that is gone means a window that crashed without cleaning up,
 * which is the same answer as no window.
 */
const ideWindowOpen = (clone: Clone): boolean => {
  try {
    const { pid } = JSON.parse(
      readFileSync(join(clone.path, 'tmp', IDE_MAILBOX, 'window.json'), 'utf8'),
    ) as { pid?: unknown };
    if (typeof pid !== 'number') return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Where the extension reads requests: per clone, and a dotfile, which `tmp merge` never shares. */
export const IDE_MAILBOX = '.hangar-ide';

/**
 * Hand a path to the clone's VS Code window through its mailbox.
 *
 * Written under another name and renamed, so the watcher never reads half a request. `at` lets
 * the extension drop a request nobody was there to read: one written while VS Code never came up
 * must not reveal a stale path the next time somebody opens the window.
 */
const postIdeRequest = (clone: Clone, path: string): void => {
  const mailbox = join(clone.path, 'tmp', IDE_MAILBOX);
  mkdirSync(mailbox, { recursive: true });
  const pending = join(mailbox, `request.${String(process.pid)}.json`);
  writeFileSync(pending, `${JSON.stringify({ path, at: Date.now() })}\n`);
  renameSync(pending, join(mailbox, 'request.json'));
};

/**
 * Open what a picker chose in the clone's VS Code window: a file as an editor tab, a directory
 * revealed in its Explorer. Never in the file manager -- `C-b C-f` is the key for Finder.
 *
 * **Through the mailbox, never `code -r` or a `vscode://` URI.** Both of those reach whichever
 * VS Code window was active last -- possibly another clone's. A request written into THIS clone's
 * `tmp/.hangar-ide/` is read only by a window open on this clone, and it is the only way to reveal
 * a directory in the Explorer from outside. **The request goes in whether or not a window is
 * open**, and then the window is raised or started the way `hangar edit` does it: a window that
 * is starting reads the pending request the moment the extension activates.
 *
 * Without the extension installed, a file still opens through the editor's launcher (`code -r -g`
 * needs nothing installed), and a directory opens the workspace only and says what reveals it. A
 * directory is never handed to the launcher itself: a folder there means "open this as a
 * workspace" and would replace the clone's window.
 */
const openPicked = (hangar: Hangar, clone: Clone, path: string): string => {
  const driver = editorsToOpen(hangar).find((d) => d.openFile !== undefined);
  if (driver?.openFile === undefined) {
    throw new CliError(`no configured editor can open a single file of ${clone.name}`);
  }
  const isDir = path.endsWith('/');
  const withExtension = keysExtensionState(hangar, defaultExtensionsDir(home)).installed.length > 0;

  if (withExtension) {
    const open = ideWindowOpen(clone);
    postIdeRequest(clone, path);
    const raised = driver.launch(clone);
    if (raised?.note !== undefined) throw new CliError(raised.note);
    const did = isDir ? 'revealed' : 'opened';
    return open
      ? `${clone.name}: ${did} ${path} in ${driver.label}`
      : `${clone.name}: starting ${driver.label} -- it ${isDir ? 'reveals' : 'opens'} ${path} once it is up`;
  }

  if (isDir) {
    const raised = driver.launch(clone);
    if (raised?.note !== undefined) throw new CliError(raised.note);
    return `${clone.name}: opened the workspace -- \`hangar doctor --fix\` installs the extension that reveals ${path}`;
  }
  const result = driver.openFile(clone, join(clone.path, path));
  if (result?.note !== undefined) throw new CliError(result.note);
  return `${clone.name}: opened ${path} in ${driver.label}`;
};

/** The rows a picker offers, or the sentence that says why there are none. */
type Rows = { readonly rows: string[] } | { readonly none: string };

/**
 * `--list`: the rows as JSON on stdout, for the VS Code extension's QuickPick, or the refusal as
 * an error. The extension shows the rows and opens the choice in its own window; nothing here
 * runs fzf.
 */
const listOrPick = (
  hangar: Hangar,
  clone: Clone,
  found: Rows,
  opts: { readonly list?: boolean | undefined },
  choose: (rows: string[]) => string | undefined,
): void => {
  if ('none' in found) {
    if (opts.list === true) throw new CliError(found.none);
    say(hangar, clone, found.none);
    return;
  }
  if (opts.list === true) {
    console.log(JSON.stringify(found.rows));
    return;
  }
  const chosen = choose(found.rows);
  if (chosen !== undefined) say(hangar, clone, openPicked(hangar, clone, chosen));
};

/** `C-b C-e`: pick a file or directory of the clone, or the clone itself. */
export const keyEdit = (hangar: Hangar, ref: string): void => {
  const clone = requireClone(hangar, ref);
  const listed = git(clone.path, ['ls-files', '-co', '--exclude-standard']);
  if (!listed.ok) throw new CliError(`could not list ${clone.name}'s files`, listed.stderr.trim());
  const files = listed.stdout.split('\n').filter((line) => line !== '');
  const chosen = pick(editRows(files), {
    prompt: `${clone.name} > `,
    header: 'Enter opens it in VS Code · a directory shows in its Explorer · Esc cancels',
  });
  if (chosen === undefined) return;
  if (chosen === WORKSPACE_ROW) {
    openEditors(clone, editorsToOpen(hangar), false);
    say(hangar, clone, `${clone.name}: opened in its editor`);
    return;
  }
  say(hangar, clone, openPicked(hangar, clone, chosen));
};

const ticketRowsOf = (clone: Clone): Rows => {
  const key = ticketKeyOf(inferTicket(clone));
  if (key === undefined) return { none: `${clone.name}: this branch names no ticket` };
  const dir = join(clone.path, 'tmp', key);
  if (!existsSync(dir)) {
    return { none: `${clone.name}: there is no tmp/${key} -- the ticket has not been fetched` };
  }
  return { rows: ticketRows(key, filesUnder(dir)) };
};

/** `C-b C-t`: pick a file of the ticket's `tmp/<KEY>/`, or the folder itself. */
export const keyTicket = (
  hangar: Hangar,
  ref: string,
  opts: { readonly list?: boolean | undefined } = {},
): void => {
  const clone = requireClone(hangar, ref);
  listOrPick(hangar, clone, ticketRowsOf(clone), opts, (rows) =>
    pick(rows, {
      prompt: `${clone.name} ticket > `,
      header: 'Enter opens it in VS Code · the first row shows the folder · Esc cancels',
    }),
  );
};

const planRowsOf = (clone: Clone): Rows => {
  const plansDir = join(clone.path, '.claude', 'plans');
  const plans = existsSync(plansDir)
    ? readdirSync(plansDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => ({
          path: `.claude/plans/${name}`,
          mtimeMs: statSync(join(plansDir, name)).mtimeMs,
        }))
    : [];
  const key = ticketKeyOf(inferTicket(clone));
  const ticketPlan =
    key !== undefined && existsSync(join(clone.path, 'tmp', key, `plan_${key}.md`))
      ? `tmp/${key}/plan_${key}.md`
      : undefined;
  const rows = planRows(plans, ticketPlan);
  return rows.length === 0
    ? { none: `${clone.name}: no plan here -- none in .claude/plans, none for the ticket` }
    : { rows };
};

/** `C-b C-p`: open the plan, or pick one when there are several. */
export const keyPlan = (
  hangar: Hangar,
  ref: string,
  opts: { readonly list?: boolean | undefined } = {},
): void => {
  const clone = requireClone(hangar, ref);
  listOrPick(hangar, clone, planRowsOf(clone), opts, (rows) =>
    rows.length === 1
      ? rows[0]
      : pick(rows, { prompt: `${clone.name} plan > `, header: 'Enter opens it · Esc cancels' }),
  );
};

// ---- the runner: C-b C-n --------------------------------------------------------------------

/** The panes of the windows a runner row owns, and whether each is idle. */
const runnerPanes = (server: TmuxServer, clone: Clone, entry: RunnerEntry): RunnerPane[] => {
  const role = isServerRow(entry) ? entry.role : runnerRole(entry.name);
  return server
    .panes(clone)
    .filter((pane) => pane.role === role)
    .map((pane) => ({
      paneId: pane.id,
      windowId: pane.windowId,
      idle: SHELL_COMMANDS.includes(pane.command),
    }));
};

/** The files a row's `pick` matches, relative to its `dir`: git's list, so nothing ignored. */
const pickableFiles = (dir: string, glob: string): string[] => {
  const listed = git(dir, ['ls-files', '-co', '--exclude-standard', '--', `:(glob)${glob}`]);
  return listed.ok ? listed.stdout.split('\n').filter((line) => line !== '') : [];
};

/** A synchronous pause, which Node offers no other way to take. */
const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Stop a server the way a person would: `C-c`, then wait for the shell to come back, then close
 * the window -- so the next press goes through `servers start`, which refuses while the role has
 * a window. A server that does not stop within the wait is left with its window, and the bar
 * says so rather than killing a window something is still running in.
 */
const stopServer = (
  server: TmuxServer,
  clone: Clone,
  entry: RunnerEntry,
  paneId: string,
): string => {
  server.sendKey(paneId, 'C-c');
  for (let waited = 0; waited < 15_000; waited += 250) {
    sleepMs(250);
    const pane = runnerPanes(server, clone, entry).find((p) => p.paneId === paneId);
    if (pane === undefined) return `${clone.name}: stopped ${entry.name}`;
    if (pane.idle) {
      server.killWindow(pane.windowId);
      return `${clone.name}: stopped ${entry.name}`;
    }
  }
  return `${clone.name}: ${entry.name} is still stopping -- its window is left open`;
};

const startServer = (server: TmuxServer, clone: Clone, role: string): string => {
  const plan = startPlan([clone], scanFleet([clone]).records, (c) => server.roles(c), [role]);
  const action = plan.start[0];
  if (action === undefined) {
    return `${clone.name}: not started -- ${plan.skip[0]?.why ?? 'nothing to start'}`;
  }
  const added = server.addWindow(clone, {
    cwd: action.cwd,
    command: action.command,
    clone: clone.name,
    role: action.role,
  });
  return added
    ? `${clone.name}: ${action.label} starting on ${String(action.port)}`
    : `${clone.name}: could not add a window for ${role}`;
};

/** Do what one press of `entry` means now, with these files picked. */
const runEntry = (hangar: Hangar, clone: Clone, entry: RunnerEntry, files: string[]): void => {
  const server = tmuxServer(hangar);
  const serving = isServerRow(entry)
    ? scanFleet([clone]).records.find((r) => r.role === entry.role)?.port
    : undefined;
  const action = runnerAction(entry, runnerPanes(server, clone, entry), serving, files);
  switch (action.do) {
    case 'refuse':
      say(hangar, clone, `${clone.name}: ${action.why}`);
      return;
    case 'stop-server':
      say(hangar, clone, stopServer(server, clone, entry, action.paneId));
      return;
    case 'replace-idle-window':
      server.killWindow(action.windowId);
      say(hangar, clone, startServer(server, clone, action.role));
      return;
    case 'start-server':
      say(hangar, clone, startServer(server, clone, action.role));
      return;
    case 'type-in':
      server.typeInPane(action.paneId, action.line);
      say(hangar, clone, `${clone.name}: ${entry.name} running again in its window`);
      return;
    case 'new-window': {
      const dir = isServerRow(entry) ? clone.path : join(clone.path, entry.dir);
      const added = server.addWindow(clone, {
        cwd: dir,
        command: action.line,
        clone: clone.name,
        role: runnerRole(entry.name),
      });
      say(
        hangar,
        clone,
        added
          ? `${clone.name}: ${entry.name} running in its own window`
          : `${clone.name}: could not add a window for ${entry.name}`,
      );
    }
  }
};

export type KeyRunOptions = {
  /** Print the row names as JSON, for the VS Code QuickPick. */
  readonly list?: boolean | undefined;
  /** Print `(all)` and the row's pickable files as JSON -- `[]` when it picks none. */
  readonly listFiles?: string | undefined;
  /** Run this row, with `file` as the picked files, and ask nothing. */
  readonly entry?: string | undefined;
  readonly file?: string[] | undefined;
};

/**
 * `C-b C-n`: pick a runner row, maybe files for it, and do what a press of it means now.
 *
 * In tmux it asks with fzf. The VS Code extension asks with its QuickPick instead, through
 * `--list`, `--list-files <name>` and then `--entry <name> --file …`, so both ends run the same
 * `runEntry`.
 */
export const keyRun = (hangar: Hangar, ref: string, opts: KeyRunOptions = {}): void => {
  const clone = requireClone(hangar, ref);
  const entries = hangar.config.runner;
  if (entries.length === 0) {
    const none = `${clone.name}: nothing to run -- \`runner\` in hangar.config.yaml is empty`;
    if (opts.list === true) throw new CliError(none);
    say(hangar, clone, none);
    return;
  }
  const byName = (name: string | undefined): RunnerEntry | undefined =>
    entries.find((e) => e.name === name);
  const filesOf = (entry: RunnerEntry): string[] =>
    isServerRow(entry) || entry.pick === undefined
      ? []
      : [ALL_ROW, ...pickableFiles(join(clone.path, entry.dir), entry.pick.glob)];

  if (opts.list === true) {
    console.log(JSON.stringify(entries.map((e) => e.name)));
    return;
  }
  if (opts.listFiles !== undefined) {
    const entry = byName(opts.listFiles);
    if (entry === undefined) throw new CliError(`no runner row "${opts.listFiles}"`);
    console.log(JSON.stringify(filesOf(entry)));
    return;
  }
  if (opts.entry !== undefined) {
    const entry = byName(opts.entry);
    if (entry === undefined) throw new CliError(`no runner row "${opts.entry}"`);
    runEntry(hangar, clone, entry, opts.file ?? []);
    return;
  }

  const entry = byName(
    pick(
      entries.map((e) => e.name),
      { prompt: `${clone.name} run > `, header: 'Enter runs it · a server toggles · Esc cancels' },
    ),
  );
  if (entry === undefined) return;
  const pickable = filesOf(entry);
  let files: string[] = [];
  if (pickable.length > 0) {
    const chosen = pickMany(pickable, {
      prompt: `${entry.name} > `,
      header: 'Tab marks files · Enter runs them · (all) runs everything · Esc cancels',
      multi: true,
    });
    if (chosen.length === 0) return;
    files = chosen.includes(ALL_ROW) ? [] : chosen;
  }
  runEntry(hangar, clone, entry, files);
};

// ---- handing a reference to the clone's Claude Code -------------------------------------------

/**
 * What `key paste --command` types: `keys.selectionCommand` with `{ref}` filled in. PURE.
 *
 * The template is config with no default, because it names a skill, and a skill's name is one
 * repo's business (the same rule as `tracker.planPrompt`).
 */
export const selectionCommandText = (template: string | undefined, refs: string): string => {
  if (template === undefined) {
    throw new CliError(
      'this hangar has no `keys.selectionCommand`',
      'Set it in hangar.config.yaml, e.g. `selectionCommand: /some-skill {ref}`.',
    );
  }
  return template.replaceAll('{ref}', refs);
};

/**
 * `C-k C-k` and `C-b C-s` in VS Code: put text into the prompt of the Claude Code running in the
 * clone's tmux session, and NEVER press Enter.
 *
 * **A bracketed paste rather than typed keys.** Claude Code may be showing a permission dialog when
 * the text arrives, and a dialog answers to single keys -- a `1` or `2` inside a line reference
 * would choose an option. `paste-buffer -p` hands the whole text over as one paste, which is not
 * a keystroke. Enter is left to the person, who can see what state the session is in.
 *
 * **Only into a pane running Claude Code** -- its foreground process is `claude` -- so a bare
 * shell never receives a line it would run.
 */
export const keyPaste = (
  hangar: Hangar,
  ref: string,
  text: string,
  opts: { readonly command?: boolean | undefined } = {},
): void => {
  const clone = requireClone(hangar, ref);
  const typed =
    opts.command === true ? selectionCommandText(hangar.config.keys.selectionCommand, text) : text;
  const server = tmuxServer(hangar);
  const pane = server.hasSession(clone)
    ? server.panes(clone).find((p) => p.command === 'claude')
    : undefined;
  if (pane === undefined) {
    throw new CliError(`no Claude Code is running in ${clone.name}'s tmux session`);
  }
  if (!server.pasteInto(pane.id, `${typed} `)) {
    throw new CliError(`could not paste into ${clone.name}'s Claude Code`);
  }
  say(hangar, clone, `${clone.name}: handed to Claude Code -- Enter is yours`);
};
