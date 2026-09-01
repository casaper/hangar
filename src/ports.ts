/**
 * Per-clone port assignment.
 *
 * Two clones sharing a dev server means a test run in one silently verifies the other's
 * code -- the single worst failure this fleet can produce. So the ports are a pure function
 * of the clone index rather than something a human types into `.env.local`, and
 * `orch-util doctor` checks the file still agrees with the formula.
 *
 * The bases and the step are the fleet's existing assignment, unchanged:
 *   clone_01 -> 4200 / 6006 / 9323, clone_02 -> 4300 / 6106 / 9423, and so on.
 *
 * The env var names and their fallbacks mirror each clone's tracked `dev/ports.mjs`, which
 * is what resolves them at run time inside a clone. Do not read ports by running that
 * script from the fleet root: the parent has no direnv SessionStart hook, so `.env.local`
 * is never loaded and it reports clone_01's fallbacks for every clone.
 */
export const PORT_STEP = 100;

export type PortRole = 'ng' | 'storybook' | 'playwrightReport';

export type PortRoleSpec = {
  readonly envKey: string;
  readonly base: number;
  readonly label: string;
};

export const PORT_ROLES: Readonly<Record<PortRole, PortRoleSpec>> = {
  ng: { envKey: 'NG_DEV_SERVER_PORT', base: 4200, label: 'Angular dev server' },
  storybook: { envKey: 'STORYBOOK_DEV_SERVER_PORT', base: 6006, label: 'Storybook' },
  playwrightReport: {
    envKey: 'PLAYWRIGHT_REPORT_PORT',
    base: 9323,
    label: 'Playwright HTML report',
  },
};

export const PORT_ROLE_ORDER: readonly PortRole[] = ['ng', 'storybook', 'playwrightReport'];

export type ClonePorts = Readonly<Record<PortRole, number>>;

/** The three ports a clone index (1-based) owns. */
export const portsFor = (index: number): ClonePorts => ({
  ng: PORT_ROLES.ng.base + (index - 1) * PORT_STEP,
  storybook: PORT_ROLES.storybook.base + (index - 1) * PORT_STEP,
  playwrightReport: PORT_ROLES.playwrightReport.base + (index - 1) * PORT_STEP,
});

export const devServerUrl = (ports: ClonePorts): string => `http://localhost:${ports.ng}`;
export const storybookUrl = (ports: ClonePorts): string => `http://localhost:${ports.storybook}`;
