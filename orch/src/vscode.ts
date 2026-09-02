import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workspaceAngularPath, workspacePath } from './clone-config.ts';
import { CliError } from './exec.ts';
import type { Clone } from './fleet.ts';
import { fleetRoot, vscodeWindowState } from './paths.ts';

/**
 * The VS Code side of a clone: `.vscode/*` plus the two `*.code-workspace` copies.
 *
 * None of it can be shared by a symlink or by a setting, because a handful of VS Code
 * settings take an ABSOLUTE path to a tool or config inside the checkout --
 * `stylelint.stylelintPath`, `prettier.prettierPath`, `jestrunner.projectPath`,
 * `coverage-gutters.manualCoverageFilePaths` -- and VS Code resolves them against nothing.
 * Those values must differ per clone; every other key should be identical. That shape is
 * the whole problem, and the reason this is a text transform rather than a copy:
 *
 *   1. discover the checkout root the SOURCE file's path settings point at,
 *   2. replace it with a token, giving a clone-neutral template,
 *   3. render the template with each target clone's own root.
 *
 * Text, not JSON. Both `settings.json` and the `.code-workspace` files are JSONC -- comments
 * and trailing commas, neither of which survives `JSON.parse` -- and reserialising would
 * additionally lose the key order and the tab indentation maintained by hand.
 */

const ROOT_TOKEN = '__HANGAR_CLONE_ROOT__';
const INDEX_TOKEN = '__HANGAR_CLONE_INDEX__';

/**
 * The settings whose value is an absolute path INTO the clone, mapped to the path each one
 * must point at relative to the clone root.
 *
 * Declared rather than sniffed on purpose. A generic "rewrite anything that looks like a
 * checkout path" rule would eventually rewrite a genuinely machine-global path (the
 * `~/.vscode/extensions/...` YAML schema URL in the workspace file is one), and a settings
 * key silently pointed at the wrong tree is the same class of failure as a Storybook health
 * check pointed at a sibling's port: it does not error, it just verifies the wrong code.
 *
 * `jestrunner.configPath` is deliberately absent -- it is already relative
 * (`angular/jest.config.ts`), so it is shared, not per clone.
 */
const SETTINGS_ROOT_KEYS: Readonly<Record<string, string>> = {
  'stylelint.configBasedir': 'angular',
  'stylelint.configFile': 'angular/stylelint.config.mjs',
  'stylelint.stylelintPath': 'angular/node_modules/stylelint',
  'jestrunner.projectPath': 'angular',
  'coverage-gutters.manualCoverageFilePaths': 'angular/coverage/lcov.info',
  'prettier.configPath': 'angular/.prettierrc',
  'prettier.prettierPath': 'angular/node_modules/prettier',
  'storyExplorer.server.internal.npm.dir': 'angular',
};

/** A workspace file names the clone root itself, as the one folder it opens. */
const WORKSPACE_ROOT_KEYS: Readonly<Record<string, string>> = { path: '' };

export type VscodeArtifact = {
  readonly id: string;
  /**
   * Whether git already versions this file. A tracked file is NOT ours to write: it belongs
   * to whatever branch the clone has checked out, and rewriting it dirties that branch and
   * can end up committed. Compared and reported, written only with `--include-tracked`.
   */
  readonly tracked: boolean;
  /** Every copy of this file in a clone. They are byte-identical; the first is canonical. */
  readonly copies: (clone: Clone) => readonly string[];
  /** Setting key -> the path, relative to the clone root, its absolute value must point at. */
  readonly rootKeys: Readonly<Record<string, string>>;
  /** Whether the file carries the `"<index>: dvb_gn"` workspace folder label. */
  readonly indexLabel: boolean;
};

const vscodeFile = (clone: Clone, name: string): string => join(clone.path, '.vscode', name);

