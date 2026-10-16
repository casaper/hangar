import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hangarConfigSchema } from '../src/config/schema.ts';
import { cloneAt, paletteOf } from '../src/fleet.ts';
import { colourByHex, colourFor, effectivePalette, PALETTE } from '../src/palette.ts';
import { fixtureConfigText, fixtureVscodeConfigText, syntheticHangar } from './fixture.ts';

/**
 * `palette.hues` and `palette.rotate`, read from each hangar's own config.
 *
 * Both gated fixtures set one or both keys, so neither capture renders the default palette any
 * more: the unrotated built-in formula is held here instead. Properties, not snapshots -- the
 * bytes are golden's.
 */

const withoutPalette = (text: string): string => text.replace(/\npalette:\n(?: .*\n|\n)*/, '\n');

const CUSTOM = [
  { name: 'rust', hex: '#B7410E' },
  { name: 'moss', hex: '#8a9a5b' },
  { name: 'slate', hex: '#708090' },
];

test('a hangar with no palette section takes the built-in hues in order', () => {
  const hangar = syntheticHangar({
    root: '/hangars/plain',
    claudeDir: '/synthetic-claude',
    configText: withoutPalette(fixtureConfigText()),
  });
  assert.equal(hangar.config.palette.hues, undefined);
  assert.equal(hangar.config.palette.rotate, 0);
  for (const index of [1, 2, 3, PALETTE.length]) {
    assert.equal(cloneAt(hangar, index).colour.name, PALETTE[index - 1]?.name);
  }
  assert.equal(cloneAt(hangar, PALETTE.length + 1).colour.name, PALETTE[0].name);
  assert.ok(cloneAt(hangar, PALETTE.length + 1).colour.reused);
});

test('rotate shifts the formula slot and wraps', () => {
  const palette = effectivePalette({ rotate: 5 });
  assert.equal(colourFor(palette, 1).name, PALETTE[5].name);
  assert.equal(colourFor(palette, PALETTE.length - 4).name, PALETTE[0].name);
  // A rotation past the length is the same rotation, not an out-of-range slot.
  assert.deepEqual(effectivePalette({ rotate: 5 + PALETTE.length }), palette);
});

test('hues replace the built-in set, lowercased, and rotate applies to them', () => {
  const palette = effectivePalette({ hues: CUSTOM, rotate: 1 });
  assert.deepEqual(
    palette.map((entry) => entry.name),
    ['moss', 'slate', 'rust'],
  );
  assert.equal(colourFor(palette, 3).main, '#b7410e');
  assert.equal(colourFor(palette, 4).name, 'moss');
  assert.ok(colourFor(palette, 4).reused, 'a three-hue palette wraps at clone 4');
});

test('an assignment resolves by name, whatever the rotation', () => {
  const palette = effectivePalette({ rotate: 7 });
  const assigned = colourFor(palette, 1, 'green');
  assert.equal(assigned.name, 'green');
  assert.ok(assigned.explicit);
  // A name the hangar's palette does not hold falls back to the formula.
  const custom = effectivePalette({ hues: CUSTOM, rotate: 0 });
  assert.equal(colourFor(custom, 2, 'green').name, 'moss');
});

test('a tmux window tag resolves against its own hangar palette', () => {
  const custom = effectivePalette({ hues: CUSTOM, rotate: 0 });
  assert.equal(colourByHex(custom, '#B7410E')?.name, 'rust');
  assert.equal(colourByHex(custom, PALETTE[0].hex), undefined);
});

test('duplicate hue names or hexes are refused at load', () => {
  const base = {
    hues: [
      { name: 'rust', hex: '#b7410e' },
      { name: 'rust', hex: '#8a9a5b' },
    ],
  };
  const named = hangarConfigSchema.shape.palette.safeParse(base);
  assert.equal(named.success, false);
  const hexed = hangarConfigSchema.shape.palette.safeParse({
    hues: [
      { name: 'rust', hex: '#b7410e' },
      { name: 'moss', hex: '#B7410E' },
    ],
  });
  assert.equal(hexed.success, false);
});

test('two hangars in one process each keep their own palette', () => {
  const plain = syntheticHangar({
    root: '/hangars/plain',
    claudeDir: '/synthetic-claude',
    configText: withoutPalette(fixtureConfigText()),
  });
  const custom = syntheticHangar({
    root: '/hangars/custom',
    claudeDir: '/synthetic-claude',
    configText: fixtureVscodeConfigText(),
  });
  const customNames = new Set(paletteOf(custom).map((entry) => entry.name));
  const customHexes = new Set(paletteOf(custom).map((entry) => entry.hex));

  // Interleaved: a cache keyed on nothing shows up on the third read.
  const p1 = cloneAt(plain, 1).colour;
  const c1 = cloneAt(custom, 1).colour;
  const p1Again = cloneAt(plain, 1).colour;

  assert.equal(p1.name, PALETTE[0].name);
  assert.ok(customNames.has(c1.name), `${c1.name} is not one of the custom hues`);
  assert.deepEqual(p1Again, p1, 'the plain hangar answered differently after the custom one');
  for (const index of [1, 2, 3]) {
    const colour = cloneAt(plain, index).colour;
    assert.ok(!customHexes.has(colour.main), `${colour.main} crossed from the custom hangar`);
  }
});
