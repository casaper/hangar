/**
 * The editor names and their per-product tables, in a module that imports NOTHING.
 *
 * A leaf on purpose. The config schema needs these to build its enums, and the drivers need them
 * to key their tables -- and a driver imports `clone-config.ts`, `git.ts` and `exec.ts`, so
 * having `config/schema.ts` reach into a driver to borrow one list would wire the config loader
 * to half the CLI. Keeping the names here means neither side duplicates them and neither imports
 * the other.
 */

/**
 * ## Why the VS Code forks are separate KINDS and JetBrains products are not
 *
 * Cursor and VS Code can sensibly both be open on the same clone -- different tools, same repo,
 * and people do run them side by side -- so each fork is its own kind and `editor.kinds` can list
 * several. Two JetBrains IDEs on one project is unusual (the family is one IDE per language), so
 * JetBrains is one kind with a `product` selector instead.
 */
export type VscodeFork =
  'vscode' | 'cursor' | 'windsurf' | 'vscodium' | 'code-insiders' | 'positron' | 'trae';

export type EditorKind = VscodeFork | 'jetbrains' | 'zed' | 'emacs' | 'vim' | 'xcode' | 'eclipse';

/**
 * The VS Code family: one launcher and one window-state file each.
 *
 * `stateDir` is the directory under `~/Library/Application Support` holding that fork's
 * `User/globalStorage/storage.json`, and it is the reason this table exists at all. The whole
 * point of reading that file is to hand the fork the exact `*.code-workspace` copy it ALREADY
 * has open -- these editors identify a workspace by its config file's URI, so the clone's two
 * byte-identical twins are two different workspaces to them. Read the wrong fork's state file
 * and the answer is not merely stale, it is about a different application's windows, which is
 * how you get a second window on identical content while believing you avoided one.
 */
export const VSCODE_FAMILY = {
  vscode: { binary: 'code', label: 'VS Code', stateDir: 'Code' },
  cursor: { binary: 'cursor', label: 'Cursor', stateDir: 'Cursor' },
  windsurf: { binary: 'windsurf', label: 'Windsurf', stateDir: 'Windsurf' },
  vscodium: { binary: 'codium', label: 'VSCodium', stateDir: 'VSCodium' },
  'code-insiders': {
    binary: 'code-insiders',
    label: 'VS Code Insiders',
    stateDir: 'Code - Insiders',
  },
  positron: { binary: 'positron', label: 'Positron', stateDir: 'Positron' },
  trae: { binary: 'trae', label: 'Trae', stateDir: 'Trae' },
} as const;

export const VSCODE_FORKS = Object.keys(VSCODE_FAMILY) as VscodeFork[];

export const isVscodeFork = (kind: EditorKind): kind is VscodeFork =>
  (VSCODE_FORKS as readonly string[]).includes(kind);

/**
 * The one editor that has to work.
 *
 * Both the schema default and the fallback in `index.ts` read it from here, so "VS Code is the
 * default" is stated once rather than agreed on by two files. Every other kind is best effort --
 * supported so a developer can pick it, written from each editor's documented contract, and (bar
 * this one) never exercised against a live install. That asymmetry is deliberate and is why the
 * multi-editor paths isolate their drivers: an optional editor must never cost a clone this one.
 */
export const DEFAULT_EDITOR_KIND: EditorKind = 'vscode';

// Spelled out rather than spread from VSCODE_FORKS: zod's `z.enum` wants a non-empty tuple, and
// a spread of a `VscodeFork[]` cannot prove to TypeScript that there is a first element.
export const EDITOR_KINDS = [
  'vscode',
  'cursor',
  'windsurf',
  'vscodium',
  'code-insiders',
  'positron',
  'trae',
  'jetbrains',
  'zed',
  'emacs',
  'vim',
  'xcode',
  'eclipse',
] as const satisfies readonly [EditorKind, ...EditorKind[]];

/**
 * The kinds whose settings hold an absolute path into the checkout, so `editor.rootPathKeys`
 * means something for them.
 *
 * The VS Code family, and nothing else. JetBrains has `$PROJECT_DIR$`, Zed's settings are
 * project-relative, and the rest sync nothing at all -- which is why the config's cross-check
 * asks "is there a kind that CONSUMES these keys" rather than "is an editor configured": with a
 * Zed-only hangar, `rootPathKeys` is exactly as inert as with no editor, and silently ignoring
 * it would be the same bug.
 */
export const KINDS_USING_ROOT_PATHS: readonly EditorKind[] = VSCODE_FORKS;

/**
 * Launcher name and window title per JetBrains product, as JetBrains Toolbox installs them.
 *
 * `fleet` is deliberately absent: Fleet is a different product with a different project model,
 * and guessing its semantics with nothing to test against is worse than not offering it.
 */
export const JETBRAINS_PRODUCTS = {
  idea: { launcher: 'idea', label: 'IntelliJ IDEA', app: 'IntelliJ IDEA' },
  webstorm: { launcher: 'webstorm', label: 'WebStorm', app: 'WebStorm' },
  pycharm: { launcher: 'pycharm', label: 'PyCharm', app: 'PyCharm' },
  phpstorm: { launcher: 'phpstorm', label: 'PhpStorm', app: 'PhpStorm' },
  goland: { launcher: 'goland', label: 'GoLand', app: 'GoLand' },
  rubymine: { launcher: 'rubymine', label: 'RubyMine', app: 'RubyMine' },
  clion: { launcher: 'clion', label: 'CLion', app: 'CLion' },
  rider: { launcher: 'rider', label: 'Rider', app: 'Rider' },
  datagrip: { launcher: 'datagrip', label: 'DataGrip', app: 'DataGrip' },
  rustrover: { launcher: 'rustrover', label: 'RustRover', app: 'RustRover' },
  aqua: { launcher: 'aqua', label: 'Aqua', app: 'Aqua' },
  'android-studio': { launcher: 'studio', label: 'Android Studio', app: 'Android Studio' },
} as const;

export type JetbrainsProduct = keyof typeof JETBRAINS_PRODUCTS;

export const JETBRAINS_PRODUCT_NAMES = Object.keys(JETBRAINS_PRODUCTS) as [
  JetbrainsProduct,
  ...JetbrainsProduct[],
];

/**
 * The vim binaries to try, richest integration first.
 *
 * MacVim and gVim are GUI applications with a `--remote-silent` client, which is what makes them
 * behave like every other editor here: a second invocation lands in the window that is already
 * open. Terminal vim has no such thing -- there is no window to send a file to -- so it is
 * handled by opening it in a terminal TAB instead, which is the only honest translation of "open
 * this clone in vim" for an editor that lives inside a terminal.
 */
export const VIM_GUI_BINARIES = ['mvim', 'gvim'] as const;
export const VIM_TERMINAL_BINARIES = ['nvim', 'vim'] as const;
