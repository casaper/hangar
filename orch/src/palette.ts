/**
 * The fleet's colour identity, and the ONE place the hues are real data.
 *
 * A clone's colour is not decoration -- it is how three (or ten) near-identical terminal
 * windows are told apart. Only the main hue is stored; the shimmer, the prompt border and
 * the statusline's dim tone are derived, so a hue change can never leave the four artifacts
 * disagreeing. The formulas below reproduce the hand-written originals byte for byte:
 *
 *   shimmer = main + 40% toward white   #00ccff -> #66e0ff
 *   border  = main x 0.8                #00ccff -> #00a3cc
 *   dim     = main x 0.6                0;204;255 -> 0;122;153
 *
 * ORDER IS LOAD-BEARING and the list is append-only. A clone with no explicit assignment
 * takes `PALETTE[(N-1) % length]`, so inserting or reordering an entry silently re-colours
 * every clone after it -- and clone_01..03 have the original cyan / yellow / green wired into
 * muscle memory. Appending is always safe.
 *
 * Twelve hues sampled the wheel about as finely as a terminal dot usefully can; the four after
 * them (`purple` onward) fill the remaining gaps and are the least distinguishable of the set,
 * so the early entries stay the good ones. Every hue keeps one channel at 0xcc or 0xff, which
 * is what makes them read as one family.
 *
 * Claude Code takes arbitrary 24-bit hex in a custom theme -- that is exactly what
 * `~/.claude/themes/dvb-clone-NN-*.json` already does with `claude`, `claudeShimmer`,
 * `briefLabelClaude`, `promptBorder` and `promptBorderShimmer` -- so this list is limited by
 * what a human can tell apart at a glance, not by anything Claude Code enforces.
 */
export type PaletteEntry = { readonly name: string; readonly hex: string };

export const PALETTE = [
  { name: 'cyan', hex: '#00ccff' },
  { name: 'yellow', hex: '#ffcc00' },
  { name: 'green', hex: '#00cc00' },
  { name: 'orange', hex: '#ff8800' },
  { name: 'magenta', hex: '#ff00cc' },
  { name: 'violet', hex: '#9966ff' },
  { name: 'red', hex: '#ff4444' },
  { name: 'teal', hex: '#00ccaa' },
  { name: 'blue', hex: '#3399ff' },
  { name: 'lime', hex: '#aaff00' },
  { name: 'pink', hex: '#ff88bb' },
  { name: 'amber', hex: '#cc8800' },
  { name: 'purple', hex: '#cc44ff' },
  { name: 'indigo', hex: '#5566ff' },
  { name: 'crimson', hex: '#cc0044' },
  { name: 'silver', hex: '#cccccc' },
] as const satisfies readonly PaletteEntry[];

/**
 * The colour names as a union type, not just strings.
 *
 * `as const satisfies` above is what buys this: the entries keep their literal types (so this
 * union is the real list) while still being checked against `PaletteEntry`. Commander's
 * `.choices(PALETTE_NAMES)` then narrows `orch-util colours change`'s argument to exactly
 * these, so a typo is a usage error listing the real names -- and adding a hue to the table
 * extends the CLI's accepted values with no second list to update.
 */
export type ColourName = (typeof PALETTE)[number]['name'];

export const PALETTE_NAMES: readonly ColourName[] = PALETTE.map((entry) => entry.name);

export const paletteEntry = (name: string): PaletteEntry | undefined =>
  PALETTE.find((entry) => entry.name === name);

export type Rgb = readonly [number, number, number];

export type CloneColour = {
  /** Palette name, e.g. `cyan`. Used in the theme filename and in CLAUDE.local.md. */
  readonly name: string;
  readonly main: string;
  readonly shimmer: string;
  readonly border: string;
  /** Statusline separator tone, as the `r;g;b` triple an ANSI escape wants. */
  readonly dimTriple: string;
  /** Main hue as the `r;g;b` triple the iTerm2 escape codes want. */
  readonly mainTriple: string;
  /** True when the fleet has outgrown the palette and this hue repeats an earlier clone. */
  readonly reused: boolean;
  /** True when this hue was chosen with `orch-util colours change`, not by the index formula. */
  readonly explicit: boolean;
};

const parseHex = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const toHex = (rgb: Rgb): string => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

const scale = (rgb: Rgb, factor: number): Rgb =>
  rgb.map((c) => Math.floor(c * factor)) as unknown as Rgb;

const towardWhite = (rgb: Rgb, amount: number): Rgb =>
  rgb.map((c) => Math.floor(c + (255 - c) * amount)) as unknown as Rgb;

const triple = (rgb: Rgb): string => rgb.join(';');

/**
 * The colour for a clone index (1-based), or the one it was explicitly assigned.
 *
 * The formula is still the default and still needs no bookkeeping: `PALETTE[(N-1) % length]`,
 * wrapping once the palette is exhausted, which is a degraded but working state -- two clones
 * share a hue and `orch-util doctor` says so. `override` is a palette NAME, from
 * `colour-assignments.json`; an unknown one falls back to the formula rather than throwing,
 * because every command builds a Clone and none of them should die on a typo in that file.
 * `orch-util doctor` is what reports it.
 */
export const colourFor = (index: number, override?: string): CloneColour => {
  const assigned = override === undefined ? undefined : paletteEntry(override);
  const slot = (index - 1) % PALETTE.length;
  const entry = assigned ?? PALETTE[slot];
  if (!entry) throw new Error(`no palette entry for clone index ${index}`);
  const main = parseHex(entry.hex);
  return {
    name: entry.name,
    main: entry.hex,
    shimmer: toHex(towardWhite(main, 0.4)),
    border: toHex(scale(main, 0.8)),
    dimTriple: triple(scale(main, 0.6)),
    mainTriple: triple(main),
    reused: assigned === undefined && index > PALETTE.length,
    explicit: assigned !== undefined,
  };
};

const ESC = '\u001b';

/** Wrap text in the clone's hue for terminal output (24-bit colour). */
export const paint = (colour: CloneColour, text: string): string =>
  `${ESC}[38;2;${colour.mainTriple}m${text}${ESC}[0m`;
