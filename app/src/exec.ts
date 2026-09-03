import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

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
