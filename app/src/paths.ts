import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Every path the fleet CLI touches, resolved once.
 *
 * The fleet root is derived from this file's location rather than `process.cwd()`, so
 * `hangar` behaves identically when invoked from a clone, from a subdirectory, or through
 * a shell alias. `HANGAR_ROOT` still overrides it, matching the shell helpers.
 *
 * Two levels up, because this file is `<fleet>/app/src/paths.ts`. The CLI's package
 * deliberately does NOT sit at the fleet root: that directory is an ancestor of every clone,
 * so a package.json there is the nearest one for every clone file outside `angular/`.
 */
export const fleetRoot = resolve(
  process.env['HANGAR_ROOT'] ?? resolve(import.meta.dirname, '..', '..'),
);

export const home = homedir();
export const claudeDir = join(home, '.claude');
export const themesDir = join(claudeDir, 'themes');

/**
 * A VS Code-family editor's window state -- which workspace each window has open. Written by the
 * editor as windows come and go, so it is LAST KNOWN rather than live; see `openWorkspaceFile`.
 *
 * Takes the directory name because every fork has its own: `Code`, `Cursor`, `Windsurf`,
 * `Code - Insiders`. Reading the wrong one answers about a different application's windows.
 */
export const vscodeWindowState = (stateDir = 'Code'): string =>
  join(home, 'Library', 'Application Support', stateDir, 'User', 'globalStorage', 'storage.json');

/** Claude Code's session transcripts, one directory per working directory a session started in. */
export const projectsDir = join(claudeDir, 'projects');

/**
 * The shared plan archive. A fleet-root session writes here directly (`plansDirectory: "plans"`);
 * the clones write to their own `.claude/plans` and `hangar plans collect` moves them in.
 */
export const fleetPlans = join(fleetRoot, 'plans');

/**
 * The one shared `tmp/`: every clone's `tmp` is a symlink to it, so a Jira ticket fetched in
 * one clone is there for all of them. PID files stay per clone in `tmp/_<clone>/`.
 */
export const fleetTmp = join(fleetRoot, 'tmp');

/** Where plans land when `plansDirectory` is absent or rejected -- shared with other projects. */
export const userPlans = join(claudeDir, 'plans');

/** The one shared statusline script -- all clones run it; it derives its hue from the cwd. */
export const statuslineScript = join(claudeDir, 'dvb-clone-statusline.sh');

/**
 * The one record per Jira ticket: `tmp/jira-tickets/ABC-1234.md`.
 *
 * Every name the per-ticket cache gives that ticket -- its own `tmp/ABC-1234/ticket_ABC-1234.md`
 * and every `tmp/<TRUNK>/ticket_<TRUNK>_<relation>_ABC-1234.md` -- is a HARD link to this file,
 * so one ticket is one inode however many investigations reached it. See `jira-records.ts`.
 *
 * Deliberately NOT linked into the clones like the other store entries: no skill owns this
 * path, and a symlink in `clone_NN/tmp/` would invite an agent to write into it.
 */
export const jiraTicketsDir = join(fleetTmp, 'jira-tickets');

/** Fleet-wide secrets, outside every clone so no clone can commit them. */
export const envShared = join(fleetRoot, '.env.shared');

/** Generated shell artifacts that live in the fleet root. */
export const cloneColoursScript = join(fleetRoot, 'clone-colours.sh');

/**
 * The shell hook that colours the terminal when a shell moves into a clone.
 *
 * `.sh`, not `.zsh`: it supports bash as well now, and it is generated rather than
 * hand-maintained because its function names carry the hangar id -- two hangars sourced into one
 * shell must not clobber each other's hook. Source it from `~/.zshrc` or `~/.bashrc`.
 */
export const terminalHookScript = join(fleetRoot, 'clone-terminal.sh');

export const originUrl = 'git@bitbucket.org:acme/storefront_ui.git';
export const bitbucketWorkspaceUrl = 'https://bitbucket.org/acme';
export const bitbucketRepo = 'storefront_ui';
export const atlassianUrl = 'https://acme.atlassian.net';

/** Render an absolute path under $HOME as `~/...` for output. */
export const tildify = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

/**
 * Explicit clone -> colour assignments, written by `hangar colours change`.
 *
 * Distinct from the generated `clone-colours.sh` beside it: that one is OUTPUT (a hue table for
 * the shell), this one is INPUT, and it is the only per-clone value in the fleet that is not
 * derived from the clone index.
 */
export const colourAssignmentsFile = join(fleetRoot, 'colour-assignments.json');
