import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { CliError } from '../exec.ts';
import type { Hangar } from '../hangar.ts';
import {
  argvFor,
  EXPOSURES,
  findCommand,
  toolDefinitions,
  unexposedCommands,
  type Exposure,
} from './tools.ts';
import type { CommandUnknownOpts } from '@commander-js/extra-typings';

/**
 * A Model Context Protocol server over stdio, speaking for this hangar's own CLI.
 *
 * ## stdout is the protocol, and that is the constraint everything here bends to
 *
 * Nothing in this directory may print. `src/ui.ts` writes to stdout, so one `note()` anywhere
 * under `src/mcp/` would corrupt the stream and the client would report the server as broken
 * with no clue why. Diagnostics go to stderr, which Claude Code shows in the MCP log.
 *
 * It is also why a tool call runs `bin/hangar` as a SUBPROCESS rather than importing the command
 * and calling it. Three measured reasons, and the first is not recoverable in-process:
 *
 * - **`sync` recovers its strategy from `process.argv`.** `forcedStrategy` scans for
 *   `merge-default` / `rebase-default` before it reaches `sync`; commander parses none of it into
 *   options. A direct call would always take the auto-decide branch, silently.
 * - **About twenty `console.log` / `process.stdout.write` calls bypass `ui.ts`'s `emit`**, in
 *   `doctor`, `sync`, `status`, `plans`, `colours` and `config`. Every one of them would land in
 *   the middle of a JSON-RPC frame.
 * - **`captureOutput()` is a module-level global** with no isolation between concurrent calls.
 *
 * The cost is one Node start per call, 0.24-0.28s measured, which is nothing next to a tool call
 * and buys behaviour byte-identical to what a human types.
 *
 * ## Nothing is confirmed here, and nothing needs to be
 *
 * `ui.ts`'s `confirm()` reads `/dev/tty` and fails CLOSED where there is none -- which is the
 * subprocess's situation always. So `remove_clone --delete` detaches a clone and can never delete
 * its files, and `checkout-default` can never talk its way past a live session. Those protections
 * are inherited rather than reimplemented. The approval that a tool call DOES get is the
 * permission prompt in front of it, which is why `--yes` stays an ordinary parameter: the human
 * has already answered by then.
 */

const PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'hangar';

type Id = string | number | null;

type Request = {
  readonly jsonrpc?: unknown;
  readonly id?: Id;
  readonly method?: unknown;
  readonly params?: unknown;
};

const send = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id: Id, result: Record<string, unknown>): void => {
  send({ jsonrpc: '2.0', id, result });
};

const failRequest = (id: Id, code: number, message: string): void => {
  send({ jsonrpc: '2.0', id, error: { code, message } });
};

/** A tool's own failure is a RESULT with `isError`, never a JSON-RPC error -- the model reads it. */
const toolResult = (id: Id, text: string, isError: boolean): void => {
  respond(id, { content: [{ type: 'text', text }], isError });
};

type Spawned = { readonly code: number; readonly output: string };

/**
 * Colour escapes, stripped on the way out.
 *
 * `NO_COLOR` is set for the child as well, which is what picocolors reads -- but `paint()` in
 * `palette.ts` writes a 24-bit escape directly, because a clone's hue is its identity rather
 * than severity styling and every generated artifact needs it unconditionally. So the reader
 * strips too. Alignment survives: `ui.ts`'s `table` pads on `visibleWidth`, which already
 * ignores these, so the columns were computed as if they were not there.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Run `bin/hangar` and collect everything it said, in the order it said it.
 *
 * Async rather than `exec.ts`'s `run`, which is `spawnSync`: a `sync` that delegates to the
 * headless resolver takes minutes, and blocking the loop would freeze every other tool call
 * behind it. stdout and stderr are interleaved into one string because a CliError's message and
 * the narration leading up to it are one story, and splitting them across two fields would ask
 * the reader to reassemble it.
 */
