import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '../exec.ts';
import type { Hangar } from '../hangar.ts';
import {
  KEY_TABLE,
  PALETTE_ONLY,
  paletteNeeds,
  VSCODE_ONLY_KEYS,
  vscodeKeybindings,
  type HangarKey,
  type PaletteCommand,
  type PaletteEntry,
  type VscodeOnlyKey,
} from '../keys.ts';

/**
 * The hangar keys' VS Code extension: built from `app/vscode-extension/extension.cjs` and the key
 * table, packed into a `.vsix` and installed with `code --install-extension`.
 *
 * **A `.vsix` and not a linked folder.** VS Code keeps the installed set in
 * `~/.vscode/extensions/extensions.json`, and a folder that file does not list is not a supported
 * install. A `.vsix` is a zip with two XML files beside the extension, so this writes it with
 * `zip` and needs no packaging tool -- no dependency, and nothing to keep past the floor.
 *
 * **The manifest is generated, never tracked**, so the chords cannot drift from tmux's: every
 * `ctrl+b` chord is a `KEY_TABLE` row with a `vscode` command.
 *
 * **One extension per machine, for every hangar on it** (`hangar.hangar-keys`). The script finds
 * its hangar from the window's workspace, so nothing in it names one. Its version is a hash of
 * what it ships, so two hangars at the same CLI version install the same bytes, and `doctor` can
 * say the installed one is stale without asking VS Code anything.
 */

export const KEYS_EXTENSION_ID = 'hangar.hangar-keys';

/** The extension's script in this hangar's own checkout. */
export const keysExtensionScript = (hangar: Hangar): string =>
  join(hangar.root, 'app', 'vscode-extension', 'extension.cjs');

/** The command id a palette command or entry has in VS Code. */
export const paletteCommandId = (name: string): string => `hangar.palette.${name}`;

/**
 * One palette command or `keys.palette` entry, as the script reads it out of its own manifest
 * (`hangarPalette`, a field VS Code ignores): the script registers these by the list, so it needs
 * no edit when the config grows one.
 */
export type VscodePaletteCommand = {
  readonly command: string;
  readonly name: string;
  readonly title: string;
  /** The whole output in the Hangar channel, or its first line as a notification. */
  readonly show: 'output' | 'line';
  /** What it needs from the editor, so the script sends the selection only where it counts. */
  readonly needs: 'lines' | 'files' | 'nothing';
};

/**
 * Every palette row VS Code gets: the built-in commands and the config's entries. PURE.
 *
 * Not the keys -- each has its own command already -- and not the palette itself, which VS Code's
 * own Cmd+Shift+P is. The title leads with the name, so typing it after `Hangar:` finds the row.
 */
export const vscodePaletteCommands = (
  only: readonly PaletteCommand[],
  entries: readonly PaletteEntry[],
): VscodePaletteCommand[] => [
  ...only.map((c) => ({
    command: paletteCommandId(c.name),
    name: c.name,
    title: `${c.name} — ${c.does}`,
    show: c.vscode,
    needs: 'nothing' as const,
  })),
  ...entries.map((e) => ({
    command: paletteCommandId(e.name),
    name: e.name,
    title: `${e.name} — ${e.does ?? (e.run === 'background' ? `${e.prompt} (in the background)` : e.prompt)}`,
    show: 'line' as const,
    needs: paletteNeeds(e.prompt),
  })),
];

/** Every command the manifest declares, with the title VS Code's command palette shows. */
const commandsOf = (
  table: readonly HangarKey[],
  only: readonly VscodeOnlyKey[],
  palette: readonly VscodePaletteCommand[],
): { command: string; title: string; category: string }[] => {
  const seen = new Map<string, string>();
  for (const entry of table) if (entry.vscode !== undefined) seen.set(entry.vscode, entry.does);
  for (const key of only) if (!seen.has(key.command)) seen.set(key.command, key.does);
  for (const row of palette) seen.set(row.command, row.title);
  return [...seen].map(([command, title]) => ({ command, title, category: 'Hangar' }));
};

/**
 * The manifest without its version, which is the half the version is a hash of. PURE.
 *
 * **The config's palette entries are part of it**, so a changed `keys.palette` is a new version
 * and `doctor` reports the installed one stale until `--fix` reinstalls it. One extension serves
 * every hangar on the machine, so a second hangar with other entries replaces these with its own
 * -- accepted, and in `hangar-internals/reference/editors.md`.
 */
const manifestBody = (entries: readonly PaletteEntry[]): Record<string, unknown> => {
  const palette = vscodePaletteCommands(PALETTE_ONLY, entries);
  return {
    name: 'hangar-keys',
    publisher: 'hangar',
    displayName: 'Hangar keys',
    description: "A hangar clone's tmux keys, in the clone's VS Code window.",
    engines: { vscode: '^1.80.0' },
    main: './extension.cjs',
    // At startup rather than on first command: the window has to answer requests from the tmux
    // side, which arrive before anybody has pressed anything here.
    activationEvents: ['onStartupFinished'],
    extensionKind: ['workspace'],
    contributes: {
      commands: commandsOf(KEY_TABLE, VSCODE_ONLY_KEYS, palette),
      keybindings: vscodeKeybindings(KEY_TABLE, VSCODE_ONLY_KEYS),
      // A right-click on files in the Explorer hands them to an entry that takes files.
      menus: {
        'explorer/context': palette
          .filter((row) => row.needs === 'files')
          .map((row) => ({ command: row.command, group: 'hangar' })),
      },
    },
    hangarPalette: palette,
  };
};

