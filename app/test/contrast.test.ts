import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  barTextFor,
  CI_COLOURS,
  colourFor,
  contrastRatio,
  CONTRAST_FLOOR,
  PALETTE,
  relativeLuminance,
  STATUS_BAR_BG,
  STATUS_BAR_DIM,
  STATUS_BAR_FG,
} from '../src/palette.ts';

/**
 * The contrast floor every clone hue clears on the tmux status bar.
 *
 * **This is the one thing a golden capture structurally cannot say.** `gated/*` pins the bytes of
 * the rendered conf and the hue table, so it would happily record an unreadable pair for ever --
 * it says what the colours ARE, and nothing about whether a human can read one on the other.
 * That is not hypothetical: the bar shipped with tmux's default `bg=green,fg=black` and so put
 * every hue on saturated green, where the `green` clone measured 1.00:1 against its own
 * background. Every gate was green while one clone's status bar was literally invisible.
 *
 * So the assertions here are properties of the ARITHMETIC, and they are written to hold for hues
 * that do not exist yet: `PALETTE` is append-only, and the next entry somebody adds is checked by
 * this file rather than by a screenshot three weeks later.
 */

const ALL = PALETTE.map((entry) => colourFor(1, entry.name));

test('the bar is readable with no hue involved at all', () => {
  // The floor before any clone is in the picture. A bar whose own text fails is a bar that
  // cannot be rescued by getting the hues right.
  assert.ok(
    contrastRatio(STATUS_BAR_FG, STATUS_BAR_BG) >= CONTRAST_FLOOR,
    `the bar's own text is ${contrastRatio(STATUS_BAR_FG, STATUS_BAR_BG).toFixed(2)}:1`,
  );
  assert.ok(
    contrastRatio(STATUS_BAR_DIM, STATUS_BAR_BG) >= CONTRAST_FLOOR,
    `a non-current window is ${contrastRatio(STATUS_BAR_DIM, STATUS_BAR_BG).toFixed(2)}:1`,
  );
});

test('every hue’s ink clears the floor on its own hue', () => {
  for (const colour of ALL) {
    const ratio = contrastRatio(colour.main, colour.ink);
    assert.ok(
      ratio >= CONTRAST_FLOOR,
      `${colour.name}: ${colour.ink} on ${colour.main} is only ${ratio.toFixed(2)}:1`,
    );
  }
});

test('the ink is one of exactly two values, and the better of them', () => {
  // The assertion that keeps the guarantee from being tuned away. The 4.58:1 floor below is a
  // property of PURE black and white; a near-black picked to match the bar would look tidier,
  // still pass the test above on today's sixteen hues, and quietly void the proof for the
  // seventeenth. So the pair itself is pinned, not just the outcome.
  for (const colour of ALL) {
    assert.ok(
      colour.ink === '#000000' || colour.ink === '#ffffff',
      `${colour.name}: ink is ${colour.ink}, which is neither black nor white`,
    );
    const chosen = contrastRatio(colour.main, colour.ink);
    const other = contrastRatio(colour.main, colour.ink === '#000000' ? '#ffffff' : '#000000');
    assert.ok(
      chosen >= other,
      `${colour.name}: the other ink reads better (${other.toFixed(2)}:1)`,
    );
  }
});

test('best-of-black-or-white cannot fall below 4.58:1, for any colour at all', () => {
  // The proof in closed form, which is the only way to state it: the two ratios cross where
  // (L + 0.05)^2 = 0.0525, so the worst colour there can be is one landing exactly on that
  // luminance -- and it is STILL above the floor. No sweep can show this, because 8-bit sRGB has
  // no colour at exactly that luminance; the nearest sampled one comes out at 4.61 and would
  // pass a check that had the real infimum wrong.
  const crossing = Math.sqrt(0.0525) / 0.05;
  assert.ok(
    crossing >= CONTRAST_FLOOR,
    `the worst case for any colour is ${crossing.toFixed(2)}:1`,
  );
  assert.ok(Math.abs(crossing - 4.58) < 0.01, `${crossing.toFixed(3)} should be the 4.58 quoted`);

  // And then the whole luminance range, densely, as the check that the implementation agrees
  // with the algebra. The ink decision depends on nothing but luminance, so the greys cover
  // every hue -- including the NEXT one somebody appends to the palette.
  for (let value = 0; value <= 255; value += 1) {
    const grey = `#${value.toString(16).padStart(2, '0').repeat(3)}`;
    const best = Math.max(contrastRatio(grey, '#000000'), contrastRatio(grey, '#ffffff'));
    assert.ok(best >= crossing, `${grey}: best-of-two is ${best.toFixed(2)}:1, under the infimum`);
  }
});

