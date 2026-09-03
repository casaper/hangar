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
  const state: StreamRender = { finalText: '', sessionId: undefined, lastAt: Date.now() };

  const child = spawn(
    'claude',
    [
      '-p',
      prompt(operation, target, files),
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
    { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] },
  );

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
    try {
      renderEvent(JSON.parse(line), startedAt, state);
    } catch {
      // Not JSON. Something on the clone's stdout that is not part of the protocol; the
      // render loop must survive it rather than take the whole sync down.
    }
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