const runHangar = async (hangar: Hangar, argv: readonly string[]): Promise<Spawned> =>
  new Promise((resolve) => {
    const child = spawn(join(hangar.root, 'bin', 'hangar'), [...argv], {
      cwd: hangar.root,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error: Error) => {
      resolve({ code: -1, output: `could not run bin/hangar: ${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, output: output.replace(ANSI, '') });
    });
  });

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const callTool = async (
  hangar: Hangar,
  program: CommandUnknownOpts,
  id: Id,
  params: Record<string, unknown>,
): Promise<void> => {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const exposure: Exposure | undefined = EXPOSURES.find((e) => e.name === name);
  if (exposure === undefined) {
    failRequest(id, -32602, `no such tool: ${name}`);
    return;
  }
  const cmd = findCommand(program, exposure.path);
  if (cmd === undefined) {
    failRequest(id, -32603, `\`hangar ${exposure.path.join(' ')}\` is not a command`);
    return;
  }

  let argv: string[];
  try {
    argv = argvFor(cmd, exposure, asRecord(params['arguments']));
  } catch (error) {
    // A bad call is the model's to correct, so it comes back as tool content rather than as a
    // protocol error -- the hint is the useful half and a JSON-RPC error would drop it.
    if (!(error instanceof CliError)) throw error;
    const hint = error.hint === undefined ? '' : `\n${error.hint}`;
    toolResult(id, `${error.message}${hint}`, true);
    return;
  }

  const { code, output } = await runHangar(hangar, argv);
  const trimmed = output.trimEnd();
  const said = trimmed === '' ? '(no output)' : trimmed;
  toolResult(
    id,
    code === 0 ? said : `hangar ${argv.join(' ')} exited ${String(code)}\n\n${said}`,
    code !== 0,
  );
};

const handle = async (
  hangar: Hangar,
  program: CommandUnknownOpts,
  request: Request,
): Promise<void> => {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = asRecord(request.params);

  switch (method) {
    case 'initialize': {
      const asked = params['protocolVersion'];
      const version =
        typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0];
      respond(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        // The CLI's version, off the registry rather than read again -- `hangar --version`
        // already resolves it from `app/package.json`, and two reads could disagree.
        serverInfo: { name: SERVER_NAME, version: program.version() ?? '0' },
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      // Notifications carry no id and take no reply. Answering one is a protocol violation.
      return;
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: toolDefinitions(program) });
      return;
    case 'tools/call':
      await callTool(hangar, program, id, params);
      return;
    default:
      // A notification for an unknown method still gets no reply: an id of undefined, not null.
      if (request.id === undefined) return;
      failRequest(id, -32601, `unsupported method: ${method}`);
  }
};

/**
 * Serve until stdin closes.
 *
 * Lines are handled as they arrive and their handlers are not awaited in order, so a `sync`
 * running for minutes does not hold up a `list` behind it. Ordering is the client's business:
 * every reply carries the id it answers.
 */
export const serveMcp = async (hangar: Hangar, program: CommandUnknownOpts): Promise<void> => {
  /*
   * Both checks run here rather than at the first `tools/list`, so a table that is wrong is a
   * server that says so at startup instead of one tool that quietly misbehaves.
   *
   * The second is the one the test suite cannot make: `dry-run` reaching an ACTING tool's schema
   * would mean the preview and the real run share a permission, and only the live registry knows
   * which commands have the flag at all.
   */
  const tools = toolDefinitions(program);
  for (const tool of tools) {
    const exposure = EXPOSURES.find((e) => e.name === tool.name);
    if (exposure?.acts !== true) continue;
    if (Object.keys(tool.inputSchema.properties).includes('dry-run')) {
      throw new CliError(
        `the MCP tool \`${tool.name}\` offers \`dry-run\` as a parameter`,
        'MCP rules cannot match arguments, so that would put the preview and the real run under\n' +
          "one permission. Add '--dry-run' to the exposure's `hides` in app/src/mcp/tools.ts.",
      );
    }
  }

  const missing = unexposedCommands(program);
  if (missing.length > 0) {
    process.stderr.write(
      `hangar mcp: no tool for ${missing.join(', ')} -- add it to app/src/mcp/tools.ts\n`,
    );
  }

  const inflight = new Set<Promise<void>>();
  let buffer = '';

  const onLine = (line: string): void => {
    const text = line.trim();
    if (text === '') return;
    let request: Request;
    try {
      request = JSON.parse(text) as Request;
    } catch {
      failRequest(null, -32700, 'parse error');
      return;
    }
    const task = handle(hangar, program, request)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (request.id !== undefined) failRequest(request.id ?? null, -32603, message);
      })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  };

  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  onLine(buffer);
  await Promise.all([...inflight]);
};