export const VSCODE_ARTIFACTS: readonly VscodeArtifact[] = [
  {
    id: '.vscode/settings.json',
    tracked: false,
    copies: (clone) => [vscodeFile(clone, 'settings.json')],
    rootKeys: SETTINGS_ROOT_KEYS,
    indexLabel: false,
  },
  {
    id: '.vscode/mcp.json',
    tracked: false,
    copies: (clone) => [vscodeFile(clone, 'mcp.json')],
    rootKeys: {},
    indexLabel: false,
  },
  {
    id: '.vscode/launch.json',
    tracked: true,
    copies: (clone) => [vscodeFile(clone, 'launch.json')],
    rootKeys: {},
    indexLabel: false,
  },
  {
    id: '.vscode/tasks.json',
    tracked: true,
    copies: (clone) => [vscodeFile(clone, 'tasks.json')],
    rootKeys: {},
    indexLabel: false,
  },
  {
    // Two copies, because VS Code offers `*.code-workspace` files from the directory you
    // open, and this repo is opened both at its root and at `angular/`.
    id: '*.code-workspace',
    tracked: false,
    copies: (clone) => [workspacePath(clone), workspaceAngularPath(clone)],
    rootKeys: WORKSPACE_ROOT_KEYS,
    indexLabel: true,
  },
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find a setting's string value in JSONC text.
 *
 * The optional `[` arm is what makes `coverage-gutters.manualCoverageFilePaths` work: its one
 * element sits on the line after the key, and `\s` spans newlines, so the same expression
 * reads both a plain string and a single-element array without parsing the file.
 */
const readStringValue = (text: string, key: string): string | undefined => {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(?:\\[\\s*)?"([^"]*)"`).exec(text);
  return match?.[1];
};

const INDEX_LABEL_RE = /("name"\s*:\s*")(\d+)(: dvb_gn")/;

export type Templatized = {
  readonly template: string;
  /** The checkout root the source file's path settings pointed at, if it had any. */
  readonly root: string | undefined;
  /** Keys present but not pointing where they should -- reported, never silently rewritten. */
  readonly nonconforming: readonly string[];
};

/**
 * Turn one clone's file into a clone-neutral template.
 *
 * The root is DISCOVERED from the declared keys (value minus its declared suffix) rather than
 * assumed to be the source clone's own path -- which matters here, because every clone's
 * settings currently point at `~/code/storefront_ui` or `~/code/separate_clone_storefront_ui`,
 * two directories that no longer exist. Rendering therefore repairs those paths as a side
 * effect of syncing, and is idempotent afterwards.
 */
export const templatize = (artifact: VscodeArtifact, text: string, clone: Clone): Templatized => {
  const roots = new Map<string, string[]>();
  const nonconforming: string[] = [];

  for (const [key, suffix] of Object.entries(artifact.rootKeys)) {
    const value = readStringValue(text, key);
    if (value === undefined) continue;
    if (!value.startsWith('/')) {
      nonconforming.push(`${key} is relative (${value}) — left alone`);
      continue;
    }
    const tail = suffix === '' ? '' : `/${suffix}`;
    if (tail !== '' && !value.endsWith(tail)) {
      nonconforming.push(`${key} does not end in ${suffix} (${value}) — left alone`);
      continue;
    }
    const root = value.slice(0, value.length - tail.length);
    roots.set(root, [...(roots.get(root) ?? []), key]);
  }

  if (roots.size > 1) {
    const detail = [...roots]
      .map(([root, keys]) => `${root} (${keys.join(', ')})`)
      .join('\n       vs ');
    throw new CliError(
      `${clone.name}'s ${artifact.id} points at ${roots.size} different checkouts`,
      `Make them agree before syncing, so there is no doubt which one is the clone root:\n       ${detail}`,
    );
  }

  const root = [...roots.keys()][0];
  let template = text;
  if (root !== undefined) {
    // Anchored on a following `/` or `"` so a root that is a prefix of a longer directory
    // name (`/x/repo` vs `/x/repo_old/...`) cannot be corrupted.
    template = template.replace(new RegExp(`${escapeRegExp(root)}(?=[/"])`, 'g'), ROOT_TOKEN);
  }
  if (artifact.indexLabel) {
    template = template.replace(INDEX_LABEL_RE, `$1${INDEX_TOKEN}$3`);
  }
  return { template, root, nonconforming };
};

/** The template as this clone should have it. */
export const render = (template: string, clone: Clone): string =>
  template.replaceAll(ROOT_TOKEN, clone.path).replaceAll(INDEX_TOKEN, String(clone.index));

/** Fresh each call: a global regex carries `lastIndex`, so a shared one would skip matches. */
const cloneRootRe = (): RegExp => new RegExp(`${escapeRegExp(fleetRoot)}/clone_(\\d{2,})`, 'g');

/**
 * Any absolute path into a SIBLING clone that survived rendering.
 *
 * This is the guard the whole command exists for: a clone-specific setting that is not in
 * the declared table gets copied verbatim, and a stylelint or prettier path aimed at
 * another clone's `node_modules` fails silently rather than loudly. Paths outside the fleet
 * root are left alone -- the YAML schema URL under `~/.vscode/extensions/` is genuinely
 * shared by every clone.
 */
export const foreignClonePaths = (text: string, clone: Clone): string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(cloneRootRe())) {
    const index = Number.parseInt(match[1] ?? '', 10);
    if (index !== clone.index) found.add(match[0]);
  }
  return [...found];
};

