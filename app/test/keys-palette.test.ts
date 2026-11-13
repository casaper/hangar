import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KEY_TABLE, PALETTE_ONLY, paletteRows, RETIRED_KEYS } from '../src/keys.ts';
import { EXPOSURES } from '../src/mcp/tools.ts';

/**
 * The palette `C-b P` opens: properties only, since golden pins the binding byte for byte.
 */

const rows = paletteRows(KEY_TABLE, PALETTE_ONLY);

test('the palette offers every key but itself, and every palette-only command, once', () => {
  const offered = rows.map((r) => r.argv.join(' '));
  for (const entry of KEY_TABLE) {
    const name = entry.argv.join(' ');
    assert.equal(offered.filter((a) => a === name).length, name === 'key palette' ? 0 : 1, name);
  }
  for (const command of PALETTE_ONLY) {
    assert.equal(offered.filter((a) => a === command.argv.join(' ')).length, 1);
  }
  assert.equal(new Set(rows.map((r) => r.label)).size, rows.length, 'two rows share a label');
});

test('a row shows its chord or its command first, so a search for either finds it', () => {
  for (const entry of KEY_TABLE.filter((k) => k.argv.join(' ') !== 'key palette')) {
    assert.ok(
      rows.some((r) => r.label.startsWith(`C-b ${entry.key} `)),
      entry.key,
    );
  }
  for (const command of PALETTE_ONLY) {
    assert.ok(rows.some((r) => r.label.startsWith(`hangar ${command.argv.join(' ')} `)));
  }
});

/**
 * A palette row runs on one keypress with nothing typed to read first, so it may be only what a
 * report is. The MCP table already says which commands act; a row must match an exposure that
 * does not, or be one of the two named here, whose only effect is a browser tab or the shared
 * `tmp/` merge every clone's `SessionEnd` hook already runs unasked.
 */
const HARMLESS_ACTING = new Set(['browse', 'tmp merge']);

test('a palette-only command is a report, or as harmless as a key', () => {
  for (const command of PALETTE_ONLY) {
    // `browse pr`: the second word is browse's argument, not a subcommand.
    const name = command.argv[0] === 'browse' ? 'browse' : command.argv.join(' ');
    if (HARMLESS_ACTING.has(name)) continue;
    const reports = EXPOSURES.some(
      (e) => e.path.join(' ') === name && !e.acts && (e.fixed ?? []).length === 0,
    );
    assert.ok(reports, `${name} is not a report in src/mcp/tools.ts`);
  }
});

test('the palette key is not one this table retired', () => {
  assert.ok(KEY_TABLE.some((k) => k.key === 'P'));
  assert.ok(!RETIRED_KEYS.includes('P'));
});