test('barText clears the floor on the bar, and is a floor rather than a wash', () => {
  for (const colour of ALL) {
    const ratio = contrastRatio(colour.barText, STATUS_BAR_BG);
    assert.ok(
      ratio >= CONTRAST_FLOOR,
      `${colour.name}: ${colour.barText} on the bar is only ${ratio.toFixed(2)}:1`,
    );
  }
  // A hue that already reads comes back BYTE-IDENTICAL. Full saturation is where the palette's
  // distinguishability lives, so lifting one that needed no lift would cost the thing the
  // colours exist for -- which is what reusing `shimmer` for this would have done to all of them.
  const untouched = ALL.filter((colour) => colour.barText === colour.main);
  assert.ok(
    untouched.length >= PALETTE.length - 2,
    `${String(PALETTE.length - untouched.length)} hues were lifted; only indigo and crimson need it`,
  );
  for (const colour of ALL) {
    if (contrastRatio(colour.main, STATUS_BAR_BG) >= CONTRAST_FLOOR) {
      assert.equal(colour.barText, colour.main, `${colour.name} was lifted without needing it`);
    }
  }
});

test('a lift only ever brightens, so a hue stays recognisably itself', () => {
  for (const colour of ALL) {
    assert.ok(
      relativeLuminance(colour.barText) >= relativeLuminance(colour.main),
      `${colour.name}: the lift darkened it`,
    );
  }
});

test('the bug: tmux’s own default put a clone hue at 1.00:1 against the bar', () => {
  // The regression anchor, kept as arithmetic. tmux's built-in `status-style` is
  // `bg=green,fg=black`, and nothing in the generated conf used to override it -- so the whole
  // palette landed between 1.00 and 2.64 against it, failing even the 3.0 that large text wants.
  // This is why the conf now names its own background, and the number is what makes that
  // decision impossible to undo by accident.
  const TMUX_DEFAULT_GREEN = '#00cc00';
  const green = colourFor(1, 'green');
  assert.ok(
    contrastRatio(green.main, TMUX_DEFAULT_GREEN) < 1.05,
    'the green clone on tmux’s green bar is the same colour twice',
  );
  for (const colour of ALL) {
    assert.ok(
      contrastRatio(colour.main, TMUX_DEFAULT_GREEN) < 3,
      `${colour.name} would have failed even large-text contrast on the default bar`,
    );
    assert.ok(
      contrastRatio(colour.barText, STATUS_BAR_BG) > contrastRatio(colour.main, TMUX_DEFAULT_GREEN),
      `${colour.name} is no better off than it was`,
    );
  }
});

test('the build-state colours clear the floor on the bar they are drawn on', () => {
  /*
   * The one place in this fleet where colour carries MEANING rather than identity, and the one
   * place a golden capture is least able to help: it would happily record an unreadable red for
   * ever, because it says what the colour is and nothing about whether it can be seen.
   *
   * Legal here only because the status bar's background is the fleet's one neutral. The FOOTER
   * is a clone's hue with ink on it, which is why the git state down there is glyphs and never
   * colour -- a red mark on the red clone is invisible in exactly the one case out of sixteen
   * nobody checks.
   */
  for (const [state, hex] of Object.entries(CI_COLOURS)) {
    const ratio = contrastRatio(hex, STATUS_BAR_BG);
    assert.ok(ratio >= CONTRAST_FLOOR, `the ${state} colour is ${ratio.toFixed(2)}:1 on the bar`);
  }

  /*
   * And the reason these go through `barTextFor` rather than being three chosen hex values: the
   * obvious reds do not clear the floor. Measured -- `#f03e3e` is 4.43:1 and pure red is 4.26:1,
   * both under 4.5 and both exactly what somebody would write by hand and never measure.
   */
  for (const naive of ['#f03e3e', '#ff0000']) {
    assert.ok(
      contrastRatio(naive, STATUS_BAR_BG) < CONTRAST_FLOOR,
      `${naive} clears the floor now, so the lift below is no longer proving anything`,
    );
    assert.ok(contrastRatio(barTextFor(naive), STATUS_BAR_BG) >= CONTRAST_FLOOR);
  }

  /*
   * And what this file deliberately does NOT assert: that pass and fail can be told apart from
   * each other. They measure 1.18:1 -- luminance 0.28 against 0.23 -- because a contrast ratio
   * is a luminance metric and these two differ almost only in hue. That is the textbook
   * red/green pair, invisible as a difference to the ~8% of men with deuteranopia, and no
   * arithmetic over two hex values fixes it.
   *
   * So colour is REINFORCEMENT here and never the carrier: the three states are `✓`, `✗` and
   * `◌`, three different shapes, and the bar reads correctly in monochrome. `clone-bar.test.ts`
   * is where that is held, because the glyphs live with the script that prints them.
   */
  assert.ok(
    contrastRatio(CI_COLOURS.pass, CI_COLOURS.fail) < 1.5,
    'pass and fail now differ in luminance — the glyphs may no longer be load-bearing, recheck',
  );
});
