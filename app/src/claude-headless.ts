import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import pc from 'picocolors';

import { note, truncate } from './ui.ts';

/**
 * One headless Claude Code run inside a clone, streamed so a human can watch it happen.
 *
 * Two commands delegate to this, for the same reason: a merge conflict and a reviewer-facing pull
 * request description are both things a deterministic CLI cannot produce, and both have a correct
 * answer that needs the clone's own code, conventions and CLAUDE.md in context. So the CLI owns
 * the mechanism and hands the judgement to `claude -p` in the clone -- then VERIFIES the result
 * mechanically. Nothing here believes anything the model says; the caller checks the tree, or the
 * file, afterwards.
 *
 * ## Why this streams, and why it also listens
 *
 * `claude -p` in its default `text` output format prints NOTHING until the whole run has
 * finished -- not a tool call, not a retry. A real run takes one to three minutes and the API's
 * own backoff can add tens of seconds of dead air, which with output inherited to the terminal is
 * indistinguishable from a wedged process. It was read as exactly that: a 110-second resolution
 * was abandoned at the 60-second mark and done by hand instead, leaving a rebase half-applied.
 * A static "this takes a while" banner cannot fix it, because it cannot tell working from wedged,
 * which is the only thing the human needs to know. So the run uses `--output-format stream-json`
 * and every event is rendered as one dim line as it happens, with a heartbeat into any longer
 * silence.
 *
 * Watching is worth little if a wrong turn can only be corrected by waiting for the run to end,
 * so `--input-format stream-json` makes the child's stdin a stream of further user messages and a
 * line typed at the terminal is forwarded into the run, picked up at its next turn. That is a
 * second INPUT and not a second authority: whatever the caller verifies afterwards, it verifies
 * the same way.
 *
 * **This module was extracted from `resolve-conflicts.ts` rather than copied**, and the reason is
 * the paragraph above: every sentence of it is a measurement, and a second copy of the loop would
 * be free to lose one of them silently. What stayed behind there is the conflict prompt and the
 * marker verification -- the parts that are about conflicts rather than about running a session.
 */

/** `10m` / `45s` -- a bare `0m` for a short override is worse than saying nothing. */
export const humanMs = (ms: number): string =>
  ms >= 60_000 ? `${String(Math.round(ms / 60_000))}m` : `${String(Math.round(ms / 1000))}s`;

/** The event's `type`, or undefined for anything that is not a tagged object. */
const eventType = (event: unknown): string | undefined => {
  if (typeof event !== 'object' || event === null) return undefined;
  const type = (event as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : undefined;
};

const LINE_WIDTH = 96;

/** `mm:ss` since the run started, so a long quiet stretch is still visibly progressing. */
const elapsed = (startedAt: number): string => {
  const total = Math.round((Date.now() - startedAt) / 1000);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
};

const firstLine = (text: string): string =>
  (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();

/** The stream is `unknown` at every level, so every field read has to narrow before printing. */
const asText = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
};

/**
 * The one interesting field of a tool call, so the line reads `Edit CLAUDE.md` rather than a
 * wall of JSON. Anything unrecognised prints the tool name alone.
 */
const toolTarget = (input: unknown): string => {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'command', 'pattern', 'path']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return firstLine(value);
  }
  return '';
};

type StreamRender = {
  /** The model's closing summary, which is the run's real output. */
  finalText: string;
  sessionId: string | undefined;
  /** When the last line was PRINTED -- not when the last event arrived. See `emit`. */
  lastAt: number;
  /**
   * Replayed user messages seen so far. The FIRST is the prompt this command sent itself, whose
   * subject is already on screen above it; the operator's own lines are every one after that,
   * and those are the ones worth a line.
   */
  replays: number;
};

/**
 * Events arrive one per assistant message, so a single long tool call or a slow turn can
 * still leave a minute of nothing on screen -- observed: a 73-second gap inside a 92-second
 * run. The heartbeat guarantees a line every few seconds no matter what the model is doing,
 * which is what makes "working" distinguishable from "wedged" at a glance.
 */
const HEARTBEAT_MS = 15_000;

