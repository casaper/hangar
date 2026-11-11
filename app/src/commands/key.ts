import { existsSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { requireClone, type Clone } from '../fleet.ts';
import { CliError, run } from '../exec.ts';
import { pick } from '../fuzzy.ts';
import { git } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { inferTicket, ticketKeyOf } from '../jira.ts';
import { KEY_TABLE, keyHelpLines } from '../keys.ts';
import { platform } from '../platform/index.ts';
import { scrubbedEnv, tmuxArgv, tmuxBinary, tmuxTarget } from '../tmux.ts';
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
 * Open what a picker chose: a file in the clone's editor window, a directory in the file manager.
 *
 * A directory is never handed to the editor's launcher, because a folder there means "open this
 * as a workspace" -- it would replace the clone's window rather than show a folder in it.
 */
const openPicked = (hangar: Hangar, clone: Clone, path: string): string => {
  const abs = join(clone.path, path);
  if (path.endsWith('/')) {
    if (!platform().capabilities.openExternally || !platform().openExternally(abs)) {
      throw new CliError(`could not open ${path}`);
    }
    return `${clone.name}: opened ${path}`;
  }
  const driver = editorsToOpen(hangar).find((d) => d.openFile !== undefined);
  if (driver?.openFile === undefined) {
    throw new CliError(`no configured editor can open a single file of ${clone.name}`);
  }
  const result = driver.openFile(clone, abs);
  if (result?.note !== undefined) throw new CliError(result.note);
  return `${clone.name}: opened ${path} in ${driver.label}`;
};

/** `C-b C-e`: pick a file or directory of the clone, or the clone itself. */
export const keyEdit = (hangar: Hangar, ref: string): void => {
  const clone = requireClone(hangar, ref);
  const listed = git(clone.path, ['ls-files', '-co', '--exclude-standard']);
  if (!listed.ok) throw new CliError(`could not list ${clone.name}'s files`, listed.stderr.trim());
  const files = listed.stdout.split('\n').filter((line) => line !== '');
  const chosen = pick(editRows(files), {
    prompt: `${clone.name} > `,
    header: 'Enter opens it · a directory opens in the file manager · Esc cancels',
  });
  if (chosen === undefined) return;
  if (chosen === WORKSPACE_ROW) {
    openEditors(clone, editorsToOpen(hangar), false);
    say(hangar, clone, `${clone.name}: opened in its editor`);
    return;
  }
  say(hangar, clone, openPicked(hangar, clone, chosen));
};

/** `C-b C-t`: pick a file of the ticket's `tmp/<KEY>/`, or the folder itself. */
export const keyTicket = (hangar: Hangar, ref: string): void => {
  const clone = requireClone(hangar, ref);
  const key = ticketKeyOf(inferTicket(clone));
  if (key === undefined) {
    say(hangar, clone, `${clone.name}: this branch names no ticket`);
    return;
  }
  const dir = join(clone.path, 'tmp', key);
  if (!existsSync(dir)) {
    say(hangar, clone, `${clone.name}: there is no tmp/${key} -- the ticket has not been fetched`);
    return;
  }
  const chosen = pick(ticketRows(key, filesUnder(dir)), {
    prompt: `${key} > `,
    header: 'Enter opens it · the first row opens the folder · Esc cancels',
  });
  if (chosen !== undefined) say(hangar, clone, openPicked(hangar, clone, chosen));
};

/** `C-b C-p`: open the plan, or pick one when there are several. */
export const keyPlan = (hangar: Hangar, ref: string): void => {
  const clone = requireClone(hangar, ref);
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
  if (rows.length === 0) {
    say(hangar, clone, `${clone.name}: no plan here -- none in .claude/plans, none for the ticket`);
    return;
  }
  const chosen =
    rows.length === 1
      ? rows[0]
      : pick(rows, { prompt: `${clone.name} plan > `, header: 'Enter opens it · Esc cancels' });
  if (chosen !== undefined) say(hangar, clone, openPicked(hangar, clone, chosen));
};
