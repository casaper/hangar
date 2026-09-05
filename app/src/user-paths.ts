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

/*
 * `vscodeWindowState` used to live here, and moved to `platform/` at F11.
 *
 * It looked like a user path -- one directory under `$HOME`, the same for every hangar -- and
 * that is exactly what made it wrong. The test above asks whether two HANGARS would disagree
 * about a path; it does not ask whether two PLATFORMS would, and this one is
 * `~/Library/Application Support/…` on macOS and `~/.config/…` on Linux. Anything here that
 * turns out to differ by platform belongs on that seam, not in this file.
 */

/** Render an absolute path under $HOME as `~/...` for output. */
export const tildify = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