/**
 * One line of the run's stdin protocol.
 *
 * Pure and exported because it is a contract with another program: a field of the wrong shape is
 * a message silently ignored rather than an error, and the only other way to check it is a live
 * `claude -p`. `content` is a plain string, which the protocol accepts alongside a block array,
 * and `parent_tool_use_id` is null because this is a person talking to the session rather than a
 * tool result being handed back into one.
 */
export const userMessageLine = (text: string): string =>
  `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  })}\n`;

/**
 * Render one `stream-json` event. Whitelisted on purpose: the stream also carries whole
 * SessionStart hook payloads and full tool results, and echoing those is worse than silence.
 */
const renderEvent = (event: unknown, startedAt: number, state: StreamRender): void => {
  if (typeof event !== 'object' || event === null) return;
  const e = event as Record<string, unknown>;
  // Every print goes through `emit`, which is also the only thing that resets the heartbeat
  // clock. Setting `lastAt` per EVENT instead would let silent traffic -- tool results, hook
  // payloads, rate-limit notices, of which there is plenty in a real clone -- keep pushing it
  // forward and suppress the heartbeat during exactly the long quiet stretch it exists for.
  const emit = (line: string): void => {
    console.log(`${pc.dim(`    ${elapsed(startedAt).padStart(5)}  `)}${line}`);
    state.lastAt = Date.now();
  };

  if (e['type'] === 'system' && e['subtype'] === 'init') {
    const id = e['session_id'];
    if (typeof id === 'string') state.sessionId = id;
    return;
  }
  // A user message coming back out is one of ours going in: `--replay-user-messages` echoes each
  // line stdin accepted, which is the only proof an instruction was delivered rather than typed
  // into a pipe that had already gone.
  if (e['type'] === 'user' && e['isReplay'] === true) {
    state.replays += 1;
    if (state.replays === 1) return;
    const message = e['message'];
    const content =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)['content']
        : undefined;
    if (typeof content === 'string') {
      emit(pc.cyan(truncate(`→ sent: ${firstLine(content)}`, LINE_WIDTH)));
    }
    return;
  }
  if (e['type'] === 'system' && e['subtype'] === 'api_retry') {
    const reason = asText(e['error'], asText(e['error_status'], 'error'));
    const attempt = asText(e['attempt'], '?');
    emit(pc.yellow(`retrying (${reason}) — attempt ${attempt}`));
    return;
  }
  if (e['type'] !== 'assistant') return;

  const message = e['message'];
  const content =
    typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>)['content']
      : undefined;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'tool_use') {
      const name = asText(b['name'], '?');
      const target = toolTarget(b['input']);
      emit(pc.dim(truncate(`${name} ${target}`.trim(), LINE_WIDTH)));
    } else if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim() !== '') {
      state.finalText = b['text'];
      emit(pc.dim(truncate(firstLine(b['text']), LINE_WIDTH)));
    }
  }
};

export type HeadlessRun = {
  /** The clone directory. The run's cwd, so the repo's own CLAUDE.md and skills load. */
  readonly repo: string;
  readonly prompt: string;
  /**
   * The tools the run may use without being asked. Variadic on the command line, so this goes
   * LAST in argv -- `--allowedTools` eats arguments until the next `-` flag.
   */
  readonly allowedTools: readonly string[];
  readonly permissionMode: 'acceptEdits' | 'default' | 'plan';
  readonly timeoutMs: number;
  /** Whether a line typed at the terminal is forwarded into the run. See the header. */
  readonly interactive?: boolean | undefined;
};

export type HeadlessOutcome = {
  /** The process exited 0 and was not killed. Says nothing about whether the WORK is right. */
  readonly ok: boolean;
  /** The model's closing message. Reported, never trusted. */
  readonly finalText: string;
  /** The transcript to read afterwards, when the stream said. */
  readonly sessionId: string | undefined;
  readonly reason?: string | undefined;
};

/**
 * Run it, stream it, and hand back what happened.
 *
 * Never throws: a caller that has just spawned an agent into a working tree needs to report the
 * outcome and then check the tree, and an exception thrown past it would lose both.
 */
