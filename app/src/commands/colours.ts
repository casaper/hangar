import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

import pc from 'picocolors';

import {
  clearColourAssignment,
  colourAssignmentsLabel,
  setColourAssignment,
} from '../colour-assignments.ts';
import {
  claudeLocalMdContent,
  claudeLocalMdPath,
  readSettings,
  settingsContentFor,
  settingsPath,
} from '../clone-config.ts';
import { discoverClones, requireClone } from '../fleet.ts';
import { claudeSessionsIn } from '../procs.ts';
import { cloneColoursArtifact } from '../generate/colours-sh.ts';
import { applyArtifact, type Artifact, type ArtifactOutcome } from '../generate/index.ts';
import { statuslineArtifact } from '../generate/statusline-sh.ts';
import { terminalHookArtifact } from '../generate/terminal-sh.ts';
import { tmuxConfArtifact } from '../generate/tmux-conf.ts';
import { themeArtifact, themeName, themePath } from '../generate/theme-json.ts';
import { colourFor, paint, paletteEntry, PALETTE, PALETTE_NAMES } from '../palette.ts';
import { tmuxServer, tmuxSocketName } from '../tmux.ts';
import { tildify } from '../user-paths.ts';
import { CliError } from '../exec.ts';

import { cloneLabel, heading, note, ok, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/** Every file `hangar colours sync` owns, for the fleet as it exists right now. */
export const colourArtifacts = (hangar: Hangar): Artifact[] => {
  const clones = discoverClones(hangar);
  return [
    cloneColoursArtifact(hangar, clones),
    terminalHookArtifact(hangar, hangar.config.terminal.colour),
    tmuxConfArtifact(hangar),
    statuslineArtifact(hangar, clones),
    ...clones.map((clone) => themeArtifact(clone)),
  ];
};

export type ColoursSyncOptions = { dryRun?: boolean | undefined; check?: boolean | undefined };

export const coloursSync = (hangar: Hangar, opts: ColoursSyncOptions): void => {
  const dryRun = opts.dryRun === true || opts.check === true;
  const outcomes: { artifact: Artifact; outcome: ArtifactOutcome }[] = [];

  for (const artifact of colourArtifacts(hangar)) {
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
      'Run `hangar colours sync` to regenerate them.',
    );
  }
  /*
   * The status bar of every session ALREADY RUNNING, which no file can reach.
   *
   * `clone-tmux.conf` gets to the server through `-f`, and tmux reads that once when the server
   * starts. So writing a correct conf leaves every open clone on whatever it started with, and
   * `doctor` can only name `kill-server` -- which it refuses to run, because it would end every
   * live agent in the fleet. Everything the bar needs is a global SESSION option though, so it
   * can simply be written onto the live server: nothing restarts, and no session notices beyond
   * its bar becoming readable.
   *
   * Skipped on a dry run, which is the one thing here that touches state outside the artifacts.
   */
  if (!dryRun) {
    const restyled = tmuxServer(hangar).restyle(discoverClones(hangar));
    if (restyled > 0) {
      ok(
        `restyled    ${String(restyled)} live tmux session(s) on ${tmuxSocketName(hangar.id)}  ` +
          `(no restart needed)`,
      );
    }
  }

  if (stale.length === 0) note('All colour artifacts are up to date.');
  else if (dryRun) note('(dry run -- nothing was written)');
  else note('A theme change needs a Claude Code restart in the affected clone to show up.');
};

export type ColoursChangeOptions = { force?: boolean | undefined };

/** The palette names no clone is currently using, for the "pick another" hint. */
const freeColours = (hangar: Hangar): string[] => {
  const taken = new Set(discoverClones(hangar).map((clone) => clone.colour.name));
  return PALETTE_NAMES.filter((name) => !taken.has(name));
};

/**
 * `hangar colours change <clone> <colour>` -- give one clone a hue of your choosing.
 *
 * The hue is normally `PALETTE[(N-1) % length]` and there is nothing to argue with, so this
 * persists an explicit assignment (`colour-assignments.json`) and then rebuilds EVERYTHING
 * derived from it. That last part is the whole command: four artifacts and two per-clone files
 * carry the colour, and the theme and the identity file carry its NAME, so a half-done change
 * leaves a clone whose status line is red, whose theme file is still called `-orange`, whose
 * `settings.local.json` selects a theme that no longer exists (Claude Code then falls back to
 * the default theme -- the clone looks like every other clone, which is the one thing the
 * colours exist to prevent) and whose `CLAUDE.local.md` tells the agent to announce a colour
 * nobody can see.
 *
 * Choosing the hue the formula would have given clears the assignment instead of writing one,
 * so the file only ever holds real overrides and going back is the same command.
 */
