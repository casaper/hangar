import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { CliError } from '../exec.ts';
import { runInstall } from '../install.ts';
import { cloneLabel, heading } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar install <clone>` -- run `repo.install[]` in a clone that needs it.
 *
 * The one entry point to a package manager inside a live clone besides `add-clone`, and it is
 * deliberately explicit rather than a `doctor --fix` repair. `npm ci` deletes `node_modules`
 * outright, so a clone with a dev server running loses it mid-request -- which makes this the
 * user's command from the hangar root, like `sync` and `doctor --fix`, and not something a
 * repair pass should decide to do. `doctor` reports that an install is missing and names this
 * command; running it is a human's call.
 *
 * `-n` prints the plan, which is what makes the declaration readable without trusting it.
 */
export type InstallCommandOptions = {
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
};

export const install = (
  hangar: Hangar,
  ref: string | undefined,
  opts: InstallCommandOptions,
): void => {
  const clones: readonly Clone[] =
    opts.all === true
      ? discoverClones(hangar)
      : [
          ref === undefined
            ? (() => {
                throw new CliError('install needs a clone name, or --all', knownClonesHint(hangar));
              })()
            : requireClone(hangar, ref),
        ];

  for (const clone of clones) {
    heading(cloneLabel(clone));
    runInstall(clone, { dryRun: opts.dryRun === true });
  }
};
