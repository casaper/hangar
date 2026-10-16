import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apcaContrast,
  barTextFor,
  CI_COLOURS,
  colourFor,
  contrastRatio,
  CONTRAST_FLOOR,
  deltaE2000,
  INK_FLOOR_LC,
  MODE_COLOURS,
  PALETTE,
  PALETTE_MIN_DELTA_E,
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

const ALL = PALETTE.map((entry) => colourFor(PALETTE, 1, entry.name));

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

const lc = (text: string, bg: string): number => Math.abs(apcaContrast(text, bg));

test('every hue’s ink clears the floor on its own hue', () => {
  for (const colour of ALL) {
    const value = lc(colour.ink, colour.main);
    assert.ok(
      value >= INK_FLOOR_LC,
      `${colour.name}: ${colour.ink} on ${colour.main} is only Lc ${value.toFixed(1)}`,
    );
  }
});

test('the ink is one of exactly two values, and the better of them by APCA', () => {
  // The assertion that keeps the guarantee from being tuned away. The floor below is a property
  // of PURE black and white; a near-black picked to match the bar would look tidier, still pass
  // the test above on today's palette, and quietly void the floor for the next hue appended.
  // So the pair itself is pinned, not just the outcome.
  for (const colour of ALL) {
    assert.ok(
      colour.ink === '#000000' || colour.ink === '#ffffff',
      `${colour.name}: ink is ${colour.ink}, which is neither black nor white`,
    );
    const other = colour.ink === '#000000' ? '#ffffff' : '#000000';
    assert.ok(
      lc(colour.ink, colour.main) >= lc(other, colour.main),
      `${colour.name}: the other ink reads better (Lc ${lc(other, colour.main).toFixed(1)})`,
    );
  }
});

test('the bug: WCAG 2.1 gave seven mid-tone hues black ink that reads worse', () => {
  // The regression anchor, kept as arithmetic. By WCAG's ratio black wins on every one of these;
  // by APCA, and by eye, white does. If this ever stops holding, the ink switch is no longer
  // what decides them and the reason for APCA here needs re-measuring.
  for (const name of ['magenta', 'violet', 'red', 'blue']) {
    const colour = colourFor(PALETTE, 1, name);
    assert.equal(colour.ink, '#ffffff', `${name} should take white ink`);
    assert.ok(
      contrastRatio(colour.main, '#000000') > contrastRatio(colour.main, '#ffffff'),
      `${name}: WCAG no longer prefers black, so this is not the case it was`,
    );
  }
});

test(`best-of-black-or-white cannot fall below Lc ${String(INK_FLOOR_LC)}, for any colour`, () => {
  // Both inks' Lc depend on nothing but the ground's luminance, so the greys reach every
  // luminance an 8-bit colour can -- and a coarse RGB grid on top checks that the channel weights
  // do not open a gap the greys miss. Measured infimum: Lc 54.55, at #d57eff.
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const check = (ground: string): void => {
    const best = Math.max(lc('#000000', ground), lc('#ffffff', ground));
    assert.ok(best >= INK_FLOOR_LC, `${ground}: best-of-two is Lc ${best.toFixed(2)}`);
  };
  for (let value = 0; value <= 255; value += 1) check(`#${hex(value).repeat(3)}`);
  for (let r = 0; r <= 255; r += 15) {
    for (let g = 0; g <= 255; g += 15) {
      for (let b = 0; b <= 255; b += 15) check(`#${hex(r)}${hex(g)}${hex(b)}`);
    }
  }
  check('#d57eff');
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
    untouched.length >= PALETTE.length - 3,
    `${String(PALETTE.length - untouched.length)} hues were lifted; only forest, raspberry and plum need it`,
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
  const green = colourFor(PALETTE, 1, 'green');
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
   * colour -- a red mark on the red clone is invisible in exactly the one case out of twenty
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

test('no two hues are near-duplicates', () => {
  // A palette is only as good as its closest pair: two clones a person cannot tell apart are one
  // clone as far as the colours go.
  for (const [i, entry] of PALETTE.entries()) {
    for (const other of PALETTE.slice(i + 1)) {
      const distance = deltaE2000(entry.hex, other.hex);
      assert.ok(
        distance >= PALETTE_MIN_DELTA_E,
        `${entry.name} and ${other.name} are only ΔE ${distance.toFixed(1)} apart`,
      );
    }
  }
  const names = PALETTE.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, 'two palette entries share a name');
});

test('no hue resembles a mode tab, except the one a fleet already uses', () => {
  // A clone tab that looks like the ops tab is the same confusion one level up, so the ten picked
  // hues were searched against both mode colours too. `blue` predates that search and is in use,
  // so it is the one named exception, at ΔE 14.4 from ops -- close, still well clear of the 9.3
  // the test below rejects.
  for (const entry of PALETTE) {
    for (const [mode, colour] of Object.entries(MODE_COLOURS)) {
      const distance = deltaE2000(entry.hex, colour.main);
      const floor = entry.name === 'blue' ? 14 : PALETTE_MIN_DELTA_E;
      assert.ok(distance >= floor, `${entry.name} is ΔE ${distance.toFixed(1)} from ${mode} mode`);
    }
  }
});

test('the floor rejects the near-duplicate it was set against', () => {
  // The anchor, as arithmetic: `violet` against a full purple, `#cc44ff`, which a hue-wheel pick
  // with no distance floor adds without a second look. If this ever clears the floor, the floor
  // has been lowered past what it is for.
  assert.ok(deltaE2000('#9966ff', '#cc44ff') < 10);
  assert.ok(deltaE2000('#9966ff', '#cc44ff') < PALETTE_MIN_DELTA_E);
});

test('deltaE2000 behaves as a distance', () => {
  // Structural checks rather than reference data: zero on identity, symmetric, and black to white
  // is the full lightness range, 100.
  assert.equal(deltaE2000('#ffffff', '#ffffff'), 0);
  assert.ok(Math.abs(deltaE2000('#000000', '#ffffff') - 100) < 0.01);
  const symmetric = deltaE2000('#00ccff', '#3399ff') - deltaE2000('#3399ff', '#00ccff');
  assert.ok(Math.abs(symmetric) < 1e-9, 'ΔE is not symmetric');
});