export const runHeadlessClaude = async (run: HeadlessRun): Promise<HeadlessOutcome> => {
  const startedAt = Date.now();
  const state: StreamRender = {
    finalText: '',
    sessionId: undefined,
    lastAt: Date.now(),
    replays: 0,
  };

  const child = spawn(
    'claude',
    [
      '-p',
      // The prompt goes in over stdin as the first user message rather than as an argv prompt,
      // because stdin is a channel that stays open: `--input-format stream-json` is what lets
      // the operator add an instruction to a run already under way, and `--replay-user-messages`
      // echoes each accepted line back so a delivery can be shown rather than assumed.
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      run.permissionMode,
      // Variadic (`<tools...>`): it eats argv until the next `-` flag, so it stays LAST.
      '--allowedTools',
      ...run.allowedTools,
    ],
    { cwd: run.repo, stdio: ['pipe', 'pipe', 'inherit'] },
  );

  const toChild = child.stdin;
  toChild.on('error', () => {
    // The child is already gone. A write racing its exit is not a failure of the run, and an
    // unhandled EPIPE here would take the whole command down with it.
  });
  toChild.write(userMessageLine(run.prompt));

  /**
   * Whether the operator has typed something that has not had a turn yet.
   *
   * The session does not exit on its own: it finishes a turn and waits for more input, so EOF is
   * what ends it. A queued line is picked up as the NEXT turn, though -- so closing stdin at the
   * first `result` would drop an instruction typed a second earlier, and every turn that follows
   * one gets to run before EOF.
   */
  let pending = false;
  const endTurn = (): void => {
    if (pending) pending = false;
    else toChild.end();
  };

  /**
   * The operator's way in, and it exists only where somebody could be typing.
   *
   * `process.stdin.isTTY` is the whole condition: an agent driving this through a Bash tool, a
   * script or a `SessionEnd` hook has no terminal, so no reader is attached and the run is the
   * fire-and-forget one -- prompt in, EOF, done. `terminal: false` on purpose: a readline that
   * owns the tty puts it in raw mode and takes over Ctrl-C, and interrupting the command that is
   * waiting on this has to keep working.
   */
  const typed =
    run.interactive === true && process.stdin.isTTY
      ? createInterface({ input: process.stdin, terminal: false })
      : undefined;
  if (typed === undefined) toChild.end();
  else {
    note(pc.dim('type a line + Enter to instruct the run — it lands at its next turn'));
    typed.on('line', (line) => {
      if (line.trim() === '') return;
      pending = true;
      toChild.write(userMessageLine(line));
    });
  }

  // The timeout is read back off the child (`killed` is set by `kill()`) rather than from a
  // local flag: the only assignment would be inside the callback, which TS's control-flow
  // analysis cannot see, so the later `if` would be typed as always-false.
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, run.timeoutMs);

  const heartbeat = setInterval(() => {
    if (Date.now() - state.lastAt < HEARTBEAT_MS) return;
    state.lastAt = Date.now();
    console.log(pc.dim(`    ${elapsed(startedAt).padStart(5)}  still working…`));
  }, HEARTBEAT_MS / 3);

  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (line.trim() === '') return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Not JSON. Something on the clone's stdout that is not part of the protocol; the
      // render loop must survive it rather than take the whole command down.
      return;
    }
    renderEvent(event, startedAt, state);
    if (eventType(event) === 'result') endTurn();
  });

  const code = await new Promise<number>((resolve) => {
    child.on('error', () => {
      resolve(-1);
    });
    child.on('close', (status) => {
      resolve(status ?? -1);
    });
  });
  clearTimeout(timer);
  clearInterval(heartbeat);
  reader.close();
  if (typed !== undefined) {
    // Give the terminal back. The caller reads it again straight afterwards -- a `confirm()`, or
    // a `git rebase --continue` that runs with stdio inherited -- and a reader still attached
    // would be a second consumer of the same keystrokes, which looks nothing like its cause.
    typed.close();
    process.stdin.pause();
  }

  if (state.sessionId !== undefined) {
    note(pc.dim(`headless session ${state.sessionId} (${elapsed(startedAt)})`));
  }
  if (child.killed) {
    return {
      ok: false,
      finalText: state.finalText,
      sessionId: state.sessionId,
      reason: `claude -p timed out after ${elapsed(startedAt)}`,
    };
  }
  if (code !== 0) {
    return {
      ok: false,
      finalText: state.finalText,
      sessionId: state.sessionId,
      reason: `claude -p exited ${String(code)}`,
    };
  }
  return { ok: true, finalText: state.finalText, sessionId: state.sessionId };
};
