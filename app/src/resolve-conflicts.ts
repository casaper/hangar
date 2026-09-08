import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import pc from 'picocolors';

import { conflictedFiles } from './git.ts';
import { note, step, truncate, warn } from './ui.ts';

/**
 * Conflict resolution, delegated to a headless Claude Code run inside the clone.
 *
 * A deterministic CLI cannot resolve a merge conflict. `-X ours` / `-X theirs` and
 * `git rerere` look like resolution but silently produce wrong code, which is strictly worse
 * than stopping. So the CLI hands the conflicted files to `claude -p` in the clone -- where
 * the project's own CLAUDE.md, skills and conventions load -- and then VERIFIES the result
 * mechanically: no unmerged paths, and no conflict markers left in any file it touched.
 *
 * If verification fails the caller aborts the whole operation and restores the pre-sync
 * state. Nothing here is trusted on the model's say-so.
 *
 * ## Why this streams
 *
 * `claude -p` in its default `text` output format prints NOTHING until the whole run has
 * finished -- not a tool call, not a retry, nothing. A real resolution takes one to three
 * minutes, and the API's own 529 backoff can add tens of seconds of dead air on top. With
 * output inherited straight to the terminal that is indistinguishable from a wedged process,
 * and it was read as exactly that: a 110-second run was abandoned at the 60-second mark and
 * resolved by hand instead, leaving the rebase half-applied.
 *
 * A static "this takes a while" banner cannot fix that, because it cannot tell working from
 * wedged -- which is the only thing the human needs to know. So the run uses
 * `--output-format stream-json`, and every event is rendered as one dim line as it happens.
 * This is a DISPLAY change only: the mechanical verification below is untouched, and nothing
 * the model says on the stream is believed.
 *
 * ## Why it also listens
 *
 * Watching those lines go by is worth little if the only way to correct a wrong choice is to
 * wait for the run to end and start over. `--input-format stream-json` makes the child's stdin a
 * stream of further user messages, so a line the operator types is forwarded into the run and
 * picked up at its next turn. That is a second INPUT, not a second authority: the tree it
 * produces is checked exactly as before, and an instruction cannot talk this command into
 * accepting conflict markers.
 */
const MARKER = '<'.repeat(7);

/** Generous: a legitimate resolution runs 1-3 minutes, so this only catches a true hang. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** `10m` / `45s` -- a bare `0m` for a short override is worse than saying nothing. */
const humanMs = (ms: number): string =>
  ms >= 60_000 ? `${String(Math.round(ms / 60_000))}m` : `${String(Math.round(ms / 1000))}s`;

const timeoutMs = (): number => {
  const raw = process.env['ORCH_UTIL_RESOLVE_TIMEOUT_MS'];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
};

export const hasConflictMarkers = (repo: string, files: readonly string[]): string[] =>
  files.filter((file) => {
    try {
      return readFileSync(join(repo, file), 'utf8').includes(MARKER);
    } catch {
      return false;
    }
  });

export type ResolveOutcome = {
  readonly resolved: boolean;
  readonly reason?: string | undefined;
};

const prompt = (operation: string, target: string, files: readonly string[]): string =>
  [
    `You are resolving git conflicts in this repository after a \`git ${operation}\` onto ${target}.`,
    '',
    'Conflicted files:',
    ...files.map((f) => `  ${f}`),
    '',
    'For each file: read it, understand BOTH sides, and write the correct combined result.',
    'Keep the incoming changes from the target branch AND the work that was on this branch --',
    'the point of the sync is to have both. Never resolve by wholesale picking one side unless',
    'that is genuinely correct for that hunk.',
    '',
    'Rules:',
    '- Remove every conflict marker. No marker may survive anywhere.',
    '- Do NOT run `git rebase --continue`, `git merge --continue`, `git commit`, or any git',
    '  command that advances the operation. Edit the files only; the caller drives git.',
    '- Do NOT amend, reset, or abort anything.',
    '- If a conflict is genuinely ambiguous and you cannot resolve it correctly, leave that',
    '  file conflicted and say so plainly in your final message rather than guessing.',
    '',
    'When done, state one line per file describing what you kept.',
  ].join('\n');

