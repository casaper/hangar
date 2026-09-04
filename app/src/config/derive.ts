import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { clonesSchema } from './schema.ts';
import { run } from '../exec.ts';
import { defaultBranchFromGit } from '../git.ts';

/**
 * Best-effort defaults for a hangar that already exists.
 *
 * `hangar setup` runs against a live hangar far more often than a bare directory -- this one
 * has four clones, three dev servers and an origin URL already -- so every answer it can
 * read off the disk is one the user does not have to retype, and one they cannot get wrong.
 *
 * Every field is a SUGGESTION. Nothing here writes, and the caller confirms each value.
 */

export type DerivedDefaults = {
  readonly id: string;
  readonly displayName: string | undefined;
  readonly originUrl: string | undefined;
  readonly defaultBranch: string | undefined;
  readonly appDir: string;
  readonly secretsFile: string | undefined;
  readonly hasVscodeWorkspaces: boolean;
  readonly installManager: string | undefined;
  readonly trackerBaseUrl: string | undefined;
  readonly trackerKeyPrefix: string | undefined;
  readonly envrcDirs: readonly string[];
  readonly rootPathKeys: Readonly<Record<string, string>>;
  readonly cloneCount: number;
};

/** Sanitise a directory name into a legal hangar id, or give up rather than mangle it. */
export const idFromDirName = (name: string): string | undefined => {
  const candidate = name
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return /^[a-z][a-z0-9_]{1,23}$/.test(candidate) ? candidate : undefined;
};

/** `git@host:workspace/repo.git` and `https://host/workspace/repo` both yield `repo`. */
export const repoNameFromOrigin = (url: string): string | undefined => {
  const tail = url
    .replace(/\.git$/, '')
    .split(/[:/]/)
    .pop();
  return tail === undefined || tail === '' ? undefined : tail;
};

/**
 * The subdirectory holding the app package, or '' for the repo root.
 *
 * A repo whose package lives one level down is common enough (and is this hangar's shape)
 * that guessing it saves a step; more importantly, `appDir` wrong means `install` runs in the
 * wrong directory, which is the kind of thing a suggestion-plus-confirmation catches.
 */
export const detectAppDir = (clonePath: string): string => {
  if (existsSync(join(clonePath, 'package.json'))) return '';
  let entries: string[];
  try {
    entries = readdirSync(clonePath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch {
    return '';
  }
  return entries.find((dir) => existsSync(join(clonePath, dir, 'package.json'))) ?? '';
};

/** Which package manager a checkout's lockfile implies. */
export const detectManager = (dir: string): string | undefined => {
  const lockfiles: readonly (readonly [string, string])[] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['poetry.lock', 'poetry'],
    ['uv.lock', 'uv'],
    ['Gemfile.lock', 'bundler'],
    ['Cargo.lock', 'cargo'],
    ['go.sum', 'go'],
    ['composer.lock', 'composer'],
    ['pom.xml', 'maven'],
  ];
  for (const [file, manager] of lockfiles) {
    if (existsSync(join(dir, file))) return manager;
  }
  return undefined;
};

/**
 * The issue-key prefix this repo actually uses, read off its branch names.
 *
 * Derived rather than asked, and derived rather than hardcoded: the prefix is the one tracker
 * value a repo demonstrates on every branch it has. Takes the most frequent match so a stray
 * `UTF-8` or `SHA-1` in one branch name cannot win, and returns undefined when there is no
 * clear answer rather than inventing one.
 */
export const detectKeyPrefix = (clonePath: string): string | undefined => {
  const res = run('git', ['-C', clonePath, 'branch', '-a', '--format=%(refname:short)']);
  if (!res.ok) return undefined;
  const counts = new Map<string, number>();
  for (const match of res.stdout.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-\d+/g)) {
    const prefix = match[1];
    if (prefix === undefined) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount) {
      best = prefix;
      bestCount = count;
    }
  }
  // One or two hits is noise, not a convention.
  return bestCount >= 3 ? best : undefined;
};

/**
 * The clone directories under a root, by path alone.
 *
 * Deliberately NOT `discoverClones`: this module runs during `hangar setup`, where there is no
 * config to read and therefore no `Hangar` to pass -- that is the whole situation setup exists
 * to end. All it needs is somewhere to ask git about an origin and a default branch, and a
 * directory name is enough for that.
 */
/**
 * The clone-directory pattern from the SCHEMA DEFAULTS, not from a config.
 *
 * `setup` runs where there is no config to read -- that is what it is for -- so a hangar's own
 * `clones.prefix`/`pad` are not available. The defaults are the right guess precisely because
 * they are what `setup` is about to write.
 */
const defaultCloneDirRe = (): RegExp => {
  const { prefix, pad } = clonesSchema.parse({});
  return new RegExp(`^${prefix}(\\d{${String(pad)},})$`);
};

const cloneDirsIn = (root: string): string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && defaultCloneDirRe().test(e.name))
      .map((e) => join(root, e.name))
      .sort();
  } catch {
    return [];
  }
};

/**
 * Every directory of a checkout that has an `.envrc`, root first.
 *
 * DISCOVERED, and this replaces a literal. `setup` wrote
 * `envrcDirs: ['.', '<appDir>', 'tests/playwright-regression-tests']` into every config it
 * produced -- this one repo's three directories -- and for a repo with no `package.json`
 * `detectAppDir` returns `''`, so it emitted `['.', '', 'tests/...']` and then REJECTED its own
 * file: `envrcDirs` is `z.array(z.string().min(1))`, so `loadConfigFile` at the end of setup threw
 * on the config setup had just written. The bug was only reachable for a foreign repo, which is
 * the only repo this command exists to serve.
 *
 * `git ls-files` because they are tracked, so it is exact and costs nothing. This is the same
 * question `add-clone`'s `direnvDirs` asks; the answer is written to config here so a hangar with
 * no clone yet still has one.
 */
