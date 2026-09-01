import { discoverClones } from '../fleet.ts';
import { cloneColoursArtifact } from '../generate/colours-sh.ts';
import { applyArtifact, type Artifact, type ArtifactOutcome } from '../generate/index.ts';
import { statuslineArtifact } from '../generate/statusline-sh.ts';
import { themeArtifact } from '../generate/theme-json.ts';
import { tildify } from '../paths.ts';
import { CliError } from '../exec.ts';
import { note, ok, warn } from '../ui.ts';

/** Every file `orch-util colours sync` owns, for the fleet as it exists right now. */
export const colourArtifacts = (): Artifact[] => {
  const clones = discoverClones();
  return [
    cloneColoursArtifact(clones),
    statuslineArtifact(clones),
    ...clones.map((clone) => themeArtifact(clone)),
  ];
};

export type ColoursSyncOptions = { dryRun?: boolean | undefined; check?: boolean | undefined };

export const coloursSync = (opts: ColoursSyncOptions): void => {
  const dryRun = opts.dryRun === true || opts.check === true;
  const outcomes: { artifact: Artifact; outcome: ArtifactOutcome }[] = [];

  for (const artifact of colourArtifacts()) {
    outcomes.push({ artifact, outcome: applyArtifact(artifact, dryRun) });
  }

  for (const { artifact, outcome } of outcomes) {
    const path = tildify(artifact.path);
    if (outcome === 'unchanged') note(`unchanged  ${path}`);
    else if (outcome === 'written') ok(`written    ${path}  (${artifact.what})`);
    else warn(`${outcome === 'would-create' ? 'would create' : 'would change'}  ${path}`);
  }

  const stale = outcomes.filter((o) => o.outcome !== 'unchanged');
  if (opts.check === true && stale.length > 0) {
    throw new CliError(
      `${stale.length} colour artifact(s) are out of date`,
      'Run `orch-util colours sync` to regenerate them.',
    );
  }
  if (stale.length === 0) note('All colour artifacts are up to date.');
  else if (dryRun) note('(dry run -- nothing was written)');
  else note('A theme change needs a Claude Code restart in the affected clone to show up.');
};
