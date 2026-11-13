import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { selectionCommandText } from '../src/commands/key.ts';
import { CliError } from '../src/exec.ts';
import {
  keysExtensionManifest,
  keysExtensionProblem,
  keysExtensionVersion,
  paletteCommandId,
  vsixPackageFiles,
} from '../src/editor/keys-extension.ts';
import {
  KEY_TABLE,
  PALETTE_ONLY,
  type PaletteEntry,
  VSCODE_ONLY_KEYS,
  vscodeKeyName,
  vscodeKeybindings,
} from '../src/keys.ts';

/**
 * The VS Code half of the hangar keys. The manifest is generated and the script is hand-written,
 * so the property that matters is that the two name the same commands: a command the manifest
 * binds and the script never registers is a key that does nothing, with every gate green.
 */

const script = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'vscode-extension', 'extension.cjs'),
  'utf8',
);
const registered = new Set([...script.matchAll(/register\('([^']+)'/g)].map((m) => m[1]));

test('every VS Code chord is the tmux chord, on macOS only', () => {
  const bindings = vscodeKeybindings(KEY_TABLE, VSCODE_ONLY_KEYS);
  for (const entry of KEY_TABLE) {
    if (entry.vscode === undefined) continue;
    const binding = bindings.find((b) => b.command === entry.vscode);
    assert.equal(binding?.key, `ctrl+b ${vscodeKeyName(entry.key)}`, entry.key);
  }
  for (const binding of bindings) assert.match(binding.when, /^isMac\b/, binding.command);
  assert.equal(vscodeKeyName('C-g'), 'ctrl+g');
  assert.equal(vscodeKeyName('a'), 'a');
  // The two the developer excluded stay tmux-only.
  for (const key of ['C-e', 'C-k']) {
    assert.equal(KEY_TABLE.find((e) => e.key === key)?.vscode, undefined, key);
  }
});

const ENTRIES: readonly PaletteEntry[] = [
  { name: 'tidy-files', run: 'background', prompt: '/tidy-all {file}' },
  { name: 'ship-it', run: 'session', prompt: '/ship' },
];

type Manifest = {
  contributes: {
    commands: { command: string; title: string; category: string }[];
    keybindings: { command: string }[];
    menus: { 'explorer/context': { command: string }[] };
  };
  hangarPalette: { command: string; name: string; needs: string }[];
};

test('the manifest and the script name exactly the same commands', () => {
  const manifest = keysExtensionManifest('1.0.0', ENTRIES) as Manifest;
  const declared = new Set(manifest.contributes.commands.map((c) => c.command));
  for (const binding of manifest.contributes.keybindings) {
    assert.ok(declared.has(binding.command), `${binding.command} is bound and not declared`);
  }
  // The palette's commands are registered by the list the manifest carries, not one by one.
  const palette = new Set(manifest.hangarPalette.map((row) => row.command));
  assert.ok(script.includes('packageJSON.hangarPalette'), 'the script never reads the palette');
  assert.deepEqual([...declared].filter((c) => !palette.has(c)).sort(), [...registered].sort());
  for (const command of palette) assert.ok(declared.has(command), `${command} is not declared`);
});

test('VS Code lists every palette command and entry under Hangar, and none of the tmux-only rows', () => {
  const manifest = keysExtensionManifest('1.0.0', ENTRIES) as Manifest;
  const ids = manifest.hangarPalette.map((row) => row.command);
  for (const command of PALETTE_ONLY) assert.ok(ids.includes(paletteCommandId(command.name)));
  for (const entry of ENTRIES) assert.ok(ids.includes(paletteCommandId(entry.name)));
  for (const c of manifest.contributes.commands) assert.equal(c.category, 'Hangar', c.command);
  // The title leads with the name, so `Hangar: ship` finds it.
  const ship = manifest.contributes.commands.find((c) => c.command === paletteCommandId('ship-it'));
  assert.match(ship?.title ?? '', /^ship-it /);
  // Only an entry that takes files is offered on a right-click in the Explorer.
  assert.deepEqual(
    manifest.contributes.menus['explorer/context'].map((m) => m.command),
    [paletteCommandId('tidy-files')],
  );
  // The palette itself, the editor picker and the help are tmux's.
  for (const key of ['P', 'C-e', 'C-k']) {
    assert.equal(KEY_TABLE.find((e) => e.key === key)?.vscode, undefined, key);
  }
});

test('the version follows the content, so a changed key table or script is a stale install', () => {
  const version = keysExtensionVersion(script, ENTRIES);
  assert.match(version, /^1\.0\.\d+$/);
  assert.equal(keysExtensionVersion(script, ENTRIES), version, 'the same bytes, the same version');
  assert.notEqual(keysExtensionVersion(`${script}\n`, ENTRIES), version);
  assert.notEqual(keysExtensionVersion(script, []), version, 'a changed palette is a new version');
  assert.match(vsixPackageFiles(version)['extension.vsixmanifest'] ?? '', new RegExp(version));
  assert.equal(keysExtensionProblem({ wanted: version, installed: [version] }), undefined);
  assert.match(keysExtensionProblem({ wanted: version, installed: [] }) ?? '', /not installed/);
  assert.match(keysExtensionProblem({ wanted: version, installed: ['1.0.1'] }) ?? '', /1\.0\.1/);
});

test('the selection command fills {ref}, and names its key when none is configured', () => {
  assert.equal(selectionCommandText('/skill {ref}', '@/a.ts#1-2'), '/skill @/a.ts#1-2');
  assert.throws(
    () => selectionCommandText(undefined, '@/a.ts'),
    (error: unknown) =>
      error instanceof CliError && error.message.includes('keys.selectionCommand'),
  );
});

test('the script names no hangar, repository or machine', () => {
  // It runs for every hangar on the machine and finds its own from the workspace.
  for (const literal of ['clone_0', '/Users/', '/home/', 'angular/']) {
    assert.ok(!script.includes(literal), `extension.cjs contains ${literal}`);
  }
});
