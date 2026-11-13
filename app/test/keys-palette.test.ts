import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hangarConfigSchema } from '../src/config/schema.ts';
import {
  KEY_TABLE,
  PALETTE_ONLY,
  type PaletteEntry,
  paletteRows,
  promptFor,
  RETIRED_KEYS,
} from '../src/keys.ts';
import { EXPOSURES } from '../src/mcp/tools.ts';

/**
 * The palette `C-b P` opens: properties only, since golden pins the binding byte for byte.
 */

const ENTRIES: readonly PaletteEntry[] = [
  { name: 'tidy-lines', run: 'background', prompt: '/tidy {ref}' },
  { name: 'tidy-files', run: 'background', prompt: '/tidy-all {file}' },
  { name: 'ship-it', run: 'session', prompt: '/ship' },
];

const rows = paletteRows(KEY_TABLE, PALETTE_ONLY, ENTRIES);
const commandRows = rows.flatMap((r) => (r.kind === 'command' ? [r] : []));

test('the palette offers every key but itself, every command and every entry, once', () => {
  const offered = commandRows.map((r) => r.argv.join(' '));
  for (const entry of KEY_TABLE) {
    const name = entry.argv.join(' ');
    assert.equal(offered.filter((a) => a === name).length, name === 'key palette' ? 0 : 1, name);
  }
  for (const command of PALETTE_ONLY) {
    assert.equal(offered.filter((a) => a === command.argv.join(' ')).length, 1, command.name);
  }
  for (const entry of ENTRIES) {
    assert.equal(rows.filter((r) => r.kind === 'entry' && r.entry === entry).length, 1);
  }
  assert.equal(new Set(rows.map((r) => r.label)).size, rows.length, 'two rows share a label');
  const names = PALETTE_ONLY.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'two built-in commands share a name');
});

test('a row shows its chord, its command or its name first, so a search for either finds it', () => {
  for (const entry of KEY_TABLE.filter((k) => k.argv.join(' ') !== 'key palette')) {
    assert.ok(
      rows.some((r) => r.label.startsWith(`C-b ${entry.key} `)),
      entry.key,
    );
  }
  for (const command of PALETTE_ONLY) {
    const short = command.acts ? command.name : `hangar ${command.argv.join(' ')}`;
    assert.ok(
      rows.some((r) => r.label.startsWith(`${short} `)),
      short,
    );
  }
  for (const entry of ENTRIES) assert.ok(rows.some((r) => r.label.startsWith(`${entry.name} `)));
});

/**
 * A built-in palette command runs on one keypress with nothing typed to read first, so it is a
 * report unless it is named here. The MCP table already says which commands act; a report must
 * match an exposure that does not, or be one of the two whose only effect is a browser tab or the
 * shared `tmp/` merge every clone's `SessionEnd` hook already runs unasked.
 */
const HARMLESS_ACTING = new Set(['browse', 'tmp merge']);
const ACTING_ON_PURPOSE = new Set(['update-pr', 'hangar-reload']);

test('a built-in palette command is a report, or one of the two that act on purpose', () => {
  for (const command of PALETTE_ONLY) {
    assert.equal(command.acts, ACTING_ON_PURPOSE.has(command.name), command.name);
    if (command.acts) continue;
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

test('a {ref} entry needs selected lines, never a bare cursor', () => {
  const lines = { editor: '@/w/a.ts#3-9', explorer: [] };
  assert.deepEqual(promptFor('/tidy {ref}', lines), { text: '/tidy @/w/a.ts#3-9' });
  assert.ok('refuse' in promptFor('/tidy {ref}', { editor: '@/w/a.ts', explorer: [] }));
  assert.ok('refuse' in promptFor('/tidy {ref}', { explorer: ['/w/b.ts'] }));
});

test('a {file} entry takes the Explorer first, else the editor with its lines stripped', () => {
  assert.deepEqual(promptFor('/all {file}', { editor: '@/w/a.ts#3-9', explorer: [] }), {
    text: '/all @/w/a.ts',
  });
  assert.deepEqual(
    promptFor('/all {file}', { editor: '@/w/a.ts#3', explorer: ['/w/b.ts', '/w/c.ts'] }),
    { text: '/all @/w/b.ts @/w/c.ts' },
  );
  assert.ok('refuse' in promptFor('/all {file}', { explorer: [] }));
  assert.deepEqual(promptFor('/ship', { explorer: [] }), { text: '/ship' });
});

test('a palette entry is refused when its tokens and its kind disagree', () => {
  const keys = hangarConfigSchema.shape.keys;
  const parse = (entry: Record<string, unknown>): boolean =>
    keys.safeParse({ palette: [entry] }).success;
  assert.ok(parse({ name: 'tidy', run: 'background', prompt: '/tidy {ref}' }));
  assert.ok(parse({ name: 'ship', run: 'session', prompt: '/ship' }));
  assert.ok(!parse({ name: 'Tidy', run: 'background', prompt: '/tidy' }), 'not kebab-case');
  assert.ok(!parse({ name: 'tidy', run: 'background', prompt: '{ref} {file}' }), 'both tokens');
  assert.ok(!parse({ name: 'ship', run: 'session', prompt: '/ship {ref}' }), 'token in a session');
  assert.ok(!parse({ name: 'ship', run: 'session', prompt: '/ship', timeoutMinutes: 3 }));
  assert.ok(!parse({ name: 'update-pr', run: 'session', prompt: '/x' }), 'a built-in name');
});
