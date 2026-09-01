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
 * The first three entries are the fleet's original cyan / yellow / green and must not be
 * reordered -- clone_01..03 have those hues wired into muscle memory. Later entries extend
 * the set; every hue keeps one channel at 0xcc or 0xff so the set reads as one family.
 */
export type PaletteEntry = { readonly name: string; readonly hex: string };

export const PALETTE: readonly PaletteEntry[] = [
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
];

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
 * The colour for a clone index (1-based). Wraps once the palette is exhausted, which is a
 * degraded but working state -- two clones share a hue and `orch-util doctor` says so.
 */
export const colourFor = (index: number): CloneColour => {
  const slot = (index - 1) % PALETTE.length;
  const entry = PALETTE[slot];
  if (!entry) throw new Error(`no palette entry for clone index ${index}`);
  const main = parseHex(entry.hex);
  return {
    name: entry.name,
    main: entry.hex,
    shimmer: toHex(towardWhite(main, 0.4)),
    border: toHex(scale(main, 0.8)),
    dimTriple: triple(scale(main, 0.6)),
    mainTriple: triple(main),
    reused: index > PALETTE.length,
  };
};

const ESC = '\u001b';

/** Wrap text in the clone's hue for terminal output (24-bit colour). */
export const paint = (colour: CloneColour, text: string): string =>
  `${ESC}[38;2;${colour.mainTriple}m${text}${ESC}[0m`;
