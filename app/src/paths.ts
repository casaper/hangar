/**
 * The forge and tracker identity of THIS hangar, as literals.
 *
 * What used to be here -- every path derived from the hangar root -- now hangs off `Hangar` in
 * `hangar.ts`, because a value derived from a root that comes from a config file cannot be a
 * module constant. `user-paths.ts` holds the half that depends only on `homedir()`.
 *
 * These four are the last of it, and they are the remaining half of the genericisation: the
 * config already declares `forge.originUrl`, `forge.webBaseUrl` and `tracker.baseUrl`, and the
 * code still reads these instead. F5 wires the config through and this file goes away.
 *
 * Until then they are wrong for any hangar but this one -- `add-clone` falling back to
 * `originUrl` would clone storefront_ui into somebody else's fleet, which is why F9 removes that
 * fallback rather than leaving it as a default.
 */
export const originUrl = 'git@bitbucket.org:acme/storefront_ui.git';
export const bitbucketWorkspaceUrl = 'https://bitbucket.org/acme';
export const bitbucketRepo = 'storefront_ui';
export const atlassianUrl = 'https://acme.atlassian.net';
