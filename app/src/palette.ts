/**
 * The fleet's colour identity, and the ONE place the hues are real data.
 *
 * A clone's colour is not decoration -- it is how three (or ten) near-identical terminal
 * windows are told apart. Only the main hue is stored; everything else is derived, so a hue
 * change can never leave the artifacts that carry it disagreeing. The first three formulas
 * reproduce the hand-written originals byte for byte:
 *
 *   shimmer = main + 40% toward white   #00ccff -> #66e0ff
 *   border  = main x 0.8                #00ccff -> #00a3cc
 *   dim     = main x 0.6                0;204;255 -> 0;122;153
 *
 * The last two are not cosmetic ratios but CONTRAST decisions, and they exist because the
 * tmux status bar was unreadable in every clone:
 *
 *   ink     = black or white, whichever reads on main   -> text ON the hue
 *   barText = main, lifted until it clears the floor    -> the hue AS text, on the bar
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
 * `.choices(PALETTE_NAMES)` then narrows `hangar colours change`'s argument to exactly
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
  /** Main hue as the `r;g;b` triple the terminal escape codes want. */
  readonly mainTriple: string;
  /**
   * The hue as an xterm-256 palette index.
   *
   * For the terminals that do not do 24-bit colour -- Terminal.app is the one that matters here
   * -- so a prompt colouring itself from `HANGAR_CLONE_SGR` still gets a recognisable hue rather
   * than nothing. Computed here and baked into the generated hue table because the nearest-cube
   * arithmetic is not something to write in shell.
   */
  readonly x256: number;
  /**
   * Pure black or pure white -- whichever reads on `main`. The text colour for anything drawn
   * ON the hue, which is how the status bar carries a clone's identity: a solid block of the
   * hue is far easier to find at a glance than coloured text, and the ink makes it legible
   * without anybody choosing a pair by hand.
   */
  readonly ink: string;
  /** `main`, lifted toward white only as far as `STATUS_BAR_BG` requires. Hue AS text. */
  readonly barText: string;
  /** True when the fleet has outgrown the palette and this hue repeats an earlier clone. */
  readonly reused: boolean;
  /** True when this hue was chosen with `hangar colours change`, not by the index formula. */
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
 * WCAG 2.1 relative luminance, and the contrast ratio between two colours.
 *
 * Hand-rolled rather than a dependency, and the reason is the GUARANTEE rather than a dislike of
 * dependencies. `ink` restricts itself to pure black and pure white, and for exactly two
 * candidates the floor is provable: against black the ratio is `(L + 0.05) / 0.05`, against white
 * `1.05 / (L + 0.05)`, and the two cross at `(L + 0.05)^2 = 0.0525`. So whichever is better is
 * never worse than **4.58:1** -- on any sRGB colour at all. That is WCAG AA for normal text, for
 * every hue in the table above and every hue anyone ever appends to it. Nothing to measure and
 * nothing to tune, which is the opposite of how the status bar got into the state it was in.
 *
 * **It holds for PURE black and white only.** A near-black picked to match the bar looks tidier
 * and silently voids it -- and degrades worst through `tmux-256color`'s colour cube, on the one
 * terminal here that has no true colour. So `ink` is one of exactly two values, and
 * `test/contrast.test.ts` asserts that it is.
 *
 * Four libraries were weighed -- culori, colorjs.io, wcag-contrast, apca-w3 -- and none of them
 * ships its own TypeScript types, in a package whose only `@types/*` is Node's. APCA (the WCAG 3
 * draft) is the better algorithm for light text on dark and would change exactly one answer here:
 * indigo's ink flips to white. Both clear AA, so it buys a dependency and no readability.
 */
const channelLuminance = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (hex: string): number => {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
};

