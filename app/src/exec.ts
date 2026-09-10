import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';

/**
 * A failure the user should read as a message, not a stack trace. `cli.ts` catches these,
 * prints `error: <message>` and exits non-zero; anything else keeps its stack, because an
 * unexpected throw is a bug in the CLI rather than a bad invocation.
 */
export class CliError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
  }
}

export type RunResult = {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Stream child output straight to the terminal instead of capturing it. */
  readonly inherit?: boolean;
  readonly input?: string;
  readonly timeoutMs?: number;
};

/** Run a command, never throwing. Callers decide what a non-zero exit means. */
export const run = (cmd: string, args: readonly string[], opts: RunOptions = {}): RunResult => {
  const spawnOpts: SpawnSyncOptions = {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.inherit ? 'inherit' : 'pipe',
  };
  if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
  if (opts.env !== undefined) spawnOpts.env = opts.env;
  if (opts.input !== undefined) spawnOpts.input = opts.input;
  if (opts.timeoutMs !== undefined) spawnOpts.timeout = opts.timeoutMs;

  const res = spawnSync(cmd, [...args], spawnOpts);
  return {
    ok: res.status === 0,
    code: res.status ?? -1,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
};

/** Run a command and fail loudly if it does not succeed. Returns trimmed stdout. */
export const runOrThrow = (cmd: string, args: readonly string[], opts: RunOptions = {}): string => {
  const res = run(cmd, args, opts);
  if (!res.ok) {
    const detail = (res.stderr || res.stdout).trim();
    throw new CliError(
      `${cmd} ${args.join(' ')} failed (exit ${res.code})`,
      detail === '' ? undefined : detail,
    );
  }
  return res.stdout.trim();
};

export type CapturedOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Stream the child's output to this process's own stdout/stderr instead of capturing it.
   * `stdout`/`stderr` on the result are empty strings when this is set -- there is nothing to
   * hold, because it went straight to the terminal.
   */
  readonly inherit?: boolean;
  /**
   * Collect both streams into `stdout`, in the order the chunks actually arrived, leaving
   * `stderr` empty.
   *
   * Two separate buffers can only be printed one after the other, which REORDERS the run: a
   * `direnv: loading` line written before the snippet ran would print after everything the
   * snippet said. For output a human reads as a transcript of one shell, arrival order is the
   * honest one -- and it is the order they would have seen had they typed it themselves.
   */
  readonly combine?: boolean;
};

/**
 * The async sibling of `run`, for the one caller that has to fan out.
 *
 * `run` is `spawnSync` and every other command in this CLI is happy with that -- one clone at a
 * time, output streamed as it arrives. `hangar exec` cannot be: an interactive shell costs
 * 6-10 seconds to start on this machine, so six clones in sequence is 39.5s against 12.7s for
 * six at once (measured). That difference is the whole reason the command is worth having, and
 * `spawnSync` cannot express it.
 *
 * **stdin is always `ignore`.** Handing a child `zsh -i` a real tty makes it activate ZLE and
 * compete for the terminal this process is on -- measured, `read x` returns EMPTY under a pty
 * and works under a pipe, with a stray `^D` left on the terminal. `/dev/null` keeps the line
 * editor off. So a snippet that prompts gets EOF and fails fast, in either mode, rather than
 * hanging invisibly behind five other shells.
 *
 * Never rejects, for the same reason `run` never throws: a non-zero exit is the caller's to
 * interpret. A spawn that fails outright comes back as `code: -1` with the reason on `stderr`.
 */
export const runCaptured = async (
  cmd: string,
  args: readonly string[],
  opts: CapturedOptions = {},
): Promise<RunResult> =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, [...args], {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
      stdio: [
        'ignore',
        opts.inherit === true ? 'inherit' : 'pipe',
        opts.inherit === true ? 'inherit' : 'pipe',
      ],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.on('data', (chunk: string) => {
      if (opts.combine === true) stdout += chunk;
      else stderr += chunk;
    });

    // `error` fires INSTEAD of `close` when the binary is missing, so both have to resolve or
    // the fan-out waits forever on a shell that was never spawned.
    child.on('error', (err: Error) => {
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code: number | null) => {
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
