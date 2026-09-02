import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Clone } from './fleet.ts';
import { projectsDir } from './paths.ts';
import { allClaudeSessions } from './procs.ts';
import { transcriptDirFor } from './sessions.ts';

/**
 * The resumable Claude Code sessions of one clone -- what `orch-util resume` picks from.
 *
 * Claude Code's own `claude --resume` picker exists and is good; what it cannot do is leave the
 * directory it was started in. Transcripts are keyed to the session's WORKING DIRECTORY, so a
 * session started in `clone_01/angular/` is invisible to a picker opened in `clone_01/`, and no
 * clone's sessions are visible from the fleet root at all. This module gathers every transcript
 * directory belonging to a clone -- the clone root and every subdirectory a session was ever
 * started in -- and reads back enough of each transcript to tell them apart.
 *
 * Nothing here parses a whole transcript. They reach 15 MB, there are 60 of them in one clone,
 * and everything worth showing sits at one end or the other: the working directory and the
 * opening request in the first few KB, the AI-generated title and the last request in the last
 * few. So each file is read as two byte windows and nothing in between.
 */
export type ClaudeTranscript = {
  /** The session id `claude --resume` takes. */
  readonly id: string;
  readonly file: string;
  /**
   * Where the session was started, and so the directory `claude --resume` must run in. Read
   * out of the transcript's FIRST entry, never derived from the directory name: the slug is
   * lossy (`/` and `_` both become `-`, so `clone_01` is unreconstructable) and the `cwd` of
   * later entries moves with every `cd` the session made.
   */
  readonly cwd: string;
  readonly branch: string | undefined;
  /** Claude Code's own generated title, when the session lived long enough to get one. */
  readonly title: string | undefined;
  readonly firstPrompt: string | undefined;
  readonly lastPrompt: string | undefined;
  readonly startedAt: Date | undefined;
  readonly modifiedAtMs: number;
  readonly bytes: number;
  /**
   * A live `claude` in the same directory may be this very session -- resume it and the clone
   * has two sessions in it. Over-approximated on purpose; see `liveWindows`.
   */
  readonly live: boolean;
};

/** Enough for the opening entries and the first real request. */
const HEAD_BYTES = 64 * 1024;
/** Enough for the title, which Claude Code writes near the end, and the last request. */
const TAIL_BYTES = 192 * 1024;

type Entry = Record<string, unknown>;

const asRecord = (value: unknown): Entry | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Entry)
    : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** Parse the JSONL lines of a byte window, dropping the ones the window cut in half. */
const entriesIn = (chunk: string, dropFirst: boolean, dropLast: boolean): Entry[] => {
  const lines = chunk.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const entries: Entry[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const entry = asRecord(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // A truncated or half-written line tells us nothing; the other end of the file will.
    }
  }
  return entries;
};

type Windows = { readonly head: Entry[]; readonly tail: Entry[] };

const readWindows = (file: string, size: number): Windows => {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { head: [], tail: [] };
  }
  try {
    const headEnd = Math.min(size, HEAD_BYTES);
    const headBuf = Buffer.alloc(headEnd);
    readSync(fd, headBuf, 0, headEnd, 0);
    const head = entriesIn(headBuf.toString('utf8'), false, headEnd < size);
    if (headEnd >= size) return { head, tail: [] };

    const tailStart = Math.max(headEnd, size - TAIL_BYTES);
    const tailBuf = Buffer.alloc(size - tailStart);
    readSync(fd, tailBuf, 0, tailBuf.length, tailStart);
    return { head, tail: entriesIn(tailBuf.toString('utf8'), true, false) };
  } catch {
    return { head: [], tail: [] };
  } finally {
    closeSync(fd);
  }
};

/**
 * Wrappers Claude Code puts INTO a user turn: hook output, slash-command plumbing, injected
 * reminders, the editor's selection. They are the bulk of some turns and none of them is
 * something the developer typed, so a row summarising a session by them says nothing about it.
 */
const SYNTHETIC = new RegExp(
  '<(system-reminder|local-command-stdout|local-command-caveat|command-name|command-message|' +
    'command-args|user-prompt-submit-hook|session-start-hook|task-notification|ide_diagnostics|' +
    'ide_opened_file|ide_selection|remember)>[\\s\\S]*?</\\1>',
  'g',
);

/** `[Request interrupted by user]` -- Claude Code's own words in a user turn, not a request. */
const INTERRUPTION = /^\[Request interrupted[^\]]*\]$/;

/** A slash command arrives as a user turn holding the skill's entire instruction file. */
const SKILL_EXPANSION = /^Base directory for this skill: (\S+)/;

type Prompt = {
  readonly text: string;
  /** True when the turn is a slash command's expanded skill body rather than typed prose. */
  readonly skill: boolean;
};

const cleanPrompt = (raw: string): Prompt | undefined => {
  const text = raw.replace(SYNTHETIC, ' ').replace(/\s+/g, ' ').trim();
  if (text === '' || INTERRUPTION.test(text)) return undefined;
  const expansion = SKILL_EXPANSION.exec(text);
  // That body is a checked-in instruction file, word for word the same in every session that
  // ran the command, so the only part of it worth showing is which command it was.
  if (expansion?.[1] !== undefined) return { text: `/${basename(expansion[1])}`, skill: true };
  return { text, skill: false };
};

/**
 * The turn the developer actually typed, or undefined for anything else.
 *
 * Tool results arrive as user turns too, and dwarf the real ones -- a session summarised by a
 * `git log` result is worse than one summarised by nothing. Sidechain turns are a subagent's
 * conversation, not this session's.
 */
