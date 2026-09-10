import { basename } from 'node:path';

import { CliError, run, runCaptured, type RunResult } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { claudeSessionsIn } from '../procs.ts';
import { cloneLabel, fail, heading, note, ok, raw, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar exec [clones...] -- <snippet>` -- run one shell snippet in several clone roots.
 *
 * The fleet had no way to ask every clone the same question. Six clones meant six `cd`s or a
 * hand-written loop that has to know the clone glob and the directory layout, which is exactly
 * the knowledge `discoverClones` already holds.
 *
 * **The snippet runs in the user's REAL shell, and that requirement shapes everything here.**
 * Four things were measured rather than assumed, and each one decided a default:
 *
 * - A custom shell function is NOT reachable from `zsh -c`: an rc file is only read by an
 *   interactive shell. `-i` is the only route to it, so `-i` is not optional.
 * - `-i` costs 6-10 seconds per clone on this machine against 0.01s without it -- the whole rc
 *   chain, completions included. Six clones in sequence measured 39.5s; six at once, 12.7s. That
 *   is why the fan-out is PARALLEL by default. It is 3.1x rather than 6x because the rc chain is
 *   partly CPU-bound (218% CPU), which is also why `--jobs` exists.
 * - **direnv does not load under `-i -c`.** Its shell hook runs on `precmd`, and `-c` never draws
 *   a prompt -- so the ports came back unset and the snippet would have run against the HANGAR's
 *   environment, not the clone's. That is the same trap `install.ts` records biting once. The
 *   `eval "$(direnv export <shell>)"` preamble fixes it, verified per clone.
 * - **stdin is never a tty.** See `runCaptured`: `zsh -i` handed a real pty activates ZLE and
 *   fights this process for the terminal.
 *
 * Nothing about the snippet is interpreted here. It is handed to the shell as ONE argv element,
 * so there is no quoting layer of ours to get wrong.
 */
export type ExecCommandOptions = {
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
  direnv?: boolean | undefined;
  serial?: boolean | undefined;
  jobs?: string | undefined;
};

/** What one clone's run came back with, kept so the summary can be printed in index order. */
export type ExecResult = {
  readonly clone: Clone;
  readonly result: RunResult;
};

// ---------------------------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------------------------

/**
 * Split raw argv into the clone refs and the snippet, at the first `--`.
 *
 * **This cannot be done by commander, which is why it is here.** With `.argument('[clones...]')`
 * commander SWALLOWS the `--` and merges everything into one variadic list -- measured:
 * `exec 1 3 -- git status -sb` arrives as `["1","3","git","status","-sb"]`, in which a clone ref
 * and a snippet word are indistinguishable. Reading `process.argv` is the house route for this
 * exact class of problem; `claude.ts`, `sync`'s `forcedStrategy` and `merge-default` all do it.
 *
 * The refs are only what precedes `--`, which is what keeps a snippet starting with a flag of
 * OURS (`-- --all`, `-- --help`) from being read as one.
 *
 * **Joining with a single space is lossy in exactly one case**, and the fix is documented rather
 * than worked around: the outer shell splits argv before hangar ever sees it, so
 * `-- grep "foo bar" .` arrives as three words and rejoins as `grep foo bar .`. A snippet quoted
 * as ONE argument survives verbatim, because joining a single element returns it unchanged --
 * `-- 'grep "foo bar" .'`. `git submodule foreach` joins the same way.
 */
export const splitExecArgv = (
  argv: readonly string[],
): { readonly refs: readonly string[]; readonly snippet: string } => {
  const at = argv.indexOf('--');
  if (at === -1) return { refs: [], snippet: '' };
  return {
    refs: argv.slice(0, at).filter((token) => !token.startsWith('-')),
    snippet: argv.slice(at + 1).join(' '),
  };
};

/** The shell the snippet runs in, and the name direnv knows it by. */
export const shellFor = (
  env: NodeJS.ProcessEnv,
): { readonly path: string; readonly name: string } => {
  const path = env['SHELL'] ?? '/bin/sh';
  return { path, name: basename(path) };
};

/**
 * What actually reaches `-c`: the direnv preamble, then the snippet, on separate lines.
 *
 * A newline rather than `;` so that a snippet opening with a comment cannot swallow itself.
 *
 * **The preamble runs AFTER the rc chain, and that ordering is the point.** direnv has to apply
 * last or the rc's own `PATH` edits would win, and the clone's pinned Node -- the reason any of
 * this exists -- would be the one thing that did not survive. It is the same order a real shell
 * uses, where the hook runs on `precmd`, after everything.
 *
 * **direnv's stream is discarded, and that is the faithful choice rather than the quiet one.**
 * In a real shell direnv announces itself ONCE, when you `cd` in, and the next ten commands say
 * nothing. Here every invocation reloads, so keeping it would print a block of `loading` and
 * `export +VAR ...` lines per clone per run -- something the user would never see if they had
 * typed the snippet themselves. A clone direnv would refuse is reported up front by
 * `notAllowedByDirenv` instead, which is louder and happens once.
 */
export const scriptFor = (snippet: string, shellName: string, withDirenv: boolean): string =>
  withDirenv ? `eval "$(direnv export ${shellName} 2>/dev/null)"\n${snippet}` : snippet;

/** The `--dry-run` report: what would run, where, and what is live while it does. */
export const execPlanLines = (
  clones: readonly Clone[],
  snippet: string,
  shellName: string,
  withDirenv: boolean,
  busy: readonly string[],
): string[] => {
  const lines = [
    `would run in ${String(clones.length)} clone${clones.length === 1 ? '' : 's'}, with ${shellName} -i`,
    `  ${snippet}`,
    withDirenv
      ? '  (each clone’s own direnv environment is loaded first)'
      : '  (--no-direnv: the hangar’s environment, not the clone’s)',
  ];
  for (const clone of clones) lines.push(`  ${clone.name}  ${clone.path}`);
  if (busy.length > 0) {
    // Named, never skipped. `sync` skips a busy clone because it stashes and rebases a live
    // tree; a snippet is the user's own typed intent, and `git status` across the fleet is the
    // main use -- so the answer is to say which clones have somebody in them, not to decide.
    lines.push(`  live Claude session in: ${busy.join(', ')}`);
  }
  return lines;
};

/** The closing table, always in index order -- completion order is not reproducible. */
export const execSummaryLines = (results: readonly ExecResult[]): string[] =>
  [...results]
    .sort((a, b) => a.clone.index - b.clone.index)
    .map(({ clone, result }) =>
      result.ok ? `${clone.name}  ok` : `${clone.name}  exit ${String(result.code)}`,
    );

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

const resolveClones = (
  hangar: Hangar,
  refs: readonly string[],
  opts: ExecCommandOptions,
): Clone[] => {
  if (opts.all === true) return discoverClones(hangar);
  if (refs.length === 0)
    throw new CliError('exec needs a clone name, or --all', knownClonesHint(hangar));
  const byIndex = new Map<number, Clone>();
  for (const ref of refs) {
    const clone = requireClone(hangar, ref);
    byIndex.set(clone.index, clone);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

/**
 * Clones whose `.envrc` direnv will refuse to load, so the warning names them once up front
 * rather than leaving the snippet to run in a surprising environment.
 *
 * `foundRC.allowed` is 0 for allowed. A direnv that cannot answer at all is not a finding --
 * the preamble is dropped separately in that case.
 */
const notAllowedByDirenv = (clones: readonly Clone[]): string[] => {
  const blocked: string[] = [];
  for (const clone of clones) {
    const res = run('direnv', ['status', '--json'], { cwd: clone.path });
    if (!res.ok) continue;
    try {
      const state = (JSON.parse(res.stdout) as { state?: { foundRC?: { allowed?: number } } })
        .state;
      if (state?.foundRC !== undefined && state.foundRC.allowed !== 0) blocked.push(clone.name);
    } catch {
      // Unparseable is not a finding: a direnv too old for `--json` must not become an error.
    }
  }
  return blocked;
};

/** Print one clone's block atomically, so parallel runs never interleave. */
const report = (entry: ExecResult): void => {
  heading(cloneLabel(entry.clone));
  // `combine` already merged the streams in arrival order, so this is the whole transcript.
  const body = entry.result.stdout;
  if (body.trim() !== '') raw(body.replace(/\n+$/, ''));
  if (entry.result.ok) ok(entry.clone.name);
  else fail(`${entry.clone.name} — exit ${String(entry.result.code)}`);
};

export const exec = async (
  hangar: Hangar,
  refs: readonly string[],
  snippet: string,
  opts: ExecCommandOptions,
): Promise<void> => {
  const clones = resolveClones(hangar, refs, opts);
  if (snippet.trim() === '')
    throw new CliError(
      'exec needs a snippet after `--`',
      'for example: hangar exec --all -- git status -sb',
    );

  const shell = shellFor(process.env);
  // `--no-direnv` arrives from commander as `direnv: false`; unset means on.
  let withDirenv = opts.direnv !== false;
  if (withDirenv && !run('direnv', ['version']).ok) {
    warn('direnv is not on PATH — running without each clone’s own environment');
    note('Install direnv, or pass --no-direnv to stop asking for it.');
    withDirenv = false;
  }

  if (opts.dryRun === true) {
    const busy = clones.filter((c) => claudeSessionsIn(c.path).length > 0).map((c) => c.name);
    for (const line of execPlanLines(clones, snippet, shell.name, withDirenv, busy)) note(line);
    return;
  }

  if (withDirenv) {
    const blocked = notAllowedByDirenv(clones);
    if (blocked.length > 0) {
      warn(`direnv has not been allowed in: ${blocked.join(', ')}`);
      note('Run `direnv allow` in each, or pass --no-direnv.');
    }
  }

  const script = scriptFor(snippet, shell.name, withDirenv);
  const args = ['-i', '-c', script];
  const results: ExecResult[] = [];

  if (opts.serial === true) {
    // Live and in index order. Output is inherited, so nothing is captured to print afterwards.
    for (const clone of clones) {
      heading(cloneLabel(clone));
      const result = await runCaptured(shell.path, args, { cwd: clone.path, inherit: true });
      results.push({ clone, result });
      if (result.ok) ok(clone.name);
      else fail(`${clone.name} — exit ${String(result.code)}`);
    }
  } else {
    const limit = Math.max(1, Number(opts.jobs ?? clones.length) || clones.length);
    const queue = [...clones];
    const worker = async (): Promise<void> => {
      for (;;) {
        const clone = queue.shift();
        if (clone === undefined) return;
        const result = await runCaptured(shell.path, args, { cwd: clone.path, combine: true });
        const entry = { clone, result };
        results.push(entry);
        // Printed the moment this clone finishes -- progressive feedback, and atomic per clone
        // because the whole block is buffered until then.
        report(entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, clones.length) }, worker));
  }

  heading('Summary');
  for (const line of execSummaryLines(results)) note(line);

  const failed = results.filter((r) => !r.result.ok);
  if (failed.length > 0)
    throw new CliError(
      `${String(failed.length)} of ${String(results.length)} clones failed`,
      failed.map((r) => `${r.clone.name}: exit ${String(r.result.code)}`).join('\n'),
    );
};