/** `1.0.<n>`, n from a hash of the manifest and the script: a change to either is a new version. */
export const keysExtensionVersion = (script: string, entries: readonly PaletteEntry[]): string => {
  const digest = createHash('sha256')
    .update(JSON.stringify(manifestBody(entries)))
    .update(script)
    .digest('hex');
  return `1.0.${String(Number.parseInt(digest.slice(0, 8), 16))}`;
};

/** The manifest the `.vsix` carries. PURE. */
export const keysExtensionManifest = (
  version: string,
  entries: readonly PaletteEntry[],
): Record<string, unknown> => ({
  ...manifestBody(entries),
  version,
});

/** The two files a `.vsix` needs beside the extension, for this version. PURE. */
export const vsixPackageFiles = (version: string): Record<string, string> => ({
  '[Content_Types].xml': [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension=".json" ContentType="application/json"/>',
    '<Default Extension=".cjs" ContentType="application/javascript"/>',
    '<Default Extension=".vsixmanifest" ContentType="text/xml"/>',
    '</Types>',
    '',
  ].join('\n'),
  'extension.vsixmanifest': [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="hangar-keys" Version="${version}" Publisher="hangar"/>`,
    '    <DisplayName>Hangar keys</DisplayName>',
    '    <Description xml:space="preserve">A hangar clone&apos;s tmux keys, in the clone&apos;s VS Code window.</Description>',
    '    <Categories>Other</Categories>',
    '    <Properties>',
    '      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0"/>',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>',
    '    </Properties>',
    '  </Metadata>',
    '  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>',
    '  <Dependencies/>',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>',
    '  </Assets>',
    '</PackageManifest>',
    '',
  ].join('\n'),
});

/** The versions of this extension installed in `extensionsDir`, from the folder names VS Code uses. */
export const installedKeysExtensions = (extensionsDir: string): string[] => {
  try {
    return readdirSync(extensionsDir)
      .filter((name) => name.startsWith(`${KEYS_EXTENSION_ID}-`))
      .map((name) => name.slice(KEYS_EXTENSION_ID.length + 1));
  } catch {
    return [];
  }
};

/** `~/.vscode/extensions`, where VS Code installs for this user. */
export const defaultExtensionsDir = (home: string): string => join(home, '.vscode', 'extensions');

export type KeysExtensionState = {
  readonly wanted: string;
  readonly installed: readonly string[];
};

export const keysExtensionState = (hangar: Hangar, extensionsDir: string): KeysExtensionState => ({
  wanted: keysExtensionVersion(
    readFileSync(keysExtensionScript(hangar), 'utf8'),
    hangar.config.keys.palette,
  ),
  installed: installedKeysExtensions(extensionsDir),
});

/** What a `doctor` row or a sync says about the install, or undefined when it is current. PURE. */
export const keysExtensionProblem = (state: KeysExtensionState): string | undefined => {
  if (state.installed.includes(state.wanted)) return undefined;
  return state.installed.length === 0
    ? 'the hangar keys extension is not installed in VS Code, so C-b … and C-k C-k do nothing there'
    : `the hangar keys extension in VS Code is ${state.installed.join(', ')}, not ${state.wanted}`;
};

/**
 * Build the `.vsix` and install it. Returns undefined on success, or what went wrong.
 *
 * `--force` replaces whatever version is installed, which is every install after the first: the
 * version is a hash, so "newer" means nothing and "different" is the only question.
 * `extensionsDir` exists for the probe -- a scratch directory keeps a test install out of the
 * developer's own VS Code.
 */
export const installKeysExtension = (
  hangar: Hangar,
  binary: string,
  extensionsDir?: string,
): string | undefined => {
  const script = readFileSync(keysExtensionScript(hangar), 'utf8');
  const version = keysExtensionVersion(script, hangar.config.keys.palette);
  const stage = mkdtempSync(join(tmpdir(), 'hangar-keys-'));
  try {
    const files: Record<string, string> = {
      ...vsixPackageFiles(version),
      'extension/package.json': `${JSON.stringify(keysExtensionManifest(version, hangar.config.keys.palette), null, 2)}\n`,
      'extension/extension.cjs': script,
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(stage, 'pkg', name)), { recursive: true });
      writeFileSync(join(stage, 'pkg', name), content);
    }
    const vsix = join(stage, `hangar-keys-${version}.vsix`);
    const zipped = run('zip', ['-q', '-X', '-r', vsix, '.'], { cwd: join(stage, 'pkg') });
    if (!zipped.ok) return `could not pack the extension: ${zipped.stderr.trim() || 'zip failed'}`;
    const args = [
      ...(extensionsDir === undefined ? [] : ['--extensions-dir', extensionsDir]),
      '--install-extension',
      vsix,
      '--force',
    ];
    const installed = run(binary, args);
    return installed.ok
      ? undefined
      : `could not install it: ${installed.stderr.trim() || installed.stdout.trim()}`;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};