/**
 * One line of the resolver's stdin protocol.
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
  /** The model's closing summary -- one line per file -- which is the run's real output. */
  finalText: string;
  sessionId: string | undefined;
  /** When the last line was PRINTED -- not when the last event arrived. See `emit`. */
  lastAt: number;
  /**
   * Replayed user messages seen so far. The FIRST is the prompt this command sent itself, whose
   * subject is already on screen as the file list above it; the operator's own lines are every
   * one after that, and those are the ones worth a line.
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

/**
 * Run one resolution pass over the currently conflicted files. Returns whether the tree is
 * clean of conflicts afterwards.
 */
export const resolveWithClaude = async (
  repo: string,
  operation: string,
  target: string,
): Promise<ResolveOutcome> => {
  const files = conflictedFiles(repo);
  if (files.length === 0) return { resolved: true };

  step(`asking Claude Code to resolve ${files.length} conflicted file(s)`);
  for (const file of files) note(file);
  note('a headless Claude Code run is now editing files in this clone — leave it alone');
  note(`progress follows; typically 1-3 minutes, aborted after ${humanMs(timeoutMs())}`);

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
      'acceptEdits',
      // Variadic (`<tools...>`): it eats argv until the next `-` flag, so it stays LAST.
      '--allowedTools',
      'Read',
      'Edit',
      'Write',
      'Grep',
      'Glob',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
    ],
    { cwd: repo, stdio: ['pipe', 'pipe', 'inherit'] },
  );

  const toChild = child.stdin;
  toChild.on('error', () => {
    // The child is already gone. A write racing its exit is not a failure of the resolution,
    // and an unhandled EPIPE here would take the whole sync down with it.
  });
  toChild.write(userMessageLine(prompt(operation, target, files)));

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
   * `process.stdin.isTTY` is the whole condition: an agent driving `hangar sync` through a Bash
   * tool, a script or a `SessionEnd` hook has no terminal, so no reader is attached and the run
   * is the fire-and-forget one -- prompt in, EOF, done. `terminal: false` on purpose: a readline
   * that owns the tty puts it in raw mode and takes over Ctrl-C, and interrupting a sync has to
   * keep working while this is attached.
   */
  const typed = process.stdin.isTTY
    ? createInterface({ input: process.stdin, terminal: false })
    : undefined;
  if (typed === undefined) toChild.end();
  else {
    note(pc.dim('type a line + Enter to instruct the resolver — it lands at its next turn'));
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
  }, timeoutMs());

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
      // render loop must survive it rather than take the whole sync down.
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
    // Give the terminal back. `sync` reads it again straight afterwards -- its own `confirm()`,
    // and a `git rebase --continue` that runs with stdio inherited -- and a reader still attached
    // would be a second consumer of the same keystrokes, which looks nothing like its cause.
    typed.close();
    process.stdin.pause();
  }

  if (state.sessionId !== undefined) {
    note(pc.dim(`headless session ${state.sessionId} (${elapsed(startedAt)})`));
  }
  if (child.killed) {
    return { resolved: false, reason: `claude -p timed out after ${elapsed(startedAt)}` };
  }
  if (code !== 0) {
    return { resolved: false, reason: `claude -p exited ${String(code)}` };
  }
  if (state.finalText !== '') for (const line of state.finalText.split('\n')) note(line);

  const stillConflicted = conflictedFiles(repo);
  const unstaged = stillConflicted.length > 0 ? stillConflicted : files;
  const withMarkers = hasConflictMarkers(repo, unstaged);
  if (withMarkers.length > 0) {
    warn(`conflict markers remain in: ${withMarkers.join(', ')}`);
    return { resolved: false, reason: 'conflict markers remain after resolution' };
  }

  return { resolved: true };
};