/**
 * The setting keys whose lines differ, for a readable "what would change" line.
 *
 * Position-aligned, so an added or removed key shifts everything after it and over-reports.
 * That is why the caller falls back to a line count when the two files are different
 * lengths: over-reporting a rewrite is fine, claiming a file is in sync when it is not is
 * not.
 */
export const changedKeys = (before: string, after: string): string[] => {
  const b = before.split('\n');
  const a = after.split('\n');
  const keys = new Set<string>();
  let enclosing: string | undefined;
  for (let i = 0; i < Math.max(b.length, a.length); i += 1) {
    const key = /"([^"]+)"\s*:/.exec(a[i] ?? '')?.[1];
    if (key !== undefined) enclosing = key;
    if (b[i] === a[i]) continue;
    // A changed line with no key of its own is an array element -- the one path setting held
    // in an array (`coverage-gutters.manualCoverageFilePaths`) would otherwise go unreported.
    const named = [b[i], a[i]]
      .map((line) => /"([^"]+)"\s*:/.exec(line ?? '')?.[1])
      .filter((k): k is string => k !== undefined);
    if (named.length === 0 && enclosing !== undefined) keys.add(enclosing);
    for (const k of named) keys.add(k);
  }
  return [...keys];
};

export type CopyState = {
  readonly path: string;
  readonly clone: Clone;
  readonly text: string | undefined;
  readonly mtimeMs: number;
};

export const readCopy = (clone: Clone, path: string): CopyState => {
  if (!existsSync(path)) return { path, clone, text: undefined, mtimeMs: 0 };
  return {
    path,
    clone,
    text: readFileSync(path, 'utf8'),
    mtimeMs: statSync(path).mtimeMs,
  };
};

/**
 * Which copy to sync FROM: the most recently modified one that exists.
 *
 * Not a fixed clone. The fleet has no primary -- every clone is equal in rank and any of
 * them may be the one the user just edited -- so newest-wins, printed, and overridable with
 * `--from`.
 */
export const pickSource = (copies: readonly CopyState[]): CopyState | undefined =>
  copies
    .filter((c) => c.text !== undefined)
    .reduce<CopyState | undefined>(
      (best, c) => (best === undefined || c.mtimeMs > best.mtimeMs ? c : best),
      undefined,
    );

export const writeCopy = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
};

/**
 * Which of the clone's two workspace files VS Code already has open, if either.
 *
 * The point is to hand `code` the copy it is ALREADY showing. VS Code identifies a workspace
 * by its config file's URI, so the clone's two byte-identical twins -- `dvb_gn_NN.code-workspace`
 * at the clone root and the one in `angular/` -- are two different workspaces to it: passing
 * the root copy while the developer has the `angular/` copy open opens a SECOND window on
 * identical content, which is exactly the duplicate this avoids. Passing the same path it
 * already has open makes `code` focus that window instead.
 *
 * The state file is last-known, not live, so a stale entry only means the workspace is opened
 * rather than focused -- which is what would have happened anyway. Nothing here fails loudly:
 * an unreadable or unfamiliar file just means "no opinion", and the caller falls back to the
 * root copy.
 */
export const openWorkspaceFile = (clone: Clone): string | undefined => {
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(vscodeWindowState, 'utf8'));
  } catch {
    return undefined;
  }
  const windows = windowStates(state);
  const twins = [workspacePath(clone), workspaceAngularPath(clone)];
  for (const window of windows) {
    const path = configPath(window);
    if (path !== undefined && twins.includes(path)) return path;
  }
  return undefined;
};

/** `lastActiveWindow` plus `openedWindows` -- a single window lives in the former alone. */
const windowStates = (state: unknown): unknown[] => {
  if (typeof state !== 'object' || state === null) return [];
  const windowsState = (state as Record<string, unknown>)['windowsState'];
  if (typeof windowsState !== 'object' || windowsState === null) return [];
  const record = windowsState as Record<string, unknown>;
  const opened: unknown = record['openedWindows'];
  const rest: unknown[] = Array.isArray(opened) ? opened : [];
  return [record['lastActiveWindow'], ...rest];
};

/** `{workspaceIdentifier: {configURIPath: "file:///..."}}` -> a filesystem path. */
const configPath = (window: unknown): string | undefined => {
  if (typeof window !== 'object' || window === null) return undefined;
  const identifier = (window as Record<string, unknown>)['workspaceIdentifier'];
  if (typeof identifier !== 'object' || identifier === null) return undefined;
  const uri = (identifier as Record<string, unknown>)['configURIPath'];
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
};
