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
