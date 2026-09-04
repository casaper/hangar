import { join, resolve } from 'node:path';

import { claudeDir } from './user-paths.ts';

/**
 * Every path derived from THIS HANGAR's root.
 *
 * The user-scoped half -- `~/.claude`, the transcripts directory, `tildify` -- lives in
 * `user-paths.ts`, because it is a pure function of `homedir()` and stays correct for any number
 * of hangars. Everything here is a function of `fleetRoot` and so cannot remain a module
 * constant once that root comes from a config file rather than from this file's own location.
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

/**
 * Explicit clone -> colour assignments, written by `hangar colours change`.
 *
 * Distinct from the generated `clone-colours.sh` beside it: that one is OUTPUT (a hue table for
 * the shell), this one is INPUT, and it is the only per-clone value in the fleet that is not
 * derived from the clone index.
 */
export const colourAssignmentsFile = join(fleetRoot, 'colour-assignments.json');
