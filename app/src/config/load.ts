import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { CliError } from '../exec.ts';
import { tildify } from '../user-paths.ts';
import { hangarConfigSchema, type HangarConfig } from './schema.ts';

/** The marker file. Its presence is what makes a directory a hangar. */
export const CONFIG_FILENAME = 'hangar.config.yaml';

/**
 * The committed example beside it, documenting every key and every variant.
 *
 * A separate name and NOT a second marker: `isHangarRoot` tests `CONFIG_FILENAME` exactly, so
 * this file can sit in a hangar root without being mistaken for one. It matters because
 * `CONFIG_FILENAME` is normally gitignored -- it names one machine's paths, ports and token
 * variables -- which makes this the only committed record of a hangar's shape, and the fastest
 * way to recover a config that is missing.
 */
export const EXAMPLE_CONFIG_FILENAME = 'hangar.config.example.yaml';

/** How the hangar we are operating on was chosen -- reported by errors and by `doctor`. */
export type HangarSource = 'flag' | 'walk' | 'env';

export type HangarLocation = {
  readonly root: string;
  readonly configPath: string;
  readonly source: HangarSource;
};

/** The environment variable that names a hangar when the working directory is outside one. */
export const ROOT_ENV_KEY = 'HANGAR_ROOT';

const isHangarRoot = (dir: string): boolean => existsSync(join(dir, CONFIG_FILENAME));

/**
 * Walk up from `from` looking for the nearest marker.
 *
 * Nearest wins, which is the only rule that lets a hangar sit inside a larger workspace.
 * `/` is refused even with a marker on it -- that is a mistake, not a hangar.
 */
const walkUp = (from: string): string | undefined => {
  let dir = resolve(from);
  for (;;) {
    if (isHangarRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

/**
 * Is this directory the Hangar TOOL's own checkout rather than a hangar?
 *
 * The pre-refactor CLI derived its root from `import.meta.dirname/../..`, which was correct
 * only because the CLI lived two levels inside the hangar. Now that the tool has its own
 * repo, that expression would answer "the tool" -- so the tool's directory must never be a
 * candidate, and an absence needs an assertion or it comes back.
 */
const isToolCheckout = (dir: string): boolean => {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkg, 'utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { name?: unknown }).name === 'hangar'
    );
  } catch {
    return false;
  }
};

export type FindOptions = {
  readonly cwd: string;
  readonly flag?: string | undefined;
  readonly env?: string | undefined;
};

/**
 * Locate the hangar to act on. Precedence: `--hangar` > the upward walk > `HANGAR_ROOT`.
 *
 * The WALK SITS ABOVE THE ENVIRONMENT VARIABLE deliberately. The variable's appeal is
 * inheritance -- a subshell, or the headless `claude -p` that `sync` spawns, carries it down
 * -- and that inheritance is exactly the hazard: a shell holding `HANGAR_ROOT` for hangar A
 * while the working directory is inside hangar B would act on A, silently, on the wrong
 * repo's clones. Walk-first loses nothing, because wherever the variable was meant to help,
 * the working directory is inside that hangar and the walk agrees. When the working
 * directory is outside every hangar the walk finds nothing and the variable supplies the
 * answer, which is the only case where it is load-bearing.
 *
 * Takes `cwd` as a PARAMETER rather than calling `process.cwd()`, which is what makes
 * discovery testable at all.
 */
export const findHangar = (opts: FindOptions): HangarLocation | undefined => {
  const { cwd, flag, env } = opts;

  if (flag !== undefined && flag !== '') {
    const root = resolve(flag);
    return { root, configPath: join(root, CONFIG_FILENAME), source: 'flag' };
  }

  const walked = walkUp(cwd);
  if (walked !== undefined) {
    return { root: walked, configPath: join(walked, CONFIG_FILENAME), source: 'walk' };
  }

  if (env !== undefined && env !== '') {
    const root = resolve(env);
    return { root, configPath: join(root, CONFIG_FILENAME), source: 'env' };
  }

  return undefined;
};

/** Every ancestor marker above `root` -- an accidentally nested hangar, which `doctor` fails on. */
export const containingHangars = (root: string): string[] => {
  const found: string[] = [];
  let dir = dirname(resolve(root));
  for (;;) {
    if (isHangarRoot(dir)) found.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
};

/** Render every zod issue as one `path: message` line, sorted so output is stable. */
const formatIssues = (issues: readonly z.core.$ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.map((p) => String(p)).join('.');
      return `  ${path === '' ? '(root)' : path}: ${issue.message}`;
    })
    .sort((a, b) => a.localeCompare(b))
    .join('\n');

/**
 * Read, parse and validate one config file.
 *
 * Collects EVERY problem into a single error rather than stopping at the first. A new
 * hangar's first config will have three mistakes in it, and three round-trips is three
 * chances to give up.
 */
export const loadConfigFile = (configPath: string): HangarConfig => {
  if (!existsSync(configPath)) {
    throw new CliError(
      `no ${basename(configPath)} at ${tildify(dirname(configPath))}`,
      `Run \`hangar setup\` there to create one, or copy the committed example:\n` +
        `         cp ${EXAMPLE_CONFIG_FILENAME} ${CONFIG_FILENAME}`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new CliError(
      `${tildify(configPath)} is not valid YAML`,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (raw === null || raw === undefined) {
    throw new CliError(`${tildify(configPath)} is empty`, 'Run `hangar setup` to rewrite it.');
  }

  const result = hangarConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new CliError(
      `${tildify(configPath)} is not a valid hangar config`,
      `${String(result.error.issues.length)} problem(s):\n${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
};

export type LoadOptions = FindOptions & { readonly requireConfig?: boolean };

/**
 * Locate and load the hangar for this invocation, or throw with a message that says how it
 * looked. A malformed marker is a HARD ERROR at that root, never a reason to keep walking:
 * walking past it would find an outer hangar and act on it with the inner one's clones
 * underfoot.
 */
export const loadHangarConfig = (opts: LoadOptions): HangarLocation & { config: HangarConfig } => {
  const found = findHangar(opts);
  if (found === undefined) {
    const hint = isToolCheckout(walkUp(opts.cwd) ?? opts.cwd)
      ? `${tildify(opts.cwd)} is inside the Hangar tool's own repo, which is not a hangar.`
      : `Looked for ${CONFIG_FILENAME} in ${tildify(resolve(opts.cwd))} and every parent.`;
    throw new CliError(
      'not inside a hangar',
      `${hint}\nPass --hangar <path>, set ${ROOT_ENV_KEY}, or run \`hangar setup\` in a new hangar root.`,
    );
  }
  if (isToolCheckout(found.root)) {
    throw new CliError(
      `${tildify(found.root)} is the Hangar tool's own repo, not a hangar`,
      'Run from inside a hangar, or pass --hangar <path>.',
    );
  }
  return { ...found, config: loadConfigFile(found.configPath) };
};

/** The JSON Schema published for editors. Generated -- never hand-edited. */
export const jsonSchemaFileName = 'hangar.schema.json';