export const coloursChange = (
  hangar: Hangar,
  ref: string,
  colour: string,
  opts: ColoursChangeOptions,
): void => {
  const clone = requireClone(hangar, ref);
  const entry = paletteEntry(colour);
  if (entry === undefined) {
    throw new CliError(`unknown colour: ${colour}`, `Available: ${PALETTE_NAMES.join(', ')}`);
  }

  if (clone.colour.name === entry.name) {
    note(`${clone.name} is already ${entry.name} — nothing to do`);
    return;
  }

  // Two clones sharing a hue defeats the point of having one, so this stops rather than warns.
  const clash = discoverClones(hangar).filter(
    (other) => other.index !== clone.index && other.colour.name === entry.name,
  );
  if (clash.length > 0 && opts.force !== true) {
    const free = freeColours(hangar);
    throw new CliError(
      `${entry.name} is already ${clash.map((c) => c.name).join(', ')}'s colour`,
      `Telling near-identical windows apart is what the hue is for. Free: ${
        free.length === 0 ? '(none — the palette is full)' : free.join(', ')
      }. Use --force to have both.`,
    );
  }

  heading(`Recolouring ${cloneLabel(clone)}: ${clone.colour.name} → ${entry.name}`);

  // This writes into a clone that may have an agent working in it -- `settings.local.json` and
  // `CLAUDE.local.md`. Neither write is dangerous (no tracked file, no git state, and the
  // session re-reads both only on restart), but every other path in this CLI that touches a
  // clone with a live session says so, and silence is what makes the fleet's worst failures
  // hard to spot.
  const sessions = claudeSessionsIn(clone.path);
  if (sessions.length > 0) {
    warn(
      `${clone.name} has ${String(sessions.length)} live Claude session(s) — they keep the old theme until restarted`,
    );
  }

  // Captured BEFORE the assignment moves: the theme file is named after the hue, so the new
  // one is a different path and the old one would just sit there for ever.
  const staleTheme = themePath(clone);

  const formula = colourFor(clone.index).name;
  if (entry.name === formula) {
    clearColourAssignment(hangar, clone.index);
    ok(`back on the palette formula for index ${String(clone.index)} (${formula})`);
  } else {
    setColourAssignment(hangar, clone.index, entry.name);
    ok(`assigned in ${colourAssignmentsLabel(hangar)}`);
  }

  // Re-derived, so every artifact below is built from the new hue.
  const updated = requireClone(hangar, ref);

  heading('Regenerating colour artifacts');
  coloursSync(hangar, {});

  if (staleTheme !== themePath(updated) && existsSync(staleTheme)) {
    unlinkSync(staleTheme);
    ok(`deleted stale ${tildify(staleTheme)}`);
  }

  // `settings.local.json` selects the theme by NAME -- the name that just changed.
  const settings = readSettings(updated);
  if (settings === undefined) {
    warn(
      `no readable .claude/settings.local.json — run \`hangar doctor ${String(clone.index)} --fix\``,
    );
  } else {
    writeFileSync(settingsPath(updated), settingsContentFor(updated, settings), 'utf8');
    ok(`theme custom:${themeName(updated)} in .claude/settings.local.json`);
  }

  // The identity file names the colour three times, and `doctor` only checks that it EXISTS.
  writeFileSync(claudeLocalMdPath(updated), claudeLocalMdContent(updated), 'utf8');
  ok(`CLAUDE.local.md now announces ${updated.colour.name}`);

  console.log('');
  note(
    `${pc.dim('new shell')} for the iTerm2 tab colour, ${pc.dim('restart Claude Code')} in ${clone.name} for the theme.`,
  );
};

/**
 * `hangar colours list` -- the whole palette, painted, with who has what.
 *
 * The swatch is the point: the names are only labels and two of them (violet / purple,
 * red / crimson) mean very little until you see them side by side.
 */
export const coloursList = (hangar: Hangar): void => {
  const owners = new Map(discoverClones(hangar).map((clone) => [clone.colour.name, clone]));
  const width = Math.max(...PALETTE_NAMES.map((name) => name.length));
  const slotWidth = String(PALETTE.length).length;
  for (const [slot, entry] of PALETTE.entries()) {
    const colour = colourFor(1, entry.name);
    const owner = owners.get(entry.name);
    const held =
      owner === undefined
        ? ''
        : pc.dim(
            `clone_${String(owner.index).padStart(2, '0')}${owner.colour.explicit ? ' (assigned)' : ''}`,
          );
    console.log(
      `  ${paint(colour, '●')} ${entry.name.padEnd(width)}  ${pc.dim(entry.hex)}  ${pc.dim(
        `slot ${String(slot + 1).padStart(slotWidth)}`,
      )}  ${held}`,
    );
  }
  console.log('');
  note(
    'A clone with no assignment takes the slot matching its index. `colours change` overrides that.',
  );
};