export const contrastRatio = (a: string, b: string): number => {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

/**
 * The tmux status bar's own colours, and the floor everything drawn on it clears.
 *
 * These live here, with the hues, rather than in `generate/tmux-conf.ts` which renders them: the
 * bar's background is what `barText` is measured AGAINST, so a conf and a derivation holding two
 * different ideas of it would be wrong in a way nothing reports. The conf is the one file the
 * whole hangar shares and these are hangar-level -- no clone's hue is in here.
 *
 * The bar had none of this and so had tmux's built-in `bg=green,fg=black`, which put every clone
 * hue on saturated green: measured, the whole palette lands between 1.00:1 and 2.64:1, and the
 * `green` clone against green is 1.00 -- the same colour, invisible rather than merely poor.
 */
export const STATUS_BAR_BG = '#1c1c1c';
/** The bar's own text -- window names, the clock. 8.88:1 on the background above. */
export const STATUS_BAR_FG = '#bbbbbb';
/** A window that is not current, before any hue lands on it. 4.94:1. */
export const STATUS_BAR_DIM = '#8a8a8a';
/** WCAG 2.1 AA for normal text, which is the size a status bar draws at. */
export const CONTRAST_FLOOR = 4.5;
const INK_DARK = '#000000';
const INK_LIGHT = '#ffffff';

/**
 * Text ON the hue: whichever of black and white reads better. See the proof above.
 *
 * Exported because the clone hues are not the only thing drawn on a solid block of colour --
 * `MODE_COLOURS` below needs the same answer, and a second copy of a two-line contrast pick is
 * exactly the drift this file exists to prevent.
 */
export const inkFor = (main: string): string =>
  contrastRatio(main, INK_DARK) >= contrastRatio(main, INK_LIGHT) ? INK_DARK : INK_LIGHT;

/**
 * The hue AS text on the bar: itself, or lifted toward white until it clears the floor.
 *
 * A floor and not a wash. Fourteen of the sixteen hues already clear it and come back
 * BYTE-IDENTICAL, so full saturation -- which is where the palette's whole distinguishability
 * lives -- survives everywhere it can. Only indigo (10%) and crimson (33%) move at all. Reusing
 * `shimmer` would have been one line and would have lightened all sixteen while still promising
 * nothing about the seventeenth.
 */
/**
 * The two hangar-ROOT modes, which are not clones and never appear in `PALETTE`.
 *
 * A clone hue says which of several near-identical checkouts you are in. These say something
 * else entirely -- whether this session may change the CLI or only run it -- so they are a
 * separate two-entry table rather than two more palette entries, and nothing derives them from
 * an index. `hangar claude` paints one tmux tab per mode with them, ink from `inkFor`: white on
 * both, at 4.63:1 for ops and 5.02:1 for dev.
 *
 * Cool blue for the mode that reads and runs, warm amber for the one that changes things.
 *
 * ## The one duplicate in this file, named rather than hidden
 *
 * `.claude/modes/statusline.sh` draws the Claude Code status-line badge INSIDE these tabs and
 * carries the same two triples as literals. It cannot source them: it is one of the
 * hand-maintained mode files, derived from nothing under `app/src/**`, and deliberately so --
 * it must render a badge even when everything else is broken. So the pair is kept in step by
 * hand, and each side names the other. Change one, change both.
 */
export type ModeColour = { readonly main: string; readonly ink: string; readonly purpose: string };

export const MODE_COLOURS: Readonly<Record<'ops' | 'dev', ModeColour>> = {
  ops: { main: '#1f6feb', ink: inkFor('#1f6feb'), purpose: 'run the fleet' },
  dev: { main: '#b35400', ink: inkFor('#b35400'), purpose: 'change the CLI' },
};

export const barTextFor = (main: string): string => {
  const rgb = parseHex(main);
  for (let lift = 0; lift < 100; lift += 1) {
    const candidate = toHex(towardWhite(rgb, lift / 100));
    if (contrastRatio(candidate, STATUS_BAR_BG) >= CONTRAST_FLOOR) return candidate;
  }
  // Unreachable -- white clears any dark bar. Here so the return type needs no assertion.
  return INK_LIGHT;
};

/**
 * The build state of a branch's pull request, as text ON the status bar.
 *
 * **The one place in this fleet where colour carries meaning rather than identity**, and it is
 * legal here for a reason that does not hold one line lower: the bar's background is the neutral
 * `STATUS_BAR_BG`, so a red mark is measured against a known dark grey. The FOOTER is a clone's
 * hue with `ink` on it, where a red glyph on the red clone would be invisible -- which is why
 * `tmux-status-sh.ts`'s git state is glyphs and never colour. Same fleet, opposite rule, and the
 * difference is entirely which background the character lands on.
 *
 * Run through `barTextFor` rather than written as three chosen hex values, so the floor is the
 * same arithmetic every clone hue clears and `test/contrast.test.ts` proves all of it at once.
 * That is not ceremony: the red asked for here, `#f03e3e`, measures **4.43:1** on this bar and
 * is lifted to `#f04343` to clear 4.5. Pure `#ff0000` is worse still at 4.26:1 -- both are
 * exactly the sort of obviously-fine red nobody would have thought to measure.
 *
 * **Colour is reinforcement here and never the carrier.** `pass` and `fail` measure 1.18:1
 * against EACH OTHER -- a contrast ratio is a luminance metric and these differ almost only in
 * hue, which is the textbook red/green pair that deuteranopia erases. So the bar says which is
 * which with three different SHAPES (`✓`, `✗`, `◌`) and reads correctly with every colour
 * stripped; the hue only makes the answer faster for those who can see it. There is no
 * arithmetic over two hex values that fixes this, which is why the answer is a glyph.
 */
export const CI_COLOURS = {
  pass: barTextFor('#26a641'),
  fail: barTextFor('#f03e3e'),
  running: barTextFor('#d9a800'),
} as const;

/**
 * Nearest entry in xterm-256's 6x6x6 colour cube (indices 16-231).
 *
 * The cube's levels are 0, 95, 135, 175, 215, 255 -- not evenly spaced, which is why the
 * thresholds below are not a plain division. Greys (232-255) are deliberately not considered:
 * every palette hue keeps one channel at 0xcc or 0xff, so none of them is a grey, and letting a
 * hue collapse onto one would defeat the point of having it.
 */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

const cubeIndex = (channel: number): number => {
  let best = 0;
  for (let i = 1; i < CUBE_LEVELS.length; i += 1) {
    const level = CUBE_LEVELS[i] ?? 0;
    if (Math.abs(channel - level) < Math.abs(channel - (CUBE_LEVELS[best] ?? 0))) best = i;
  }
  return best;
};

const toX256 = ([r, g, b]: Rgb): number => 16 + 36 * cubeIndex(r) + 6 * cubeIndex(g) + cubeIndex(b);

/**
 * The colour for a clone index (1-based), or the one it was explicitly assigned.
 *
 * The formula is still the default and still needs no bookkeeping: `PALETTE[(N-1) % length]`,
 * wrapping once the palette is exhausted, which is a degraded but working state -- two clones
 * share a hue and `hangar doctor` says so. `override` is a palette NAME, from
 * `colour-assignments.json`; an unknown one falls back to the formula rather than throwing,
 * because every command builds a Clone and none of them should die on a typo in that file.
 * `hangar doctor` is what reports it.
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
    x256: toX256(main),
    ink: inkFor(entry.hex),
    barText: barTextFor(entry.hex),
    reused: assigned === undefined && index > PALETTE.length,
    explicit: assigned !== undefined,
  };
};

/**
 * The colour whose main hue is this hex, for a tmux window that has tagged itself with one.
 *
 * The shell hook writes `@hangar_colour` per window, so a window standing in a clone OTHER than
 * its session's has already recorded which -- and `colours sync` restyling a live server has to
 * believe it rather than repainting the whole session one colour. Looked up by hex and not by
 * name deliberately: `colours change` means a clone's hue need not be the one its index implies,
 * and the hex is the same either way.
 */
export const colourByHex = (hex: string): CloneColour | undefined => {
  const entry = PALETTE.find((candidate) => candidate.hex === hex.toLowerCase());
  return entry === undefined ? undefined : colourFor(1, entry.name);
};

const ESC = '\u001b';

/** Wrap text in the clone's hue for terminal output (24-bit colour). */
export const paint = (colour: CloneColour, text: string): string =>
  `${ESC}[38;2;${colour.mainTriple}m${text}${ESC}[0m`;
