import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { run } from './exec.ts';
import { conflictedFiles } from './git.ts';
import { note, step, warn } from './ui.ts';

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
 */
const MARKER = '<'.repeat(7);

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
 * Run one resolution pass over the currently conflicted files. Returns whether the tree is
 * clean of conflicts afterwards.
 */
export const resolveWithClaude = (
  repo: string,
  operation: string,
  target: string,
): ResolveOutcome => {
  const files = conflictedFiles(repo);
  if (files.length === 0) return { resolved: true };

  step(`asking Claude Code to resolve ${files.length} conflicted file(s)`);
  for (const file of files) note(file);

  const res = run(
    'claude',
    [
      '-p',
      prompt(operation, target, files),
      '--permission-mode',
      'acceptEdits',
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
    { cwd: repo, inherit: true },
  );

  if (!res.ok) {
    return { resolved: false, reason: `claude -p exited ${res.code}` };
  }

  const stillConflicted = conflictedFiles(repo);
  const unstaged = stillConflicted.length > 0 ? stillConflicted : files;
  const withMarkers = hasConflictMarkers(repo, unstaged);
  if (withMarkers.length > 0) {
    warn(`conflict markers remain in: ${withMarkers.join(', ')}`);
    return { resolved: false, reason: 'conflict markers remain after resolution' };
  }

  return { resolved: true };
};
