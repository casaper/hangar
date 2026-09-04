import pc from 'picocolors';

import { readEnvLocalPorts } from '../clone-config.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import { roleUrl } from '../ports.ts';
import { cloneLabel, note, table, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

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

const inspect = (hangar: Hangar): Row[] =>
  discoverClones(hangar).map((clone) => {
    const actual = readEnvLocalPorts(clone);
    const drift: string[] = [];
    for (const entry of clone.ports) {
      const key = entry.role.envKey;
      const found = actual[key];
      if (found === undefined) drift.push(`${key} missing from .env.local`);
      else if (found !== entry.port)
        drift.push(`${key} is ${String(found)}, formula says ${String(entry.port)}`);
    }
    return { clone, actual, drift };
  });

export const ports = (hangar: Hangar, opts: PortsOptions): void => {
  const rows = inspect(hangar);

  if (opts.json === true) {
    console.log(
      JSON.stringify(
        rows.map(({ clone, drift }) => ({
          clone: clone.name,
          index: clone.index,
          colour: clone.colour.name,
          ports: clone.ports.map((entry) => ({
            id: entry.role.id,
            envKey: entry.role.envKey,
            label: entry.role.label,
            port: entry.port,
            url: roleUrl(entry) ?? null,
          })),
          drift,
        })),
        null,
        2,
      ),
    );
    return;
  }

  // One column per configured role, labelled from the config. A hangar with no roles gets the
  // CLONE column alone, which is the honest rendering of "this hangar manages no ports".
  table([
    [pc.dim('CLONE'), ...hangar.config.ports.roles.map((role) => pc.dim(role.label))],
    ...rows.map(({ clone }) => [
      cloneLabel(clone),
      ...clone.ports.map((entry) => String(entry.port)),
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