export const detectEnvrcDirs = (clonePath: string): string[] => {
  const res = run('git', ['-C', clonePath, 'ls-files', '-z', '--', '*.envrc']);
  const dirs = new Set<string>(['.']);
  if (res.ok) {
    for (const file of res.stdout.split('\0')) {
      if (file.endsWith('.envrc')) dirs.add(dirname(file));
    }
  }
  return [...dirs].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
};

/**
 * The VS Code settings whose value is an absolute path into the checkout, and where each points.
 *
 * `editor.rootPathKeys` used to be eight stylelint / prettier / jestrunner / coverage keys under
 * `angular/`, written into every config `setup` produced. The consequence for another repo was not
 * a missing feature: with the wrong list `templatize` finds no checkout root, rewrites nothing, and
 * `hangar ide vscode sync` is a no-op that reports success.
 *
 * Read off a real settings file rather than guessed, because the whole list is observable: a value
 * that starts with the clone's own path IS a per-clone path, whatever extension put it there. The
 * recorded value is the clone-relative remainder, which is what `templatize` needs to find the
 * root again. Nothing is invented for a hangar with no clones -- an empty table is legal and means
 * "no setting here holds an absolute path into the checkout", which is true of most repos.
 *
 * JSONC, so it is scanned as TEXT: comments and trailing commas do not survive `JSON.parse`, and
 * the same regex reads a single-element array (`coverage-gutters.manualCoverageFilePaths` puts its
 * one path on the line after the key) as a plain string.
 */
export const detectRootPathKeys = (clonePath: string): Record<string, string> => {
  let text: string;
  try {
    text = readFileSync(join(clonePath, '.vscode', 'settings.json'), 'utf8');
  } catch {
    return {};
  }
  const found: Record<string, string> = {};
  const re = new RegExp(
    `"([^"\\n]+)"\\s*:\\s*(?:\\[\\s*)?"${escapeRegExp(clonePath)}/([^"]*)"`,
    'g',
  );
  for (const match of text.matchAll(re)) {
    const key = match[1];
    const rest = match[2];
    if (key === undefined || rest === undefined) continue;
    found[key] = rest;
  }
  return found;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const deriveDefaults = (hangarRoot: string): DerivedDefaults => {
  const clones = cloneDirsIn(hangarRoot).map((path) => ({ path }));
  const first = clones[0];

  const originUrl =
    first === undefined
      ? undefined
      : (() => {
          const res = run('git', ['-C', first.path, 'remote', 'get-url', 'origin']);
          const url = res.stdout.trim();
          return res.ok && url !== '' ? url : undefined;
        })();

  /*
   * The same function every command asks, so `setup` cannot suggest one branch while the CLI
   * would resolve another. Absent, the suggestion is left EMPTY rather than filled with
   * `master`, and the first command that needs it detects and records it -- so a blank answer
   * here costs nothing.
   */
  const defaultBranch = first === undefined ? undefined : defaultBranchFromGit(first.path);

  const appDir = first === undefined ? '' : detectAppDir(first.path);

  return {
    id: idFromDirName(basename(hangarRoot)) ?? 'hangar',
    displayName: originUrl === undefined ? undefined : repoNameFromOrigin(originUrl),
    originUrl,
    defaultBranch,
    appDir,
    secretsFile: existsSync(join(hangarRoot, '.env.shared')) ? '.env.shared' : undefined,
    hasVscodeWorkspaces:
      first !== undefined &&
      readdirSync(first.path).some((entry) => entry.endsWith('.code-workspace')),
    installManager:
      first === undefined
        ? undefined
        : detectManager(join(first.path, appDir === '' ? '.' : appDir)),
    /*
     * NOT suggested. It used to be `atlassianUrl`, this fleet's own Jira, offered as the default
     * to every hangar setup ever ran -- and accepted by `--yes` without a human seeing it, which
     * put one organisation's tracker URL into another's config. A tracker base URL is not
     * observable from a checkout: the issue keys in the branch names are (see `detectKeyPrefix`),
     * the host they live on is not.
     */
    trackerBaseUrl: undefined,
    trackerKeyPrefix: first === undefined ? undefined : detectKeyPrefix(first.path),
    envrcDirs: first === undefined ? ['.'] : detectEnvrcDirs(first.path),
    rootPathKeys: first === undefined ? {} : detectRootPathKeys(first.path),
    cloneCount: clones.length,
  };
};

/**
 * The port roles `setup` suggests, which is now NONE.
 *
 * It used to render the three hardcoded roles of this one repo -- an Angular dev server, a
 * Storybook and a Playwright report -- into every config it wrote, which is why `setup` could
 * not describe a repo that serves anything else. There is nothing left to derive: a role is a
 * decision about the repo (what it runs, on which port, under which env var), and no amount of
 * looking at a checkout answers it.
 *
 * So the template writes an empty `roles: []`, which the schema accepts -- a hangar that manages
 * no ports is legal -- and F7 is where `setup` learns to ASK. Returning an empty list rather
 * than deleting the function keeps that seam in one place.
 */
export const derivedPortRoles = (): readonly {
  id: string;
  envKey: string;
  base: number;
  label: string;
}[] => [];

/**
 * The spacing `setup` suggests between clones.
 *
 * A plain default rather than a reading of anything: 100 leaves room for a role's own port range
 * (a dev server that also opens an HMR socket, say) while keeping four clones inside one
 * thousand. `hangar-internals/reference/config.md` records why it must match across hangars for
 * the offset guarantee to hold.
 */
export const DEFAULT_PORT_STEP = 100;

export const derivedPortStep = (): number => DEFAULT_PORT_STEP;
