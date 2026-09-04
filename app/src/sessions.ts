import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run } from './exec.ts';
import { projectsDir } from './user-paths.ts';
import { allClaudeSessions, type ClaudeSession } from './procs.ts';
import type { Hangar } from './hangar.ts';

/**
 * Which plan files a live agent is still using.
 *
 * Renaming or moving a plan out from under a running session breaks it: the session holds the
 * absolute path and its next edit fails. Nothing in Claude Code locks a plan file or records
 * which session owns it, so this is reconstructed from two signals it does leave behind:
 *
 *   1. the live `claude` processes and the directory each was started in (`procs.ts`), and
 *   2. the session transcripts under `~/.claude/projects/<slug>/`, which mention every plan
 *      file the session touched -- as a `file-history-delta` `trackingPath`, as a tool input,
 *      or in plan-mode reminders.
 *
 * The transcript is appended to as the session runs, so "mentioned in a transcript that has
 * been written since a live session started" is a sound over-approximation. It is deliberately
 * an over-approximation: skipping a rename costs nothing, renaming a live plan costs a session.
 */

/** Claude Code's transcript directory for a working directory: `/` and `_` both become `-`. */
export const transcriptDirFor = (cwd: string): string =>
  join(projectsDir, cwd.replaceAll('/', '-').replaceAll('_', '-'));

/** Every transcript directory belonging to this fleet -- the clones and the fleet root itself. */
const fleetTranscriptDirs = (hangar: Hangar): string[] => {
  const prefix = basename(transcriptDirFor(hangar.root));
  try {
    return readdirSync(projectsDir)
      .filter((name) => name === prefix || name.startsWith(`${prefix}-`))
      .map((name) => join(projectsDir, name));
  } catch {
    return [];
  }
};

const transcriptsIn = (dir: string, modifiedAfterMs: number): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const path = join(dir, entry);
    try {
      if (statSync(path).mtimeMs >= modifiedAfterMs) found.push(path);
    } catch {
      // A transcript that vanished mid-scan is not in use.
    }
  }
  return found;
};

const PLAN_PATH = '[^"\\\\ ]*/plans/[^"\\\\ ]+\\.md';

/**
 * A path Claude Code recorded as WRITTEN, not merely mentioned. A plan path can appear in a
 * transcript for uninteresting reasons -- a directory listing, a grep result, prose about
 * plans -- and counting those as "in use" leaves months-old plans uncollectable for as long
 * as one session stays alive. `file-history-delta.trackingPath` is emitted only when the
 * session actually wrote the file, which is exactly the risk being guarded against.
 */
const TRACKED_PLAN_PATH = `"trackingPath":"${PLAN_PATH}"`;

/** Every `.../plans/<name>.md` path matching `pattern` in these transcripts, as basenames. */
const planFilesMatching = (transcripts: readonly string[], pattern: string): Set<string> => {
  const names = new Set<string>();
  if (transcripts.length === 0) return names;
  // One grep over the transcripts rather than reading them into memory: the largest are
  // several hundred MB, and `-o` keeps only the matches.
  const res = run('grep', ['-ohE', pattern, ...transcripts]);
  for (const line of res.stdout.split('\n')) {
    const name = line.trim().replace(/"$/, '').split('/').pop();
    if (name?.endsWith('.md') !== true) continue;
    // Transcripts also contain prose ABOUT plan paths -- `<name>.md`, `*.md` -- which are not
    // filenames. They can never match a real plan, but they make the report unreadable.
    if (/[*<>?]/.test(name)) continue;
    names.add(name);
  }
  return names;
};

export type InUsePlans = {
  /** Plan file basenames that must not be moved or renamed, and why. */
  readonly names: Map<string, string>;
  readonly sessions: readonly ClaudeSession[];
};

/**
 * Plan files a live session may still be holding, by two rules:
 *
 *   - **written** by a session whose transcript has been appended to since the oldest live
 *     session started. A session's plan slug is stable for its whole life, so a session that
 *     wrote a plan file can rewrite the same one hours later on re-entering plan mode.
 *   - **mentioned at all** in a transcript written within `windowMinutes` -- the belt for a
 *     session that is mid-plan but has not written the file yet, and for a session whose pid
 *     or cwd could not be read (an IDE-hosted one, say).
 */
export const planFilesInUse = (hangar: Hangar, windowMinutes = 30): InUsePlans => {
  const sessions = allClaudeSessions().filter(
    (s) => s.cwd === hangar.root || s.cwd.startsWith(`${hangar.root}/`),
  );
  const belt = Date.now() - windowMinutes * 60_000;
  const starts = sessions.map((s) => s.startedAtMs).filter((ms) => ms !== undefined);
  // An unparsed start time must not narrow the scan, so fall back to the belt only.
  const cutoff = starts.length === 0 ? belt : Math.min(belt, ...starts);

  const dirs = new Set<string>(fleetTranscriptDirs(hangar));
  for (const session of sessions) dirs.add(transcriptDirFor(session.cwd));

  const live = [...dirs].filter((dir) => existsSync(dir));
  const names = new Map<string, string>();
  const written = planFilesMatching(
    live.flatMap((dir) => transcriptsIn(dir, cutoff)),
    TRACKED_PLAN_PATH,
  );
  for (const name of written) names.set(name, 'a live session wrote it');

  const recent = live.flatMap((dir) => transcriptsIn(dir, Date.now() - windowMinutes * 60_000));
  for (const name of planFilesMatching(recent, PLAN_PATH)) {
    if (!names.has(name)) {
      names.set(name, `named in a transcript written in the last ${windowMinutes} min`);
    }
  }
  return { names, sessions };
};

/** Every plan file this fleet's transcripts have EVER mentioned -- the attribution signal. */
export const planFilesEverMentioned = (hangar: Hangar): Set<string> =>
  planFilesMatching(
    fleetTranscriptDirs(hangar).flatMap((dir) => transcriptsIn(dir, 0)),
    PLAN_PATH,
  );

/**
 * When a fleet transcript first mentioned this plan file -- the last resort for a plan whose
 * filesystem timestamps were destroyed by a bulk copy.
 */
export const firstMentionOf = (hangar: Hangar, planFile: string): Date | undefined => {
  let earliest: Date | undefined;
  for (const dir of fleetTranscriptDirs(hangar)) {
    for (const transcript of transcriptsIn(dir, 0)) {
      const res = run('awk', [
        '-v',
        `needle=${planFile}`,
        'index($0, needle) { if (match($0, /"timestamp":"[^"]+"/)) { print substr($0, RSTART + 13, RLENGTH - 14); exit } }',
        transcript,
      ]);
      const stamp = res.stdout.trim().split('\n')[0];
      if (stamp === undefined || stamp === '') continue;
      const when = new Date(stamp);
      if (Number.isNaN(when.getTime())) continue;
      if (earliest === undefined || when < earliest) earliest = when;
    }
  }
  return earliest;
};