const promptOf = (entry: Entry): Prompt | undefined => {
  if (asText(entry['type']) !== 'user') return undefined;
  if (entry['isSidechain'] === true) return undefined;
  if (entry['attachment'] !== undefined) return undefined;
  const content = asRecord(entry['message'])?.['content'];
  if (typeof content === 'string') return cleanPrompt(content);
  if (!Array.isArray(content)) return undefined;
  const blocks = content.map(asRecord);
  if (blocks.some((block) => asText(block?.['type']) === 'tool_result')) return undefined;
  return cleanPrompt(blocks.map((block) => asText(block?.['text']) ?? '').join(' '));
};

/** Prose only: a `/skill` label is a fallback, never what a session is summarised by. */
const typedPrompt = (entry: Entry): string | undefined => {
  const prompt = promptOf(entry);
  return prompt !== undefined && !prompt.skill ? prompt.text : undefined;
};

const anyPrompt = (entry: Entry): string | undefined => promptOf(entry)?.text;

const firstOf = <T>(
  entries: readonly Entry[],
  pick: (entry: Entry) => T | undefined,
): T | undefined => {
  for (const entry of entries) {
    const value = pick(entry);
    if (value !== undefined) return value;
  }
  return undefined;
};

const lastOf = <T>(
  entries: readonly Entry[],
  pick: (entry: Entry) => T | undefined,
): T | undefined => {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const value = entry === undefined ? undefined : pick(entry);
    if (value !== undefined) return value;
  }
  return undefined;
};

const timestampOf = (entry: Entry): Date | undefined => {
  const raw = asText(entry['timestamp']);
  if (raw === undefined) return undefined;
  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? undefined : when;
};

const readTranscript = (file: string): ClaudeTranscript | undefined => {
  let stats: { mtimeMs: number; size: number };
  try {
    stats = statSync(file);
  } catch {
    return undefined;
  }
  const { head, tail } = readWindows(file, stats.size);
  const cwd = firstOf(head, (entry) => asText(entry['cwd']));
  if (cwd === undefined) return undefined;
  // `claude -p` runs record themselves as `sdk-cli`, and this fleet makes them: every
  // conflict `orch-util sync` resolves leaves one behind. They are not sessions anybody
  // returns to, and in clone_01 they already outnumber the real ones. An unknown entrypoint
  // (an older transcript) is kept -- the filter drops what it recognises, not what it does not.
  if (firstOf(head, (entry) => asText(entry['entrypoint']))?.startsWith('sdk') === true) {
    return undefined;
  }

  const firstPrompt = firstOf(head, typedPrompt) ?? firstOf(head, anyPrompt);
  const title =
    lastOf(tail, (entry) => asText(entry['aiTitle'])) ??
    lastOf(head, (entry) => asText(entry['aiTitle']));
  // A session with neither a title nor a single typed request is a start that never became a
  // conversation -- there is nothing to resume and nothing to show for it.
  if (firstPrompt === undefined && title === undefined) return undefined;

  const lastPrompt =
    lastOf(tail, typedPrompt) ?? lastOf(tail, anyPrompt) ?? lastOf(head, typedPrompt);
  return {
    id: basename(file).replace(/\.jsonl$/, ''),
    file,
    cwd,
    branch:
      lastOf(tail, (entry) => asText(entry['gitBranch'])) ??
      firstOf(head, (entry) => asText(entry['gitBranch'])),
    title,
    firstPrompt,
    lastPrompt: lastPrompt === firstPrompt ? undefined : lastPrompt,
    startedAt: firstOf(head, timestampOf),
    modifiedAtMs: stats.mtimeMs,
    bytes: stats.size,
    live: false,
  };
};

/**
 * Every transcript directory belonging to this clone.
 *
 * `name === slug || name.startsWith(slug + '-')` and not a bare prefix test: the slug of
 * `clone_01` is a string prefix of the slug of `clone_010`, and a loose test would quietly
 * offer one clone's sessions in another clone's picker.
 */
export const transcriptDirsForClone = (clone: Clone): string[] => {
  const slug = basename(transcriptDirFor(clone.path));
  try {
    return readdirSync(projectsDir)
      .filter((name) => name === slug || name.startsWith(`${slug}-`))
      .map((name) => join(projectsDir, name));
  } catch {
    return [];
  }
};

const transcriptFilesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
};

/**
 * Directories that have a live `claude` in them, with the time it started.
 *
 * There is no way to ask a running session which transcript it owns -- it appends and closes,
 * so it does not even hold the file open. So "live" is: a transcript in a directory that has a
 * running session, appended to since that session started. That over-counts (an older
 * transcript touched by `plans collect`, two sessions in one directory) and never under-counts,
 * which is the right way round: the cost of a false positive is one extra question.
 */
const liveWindows = (): Map<string, number> => {
  const windows = new Map<string, number>();
  const fallback = Date.now() - 30 * 60_000;
  for (const session of allClaudeSessions()) {
    const since = session.startedAtMs ?? fallback;
    const known = windows.get(session.cwd);
    if (known === undefined || since < known) windows.set(session.cwd, since);
  }
  return windows;
};

/** This clone's resumable sessions, most recently active first. */
export const claudeTranscripts = (clone: Clone): ClaudeTranscript[] => {
  const files = transcriptDirsForClone(clone).flatMap(transcriptFilesIn);
  const live = liveWindows();
  const found: ClaudeTranscript[] = [];
  for (const file of files) {
    const transcript = readTranscript(file);
    if (transcript === undefined) continue;
    const since = live.get(transcript.cwd);
    found.push(
      since !== undefined && transcript.modifiedAtMs >= since
        ? { ...transcript, live: true }
        : transcript,
    );
  }
  return found.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
};
