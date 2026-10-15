import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cloneTokens,
  workspaceCloneValues,
  workspacePath,
  workspacePaths,
} from '../clone-config.ts';
import { CliError, run } from '../exec.ts';
import { cloneDirPattern, type Clone } from '../fleet.ts';
import { git } from '../git.ts';
import { render as renderTemplate } from '../template.ts';
import { platform } from '../platform/index.ts';
import { VSCODE_FAMILY, type VscodeFork } from './kinds.ts';
import type { EditorArtifact, EditorDriver, LaunchResult } from './types.ts';
import type { Hangar } from '../hangar.ts';

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
const INDEX2_TOKEN = '__HANGAR_CLONE_INDEX2__';
/**
 * One token per per-clone SETTING, named after the setting.
 *
 * A third token rather than a third literal: the keys come from `workspaceCloneValues`, so this
 * side of the transform cannot list a key the builder has dropped or miss one it has gained.
 */
const cloneValueToken = (key: string): string => `__HANGAR_CLONE_VALUE_${key}__`;

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
/*
 * The key list comes from `editor.rootPathKeys` in the config now, and it had to.
 *
 * It was hardcoded here as eight stylelint / prettier / jestrunner / coverage paths under
 * `angular/`, while `editor.rootPathKeys` sat in the schema and was read by NOTHING -- the
 * comment in `editor/kinds.ts` describing it as configuration was simply wrong. The consequence
 * was not a missing feature: with the wrong list, `templatize` finds no checkout root in another
 * repo's settings, templatizes nothing, and `hangar ide vscode sync` becomes a no-op that
 * reports success.
 *
 * An EMPTY table is legal and means "no setting here holds an absolute path into the checkout",
 * which is true of most repos. `doctor` says so rather than leaving it to be discovered.
 */

/** A workspace file names the clone root itself, as the one folder it opens. */
const WORKSPACE_ROOT_KEYS: Readonly<Record<string, string>> = { path: '' };

const vscodeFile = (clone: Clone, name: string): string => join(clone.path, '.vscode', name);

export const vscodeArtifacts = (
  rootPathKeys: Readonly<Record<string, string>>,
): readonly EditorArtifact[] => [
  {
    id: '.vscode/settings.json',
    tracked: false,
    copies: (clone) => [vscodeFile(clone, 'settings.json')],
    rootKeys: rootPathKeys,
    indexLabel: false,
    cloneValues: false,
  },
  {
    id: '.vscode/mcp.json',
    tracked: false,
    copies: (clone) => [vscodeFile(clone, 'mcp.json')],
    rootKeys: {},
    indexLabel: false,
    cloneValues: false,
  },
  {
    id: '.vscode/launch.json',
    tracked: true,
    copies: (clone) => [vscodeFile(clone, 'launch.json')],
    rootKeys: {},
    indexLabel: false,
    cloneValues: false,
  },
  {
    id: '.vscode/tasks.json',
    tracked: true,
    copies: (clone) => [vscodeFile(clone, 'tasks.json')],
    rootKeys: {},
    indexLabel: false,
    cloneValues: false,
  },
  {
    // Two copies, because VS Code offers `*.code-workspace` files from the directory you
    // open, and this repo is opened both at its root and at `angular/`.
    id: '*.code-workspace',
    tracked: false,
    copies: (clone) => workspacePaths(clone),
    rootKeys: WORKSPACE_ROOT_KEYS,
    indexLabel: true,
    cloneValues: true,
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

/*
 * The workspace folder label, read BACKWARDS.
 *
 * This is the one direction the token renderer cannot serve: `templatize` has a rendered label
 * in hand (`"name": "1: dvb_gn"`) and has to find the index inside it. It was the literal
 * `/("name"\s*:\s*")(\d+)(: dvb_gn")/` -- so in any other hangar it matched nothing, the label
 * was copied verbatim, and every clone's workspace claimed to be clone 1 while `ide vscode sync`
 * reported success.
 *
 * Derived from `editor.workspaceFolderLabel` rather than merely replaced, so the two directions
 * cannot disagree: the template is rendered with a sentinel where the index goes, escaped whole,
 * and the sentinel becomes the capture group. A label that does not mention the index at all is
 * not per-clone, so there is nothing to find and nothing to rewrite.
 *
 * **Which token it returns is decided by which one the label asked for.** `{index2}` is the
 * PADDED index, and a label using it (`acme clone 0003`) rendered back through a bare
 * `String(clone.index)` becomes `acme clone 3` -- a label silently rewritten by a command
 * reporting a successful sync, in every hangar whose `clones.pad` matters. A label naming both
 * takes the padded form: the two cannot be told apart by one capture group, and losing the
 * padding is the damaging direction.
 */
const INDEX_SENTINEL = '\u0001HANGARINDEX\u0001';

const indexLabelRe = (hangar: Hangar): { re: RegExp; token: string } | undefined => {
  const template = hangar.config.editor.workspaceFolderLabel;
  if (!template.includes('{index}') && !template.includes('{index2}')) return undefined;
  const token = template.includes('{index2}') ? INDEX2_TOKEN : INDEX_TOKEN;
  const rendered = renderTemplate(
    template,
    {
      id: hangar.id,
      displayName: hangar.config.displayName ?? hangar.id,
      index: INDEX_SENTINEL,
      index2: INDEX_SENTINEL,
    },
    'editor.workspaceFolderLabel',
  );
  const [before = '', after = ''] = escapeRegExp(rendered).split(INDEX_SENTINEL);
  return { re: new RegExp(`("name"\\s*:\\s*"${before})(\\d+)(${after}")`), token };
};

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
 * settings can still point at the directory the file was first written in, or at a sibling,
 * two directories that no longer exist. Rendering therefore repairs those paths as a side
 * effect of syncing, and is idempotent afterwards.
 */
export const templatize = (artifact: EditorArtifact, text: string, clone: Clone): Templatized => {
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
    const label = indexLabelRe(clone.hangar);
    if (label !== undefined) template = template.replace(label.re, `$1${label.token}$3`);
  }
  if (artifact.cloneValues) {
    /*
     * Positional, by KEY, and never by value: replacing every `#000000` in the file would reach
     * a colour the developer put there themselves, and `ink` is `#000000` for most of the
     * palette. Anchoring on the quoted key is also what makes this work at any nesting depth --
     * `workbench.colorCustomizations`' own entries are `"titleBar.activeBackground": "…"` in the
     * text like any other setting.
     */
    for (const key of Object.keys(workspaceCloneValues(clone))) {
      const at = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*")([^"]*)(")`);
      template = template.replace(at, `$1${cloneValueToken(key)}$3`);
    }
  }
  return { template, root, nonconforming };
};

