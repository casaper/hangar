import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The paths that belong to the USER, not to any hangar.
 *
 * Split out of `paths.ts` for one reason, and it is the reason a lazy config singleton is not
 * needed anywhere in this CLI: everything here is a pure function of `homedir()`, so it is
 * correct at import time and stays correct however many hangars a process handles. Everything
 * that was derived from a hangar root moved to `HangarPaths`, and `paths.ts` -- by then four
 * literals naming this fleet's own Bitbucket repo and Jira -- is gone.
 *
 * The test for whether a path belongs here: would two hangars on one machine disagree about
 * it? `~/.claude` is the same directory for both, so it belongs here. A statusline script
 * INSIDE `~/.claude` is named per hangar, so it does not.
 */
export const home = homedir();
export const claudeDir = join(home, '.claude');
export const themesDir = join(claudeDir, 'themes');

/** Claude Code's session transcripts, one directory per working directory a session started in. */
export const projectsDir = join(claudeDir, 'projects');

/** Where plans land when `plansDirectory` is absent or rejected -- shared with other projects. */
export const userPlans = join(claudeDir, 'plans');

/**
 * A VS Code-family editor's window state -- which workspace each window has open. Written by the
 * editor as windows come and go, so it is LAST KNOWN rather than live; see `openWorkspaceFile`.
 *
 * Takes the directory name because every fork has its own: `Code`, `Cursor`, `Windsurf`,
 * `Code - Insiders`. Reading the wrong one answers about a different application's windows.
 *
 * macOS only as written. The Linux location is
 * `~/.config/<stateDir>/User/globalStorage/storage.json`, and getting that wrong is not
 * cosmetic: this file is how `open` notices a clone's workspace is ALREADY open, and a
 * workspace opened twice is how two Claude Code sessions end up in one clone.
 */
export const vscodeWindowState = (stateDir = 'Code'): string =>
  join(home, 'Library', 'Application Support', stateDir, 'User', 'globalStorage', 'storage.json');

/** Render an absolute path under $HOME as `~/...` for output. */
export const tildify = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
