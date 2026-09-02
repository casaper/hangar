import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Every path the fleet CLI touches, resolved once.
 *
 * The fleet root is derived from this file's location rather than `process.cwd()`, so
 * `orch-util` behaves identically when invoked from a clone, from a subdirectory, or through
 * a shell alias. `DVB_FLEET_ROOT` still overrides it, matching the shell helpers.
 *
 * Two levels up, because this file is `<fleet>/orch/src/paths.ts`. The CLI's package
 * deliberately does NOT sit at the fleet root: that directory is an ancestor of every clone,
 * so a package.json there is the nearest one for every clone file outside `angular/`.
 */
export const fleetRoot = resolve(
  process.env['DVB_FLEET_ROOT'] ?? resolve(import.meta.dirname, '..', '..'),
);

export const home = homedir();
export const claudeDir = join(home, '.claude');
export const themesDir = join(claudeDir, 'themes');

/**
 * VS Code's own window state -- which workspace each window has open. Written by VS Code as
 * windows come and go, so it is LAST KNOWN rather than live; see `openWorkspaceFile`.
 */
export const vscodeWindowState = join(
  home,
  'Library',
  'Application Support',
  'Code',
  'User',
  'globalStorage',
  'storage.json',
);

/** Claude Code's session transcripts, one directory per working directory a session started in. */
export const projectsDir = join(claudeDir, 'projects');

/**
 * The shared plan archive. A fleet-root session writes here directly (`plansDirectory: "plans"`);
 * the clones write to their own `.claude/plans` and `orch-util plans collect` moves them in.
 */
export const fleetPlans = join(fleetRoot, 'plans');

/**
 * The one shared `tmp/`: every clone's `tmp` is a symlink to it, so a Jira ticket fetched in
 * one clone is there for all of them. PID files stay per clone in `tmp/_<clone>/`.
 */
export const fleetTmp = join(fleetRoot, 'tmp');

/** Where plans land when `plansDirectory` is absent or rejected -- shared with other projects. */
export const userPlans = join(claudeDir, 'plans');

/**
 * The abandoned shared archive. Claude Code requires `plansDirectory` to resolve INSIDE the
 * project root (following symlinks), so this absolute path was silently rejected in every
 * clone and every plan since 2026-08-31 went to `userPlans` instead.
 */
export const legacyPlans = join(claudeDir, 'dvb-gn-plans');

/** The one shared statusline script -- all clones run it; it derives its hue from the cwd. */
export const statuslineScript = join(claudeDir, 'dvb-clone-statusline.sh');

/** Shared per-ticket Jira cache. Each clone's `tmp/<KEY>` is a symlink into here. */
export const jiraStore = resolve(process.env['DVB_JIRA_CACHE'] ?? join(claudeDir, 'dvb-gn-jira'));

/** Fleet-wide secrets, outside every clone so no clone can commit them. */
export const envShared = join(fleetRoot, '.env.shared');

/** Generated shell artifacts that live in the fleet root. */
export const cloneColoursScript = join(fleetRoot, 'clone-colours.sh');
export const itermHookScript = join(fleetRoot, 'dvb-clone-iterm.zsh');

export const originUrl = 'git@bitbucket.org:acme/storefront_ui.git';
export const bitbucketWorkspaceUrl = 'https://bitbucket.org/acme';
export const bitbucketRepo = 'storefront_ui';
export const atlassianUrl = 'https://acme.atlassian.net';

/** Render an absolute path under $HOME as `~/...` for output. */
export const tildify = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

/**
 * Explicit clone -> colour assignments, written by `orch-util colours change`.
 *
 * Distinct from the generated `clone-colours.sh` beside it: that one is OUTPUT (a hue table for
 * the shell), this one is INPUT, and it is the only per-clone value in the fleet that is not
 * derived from the clone index.
 */
export const colourAssignmentsFile = join(fleetRoot, 'colour-assignments.json');