/** The template as this clone should have it. */
export const render = (template: string, clone: Clone): string => {
  const tokens = cloneTokens(clone);
  let text = template
    .replaceAll(ROOT_TOKEN, clone.path)
    .replaceAll(INDEX2_TOKEN, tokens.index2 ?? String(clone.index))
    .replaceAll(INDEX_TOKEN, String(clone.index));
  // From the builder rather than from whatever the source clone had, so a sync REPAIRS a
  // workspace file that was copied between clones instead of propagating one clone's identity.
  for (const [key, value] of Object.entries(workspaceCloneValues(clone))) {
    text = text.replaceAll(cloneValueToken(key), value);
  }
  return text;
};

/**
 * Fresh each call: a global regex carries `lastIndex`, so a shared one would skip matches.
 *
 * The directory pattern comes from `fleet.ts`'s one derivation, not from a second `clone_(\d{2,})`
 * written here -- a hangar whose clones are `wt-001` would otherwise have this guard find no
 * sibling paths at all, which is the guard silently switching itself off.
 */
const cloneRootRe = (hangar: Hangar): RegExp =>
  new RegExp(`${escapeRegExp(hangar.root)}/${cloneDirPattern(hangar)}`, 'g');

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
  for (const match of text.matchAll(cloneRootRe(clone.hangar))) {
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
export const openWorkspaceFile = (clone: Clone, stateDir = 'Code'): string | undefined => {
  // A platform that does not know where this file lives says so, rather than handing back a
  // path under someone else's `~/Library`: an unreadable file and an unlocatable one both mean
  // "no opinion" here, but only one of them is a bug worth being able to see.
  const statePath = platform().vscodeWindowState(stateDir);
  if (statePath === undefined) return undefined;
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return undefined;
  }
  const windows = windowStates(state);
  const twins = workspacePaths(clone);
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

/**
 * Whether git versions this copy, taking the DECLARED flag as a floor.
 *
 * `declared || inGit`, never `inGit` alone. A purely dynamic test would make the protection
 * conditional on the checked-out branch: a branch that happens not to track `launch.json` would
 * make it writable, and `ide vscode sync` would then push one branch's copy into a sibling -- the
 * exact failure the declared flag exists to prevent. Git can only ADD protection, which is what
 * catches a file this table calls untracked because it is gitignored HERE while some other
 * project tracks it (`.idea/` is precisely that file).
 *
 * `git ls-files --error-unmatch` is the question asked of the index rather than of `.gitignore`,
 * so a file that is merely ignored does not count -- and a failure to ask (not a repo, git
 * missing) leaves the declared answer standing rather than inventing one.
 */
export const isTracked = (artifact: EditorArtifact, clone: Clone, path: string): boolean => {
  if (artifact.tracked) return true;
  const rel = relative(clone.path, path);
  if (rel.startsWith('..')) return false;
  return git(clone.path, ['ls-files', '--error-unmatch', '--', rel]).ok;
};

/**
 * VS Code, the default editor and the one that needs the most done for it.
 *
 * `focusExisting` is true because of the `.code-workspace` twins: VS Code identifies a workspace
 * by its config file's URI, so handing it the root copy while the developer has the `angular/`
 * copy open produces a second window on identical content. `rewritesRootPaths` is true because a
 * handful of its settings hold an absolute path into the checkout -- see the header.
 */
/**
 * One driver for the whole VS Code family: VS Code itself, Cursor, Windsurf, VSCodium and the
 * rest. They differ in exactly two values -- the launcher binary and which directory holds their
 * window-state file -- so a fork costs one row in `VSCODE_FAMILY` rather than a driver.
 *
 * The state directory is the half that matters. The point of reading that file is to hand the
 * editor the exact `*.code-workspace` copy it ALREADY has open; read a sibling fork's state file
 * and the answer is not stale but about another application's windows, which is precisely how you
 * open a second window on identical content while believing you avoided one.
 */
export const vscodeDriver = (
  fork: VscodeFork = 'vscode',
  rootPathKeys: Readonly<Record<string, string>> = {},
): EditorDriver => {
  const { binary, label, stateDir, app } = VSCODE_FAMILY[fork];
  return {
    kind: fork,
    label,
    capabilities: {
      launch: true,
      focusExisting: true,
      syncArtifacts: true,
      rewritesRootPaths: true,
      closeWindow: platform().capabilities.controlAppWindows,
    },
    isAvailable: () => run('sh', ['-c', `command -v ${binary} >/dev/null 2>&1`]).ok,
    unavailableHint: () =>
      `the \`${binary}\` command is not on PATH — in ${label}, run “Shell Command: Install '${binary}' command in PATH”.`,
    launch: (clone) => launchVscode(binary, label, stateDir, clone),
    /*
     * By the clone's NAME, because the generated workspace file puts it at the front of
     * `window.title` -- so a window can be named from outside without asking the editor
     * anything. The window-state file could name the workspace path instead, and does not help:
     * it says which workspace a window HAS, not what that window is CALLED, and System Events
     * only offers the title.
     *
     * The cost of that is worth stating: a clone whose workspace file predates the generated
     * `window.title` has whatever title the developer's own setting produces, and this returns
     * `no-window` for it. `doctor --fix` is what puts the title in place, and `no-window` is a
     * named outcome rather than a silent miss precisely so that case reads as itself.
     */
    closeWindow: (clone) => platform().closeAppWindow(app, clone.name),
    artifacts: vscodeArtifacts(rootPathKeys),
  };
};

/**
 * Hand the clone's workspace to VS Code, reusing the window that already has it open.
 *
 * The path matters twice over. The workspace file lives at the CLONE ROOT, so
 * `code *.code-workspace` from `angular/` would match nothing -- hence the full path. And the
 * clone carries that file twice; `openWorkspaceFile` asks VS Code which copy it is already
 * showing and that exact path is what gets passed, which is what makes it focus the existing
 * window instead of opening a second one on identical content.
 */
const launchVscode = (
  binary: string,
  label: string,
  stateDir: string,
  clone: Clone,
): LaunchResult | undefined => {
  const alreadyOpen = openWorkspaceFile(clone, stateDir);
  const workspace = alreadyOpen ?? workspacePath(clone);
  if (!existsSync(workspace)) {
    return {
      target: workspace,
      reused: false,
      note: `no workspace file at ${workspace} — run \`hangar doctor --fix\` to create it`,
    };
  }
  const res = run(binary, [workspace]);
  if (!res.ok) {
    return {
      target: workspace,
      reused: false,
      note: `could not launch ${label}: ${res.stderr.trim() || `is the \`${binary}\` command installed?`}`,
    };
  }
  return { target: workspace, reused: alreadyOpen !== undefined };
};
