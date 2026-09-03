import pc from 'picocolors';

import { readEnvLocalPorts } from '../clone-config.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import { devServerUrl, PORT_ROLES, PORT_ROLE_ORDER, storybookUrl } from '../ports.ts';
import { cloneLabel, note, table, warn } from '../ui.ts';

/**
 * `hangar ports` -- the fleet's whole port map in one place.
 *
 * The numbers come from each clone's `.env.local`, read directly. Do NOT get them by running
 * `node dev/ports.mjs` from the fleet root: a parent session has no direnv SessionStart hook,
 * so `.env.local` is never loaded and that script cheerfully reports clone_01's fallbacks
 * (4200 / 6006 / 9323) for every clone. Any disagreement with the index formula is a real
 * problem -- two clones on one port means a test run silently verifies the wrong code -- so
 * it is flagged rather than smoothed over.
 */
export type PortsOptions = { json?: boolean | undefined };

type Row = {
  clone: Clone;
  actual: Partial<Record<string, number>>;
  drift: string[];
};

const inspect = (): Row[] =>
  discoverClones().map((clone) => {
    const actual = readEnvLocalPorts(clone);
    const drift: string[] = [];
    for (const role of PORT_ROLE_ORDER) {
      const key = PORT_ROLES[role].envKey;
      const expected = clone.ports[role];
      const found = actual[key];
      if (found === undefined) drift.push(`${key} missing from .env.local`);
      else if (found !== expected) drift.push(`${key} is ${found}, formula says ${expected}`);
    }
    return { clone, actual, drift };
  });

export const ports = (opts: PortsOptions): void => {
  const rows = inspect();

  if (opts.json === true) {
    console.log(
      JSON.stringify(
        rows.map(({ clone, drift }) => ({
          clone: clone.name,
          index: clone.index,
          colour: clone.colour.name,
          ...clone.ports,
          devServerUrl: devServerUrl(clone.ports),
          storybookUrl: storybookUrl(clone.ports),
          drift,
        })),
        null,
        2,
      ),
    );
    return;
  }

  table([
    [
      pc.dim('CLONE'),
      pc.dim(PORT_ROLES.ng.label),
      pc.dim(PORT_ROLES.storybook.label),
      pc.dim(PORT_ROLES.playwrightReport.label),
    ],
    ...rows.map(({ clone }) => [
      cloneLabel(clone),
      String(clone.ports.ng),
      String(clone.ports.storybook),
      String(clone.ports.playwrightReport),
    ]),
  ]);

  const drifted = rows.filter((r) => r.drift.length > 0);
  if (drifted.length === 0) {
    note('Every .env.local agrees with the index formula.');
    return;
  }
  for (const row of drifted) {
    for (const problem of row.drift) warn(`${row.clone.name}: ${problem}`);
  }
  note('Repair with `hangar doctor --fix`, then re-run `direnv allow` in that clone.');
};
