import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { CliError } from '../exec.ts';
import { claudeDir, tildify } from '../user-paths.ts';
import { pathsFor, type Hangar } from '../hangar.ts';
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

  return parseConfigText(readFileSync(configPath, 'utf8'), tildify(configPath));
};

/**
 * The parse-and-validate half of `loadConfigFile`, over TEXT rather than a path.
 *
 * Split out so `hangar setup -n` can validate the config it has rendered without writing it
 * anywhere. That was the gap the `envrcDirs: ['.', '', ...]` bug lived in: the dry run returned
 * before the only parse in the command, so the one invocation that could have caught a config
 * setup cannot load was the one that skipped the check.
 *
 * `what` names the source in every message, because "not a valid hangar config" about a file on
 * disk and about a render in memory need different follow-up actions.
 */
export const parseConfigText = (text: string, what: string): HangarConfig => {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new CliError(
      `${what} is not valid YAML`,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (raw === null || raw === undefined) {
    throw new CliError(`${what} is empty`, 'Run `hangar setup` to rewrite it.');
  }

  const result = hangarConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new CliError(
      `${what} is not a valid hangar config`,
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
    throw new CliError(
      'not inside a hangar',
      `Looked for ${CONFIG_FILENAME} in ${tildify(resolve(opts.cwd))} and every parent.\n` +
        `Run \`hangar setup\` here to make this directory a hangar, or pass --hangar <path>\n` +
        `or set ${ROOT_ENV_KEY} to act on an existing one.`,
    );
  }
  return { ...found, config: loadConfigFile(found.configPath) };
};

/**
 * The hangar this invocation acts on: location, config, and every path derived from the root.
 *
 * There USED to be a guard here refusing a candidate whose `package.json` named the tool, on the
 * reasoning that the tool's own checkout must never be mistaken for a hangar. That guard is gone,
 * and deliberately: Hangar is distributed by publishing this repository, so a clone of it IS the
 * hangar root -- `app/package.json` is named `hangar`, and the guard's message told anyone
 * running the CLI from `app/` before setup that they were "inside the Hangar tool's own repo,
 * which is not a hangar", when `hangar setup` one directory up was exactly the right answer.
 * The discriminator between a tool checkout and a hangar was always `hangar.config.yaml`, which
 * is the marker the walk already looks for.
 */
export const loadHangar = (opts: LoadOptions): Hangar => {
  const { root, source, config } = loadHangarConfig(opts);
  return Object.freeze({
    root,
    id: config.id,
    config,
    source,
    paths: pathsFor(root, config.id, config.secrets.file, claudeDir),
    configFellBack: false,
  });
};

/**
 * A legal id derived from a directory name, or a last resort.
 *
 * Only reached when the config will not parse, so there is no configured id to use and the
 * directory name is the best remaining evidence of which hangar this is.
 */
const idFromRoot = (root: string): string => {
  const cleaned = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 24);
  return cleaned.length >= 2 ? cleaned : 'hangar';
};

/**
 * The hangar, with an unparseable config downgraded to schema defaults instead of an error.
 *
 * For the three commands whose whole job is to report on the config -- `doctor`, `config show`,
 * `config validate`. `hangar-internals/reference/config.md` states the rule this preserves:
 * ABSENCE is a gate, INVALIDITY is a report, and a gate that parsed the file would stop the
 * only commands able to explain it.
 *
 * Every other command gets `loadHangar` and refuses.
 */
export const loadHangarTolerant = (opts: LoadOptions): Hangar => {
  const found = findHangar(opts);
  if (found === undefined) return loadHangar(opts); // no hangar at all: same error as everyone
  try {
    return loadHangar(opts);
  } catch (error) {
    const config = hangarConfigSchema.parse({
      id: idFromRoot(found.root),
      forge: { originUrl: 'unknown' },
      ports: { roles: [] },
    });
    return Object.freeze({
      root: found.root,
      id: config.id,
      config,
      source: found.source,
      paths: pathsFor(found.root, config.id, config.secrets.file, claudeDir),
      configFellBack: true,
      configError: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * The same, but `undefined` instead of a throw.
 *
 * Exists for `jira hook` alone, whose `PreToolUse` contract is fail-open: a non-zero exit there
 * blocks the tool call it was only meant to accelerate, so every failure it can have -- no
 * hangar, an unparseable config -- has to end in exit 0 and silence.
 */
export const tryLoadHangar = (opts: LoadOptions): Hangar | undefined => {
  try {
    return loadHangar(opts);
  } catch {
    return undefined;
  }
};

/** The JSON Schema published for editors. Generated -- never hand-edited. */
export const jsonSchemaFileName = 'hangar.schema.json';
