import type { CommandUnknownOpts, Option } from '@commander-js/extra-typings';

import { CliError } from '../exec.ts';

/**
 * Which `hangar` commands operator mode may reach as MCP tools, and how each one is spelled.
 *
 * ## Why a table and not the commander registry alone
 *
 * `cli.ts` already carries every command's description, its arguments, its options and its
 * `.choices()`, and all of that is read straight off the registry rather than repeated here --
 * the same one-table-two-consumers shape `barOptions` and `SYNCABLE` use. What the registry does
 * NOT carry is the two facts this needs, and neither is derivable from it:
 *
 * - whether an exposure only REPORTS, which is what decides the list it belongs in; and
 * - which flags are FIXED, i.e. supplied by the exposure rather than by the caller.
 *
 * ## A fixed flag is never also a parameter, and that is the whole point
 *
 * **MCP permission rules cannot match on arguments.** A rule with parentheses is skipped when the
 * settings file loads, so the granularity is exactly the tool name -- which means
 * `sync({dryRun: true})` and `sync({dryRun: false})` would be ONE permission, and pre-approving
 * the dry run would pre-approve the sync.
 *
 * So a dry run is a separate tool with `--dry-run` fixed and the flag removed from its schema,
 * and `doctor` and `doctor_fix` are two tools rather than one with a boolean. That is what
 * `Bash(hangar doctor:*)` cannot express and is the reason this server exists at all. It also
 * makes `hangar-ops`'s most important habit -- run `-n` first -- structural: the preview is the
 * only door that is pre-approved.
 *
 * ## Parameters are the command's own flags, spelled exactly as the CLI spells them
 *
 * A property is a long flag without its `--`, or a positional argument's name. No short flags,
 * ever -- which is what disposes of this CLI's one genuinely misleading spelling, `resume`'s
 * `-n` meaning `--limit`. A tool parameter cannot inherit that trap because it is called `limit`.
 */
export type Exposure = {
  /** The tool name. Claude Code addresses it as `mcp__hangar__<name>`. */
  readonly name: string;
  /** The command path in the registry, e.g. `['colours', 'sync']`. */
  readonly path: readonly string[];
  /** Argv this exposure always supplies. Each one is removed from the schema. */
  readonly fixed?: readonly string[];
  /** Long flags this exposure refuses to offer, on top of `fixed`. */
  readonly hides?: readonly string[];
  /**
   * A `.hideHelp()` option this exposure offers anyway.
   *
   * Hidden means rare, not dangerous, and the two are worth telling apart: `add-clone --remote`
   * clones from a different URL, which is a real thing to want and simply not worth a line in
   * `--help`. Naming it per exposure keeps the default -- hidden is not promised -- while letting
   * one be promised on purpose.
   */
  readonly shows?: readonly string[];
  /** `false` puts it in operator mode's `allow` list; `true` puts it in `ask`. */
  readonly acts: boolean;
  /** Prepended to the registry's own text when the fixed flags change what the command means. */
  readonly lede?: string;
};

/**
 * Offered by no exposure, whichever command carries it.
 *
 * `--quiet` exists so a `SessionEnd` hook and the status bar's own detached spawn can say nothing
 * unless something needs a human. A caller reading the result has the opposite need, and a tool
 * that could be told to return nothing is one whose silence means two different things.
 *
 * A `.hideHelp()` option is dropped too, by `optionIsOffered` rather than by name --
 * `add-clone --remote` is the only one, and an option kept out of `--help` is not promised to an
 * operator, so it is not promised to a tool either.
 */
const ALWAYS_HIDDEN: readonly string[] = ['--quiet'];

const PREVIEW = '--dry-run';
const previewLede =
  'Dry run -- reports every decision the real run would make and changes nothing.';

/*
 * One entry per VS Code-family, JetBrains, Zed and Emacs `ide <kind> sync`. The list is repeated
 * from `SYNCABLE` in `cli.ts` rather than imported, because importing `cli.ts` would run it:
 * that module's last statement is `program.parseAsync()`. A kind added there and not here is a
 * tool that simply does not exist, which `mcpCoverage` reports on stderr when the server starts.
 */
const IDE_KINDS: readonly string[] = ['vscode', 'jetbrains', 'zed', 'emacs'];

const ideExposures: readonly Exposure[] = IDE_KINDS.flatMap((kind) => [
  {
    name: `ide_${kind}_sync_preview`,
    path: ['ide', kind, 'sync'],
    fixed: [PREVIEW],
    acts: false,
    lede: previewLede,
  },
  { name: `ide_${kind}_sync`, path: ['ide', kind, 'sync'], hides: [PREVIEW], acts: true },
]);

/**
 * The whole tool surface.
 *
 * **Five commands are deliberately absent, and the Bash denials stay in force beside them:**
 * `claude` is operator mode's escalation boundary -- `ops.settings.json` denies it and the
 * command itself refuses when `$CLAUDECODE` is set; `dev golden` and `dev release` are hidden
 * maintainer commands whose whole interface contract is that nothing about them is promised to
 * an operator; `jira hook` is a `PreToolUse` hook rather than a command, with a fail-open
 * contract a tool call would defeat; and `setup` writes `hangar.config.yaml`, which a hangar
 * that is already running has.
 */
export const EXPOSURES: readonly Exposure[] = [
  // ---- reports ----------------------------------------------------------------------------
  { name: 'list', path: ['list'], acts: false },
  /*
   * `--json` is a PARAMETER and not fixed, and that was a correction. Fixing it looked like a
   * kindness to a machine reader, but the JSON path returns early: it carries the raw `drift`
   * array and skips the human form's closing sentence, which is the half that says a repaired
   * `.env.local` does nothing until `direnv allow` is re-run in that clone. Losing a diagnostic
   * to make the output tidier is the wrong trade, so the default is what a person sees.
   */
  {
    name: 'ports',
    path: ['ports'],
    acts: false,
    lede: 'Pass `json: true` for the same map as data — at the cost of the repair guidance.',
  },
  { name: 'status', path: ['status'], acts: false },
  {
    name: 'doctor',
    path: ['doctor'],
    hides: ['--fix'],
    acts: false,
    lede: 'Reports only. The repair is a separate tool, `doctor_fix`.',
  },
  { name: 'colours_list', path: ['colours', 'list'], acts: false },
  { name: 'config_show', path: ['config', 'show'], acts: false },
  { name: 'config_validate', path: ['config', 'validate'], acts: false },
  {
    name: 'config_schema_check',
    path: ['config', 'schema'],
    fixed: ['--check'],
    hides: ['--out'],
    acts: false,
    lede: 'Reports whether the tracked `hangar.schema.json` is current. Writes nothing.',
  },
  /*
   * `colours sync` is the one command whose two read-only forms answer different questions, so it
   * gets two tools rather than one. `--check` is a GATE -- non-zero when an artifact is stale --
   * and `-n` is the REPORT that says which one and what would change in it. `app/CLAUDE.md` names
   * the dry run as the only staleness check there is for the two gitignored shell helpers, so
   * leaving it unreachable would have taken away the thing that check is for.
   */
  {
    name: 'colours_check',
    path: ['colours', 'sync'],
    fixed: ['--check'],
    hides: [PREVIEW],
    acts: false,
    lede: 'Exits non-zero if any generated colour artifact is out of date. Writes nothing.',
  },
  {
    name: 'colours_sync_preview',
    path: ['colours', 'sync'],
    fixed: [PREVIEW],
    hides: ['--check'],
    acts: false,
    lede: previewLede,
  },
  {
    name: 'resume_list',
    path: ['resume'],
    acts: false,
    lede: "Lists a clone's sessions. With no terminal there is no picker, so this only reports.",
  },
  /*
   * `pr refresh` writes a cache file, and `hangar-ops` calls it an act for that reason -- but it
   * is pre-approved here, and the two are not in conflict. The clone bar spawns this itself,
   * detached, every time a record passes `forge.prCacheTtlSeconds`; asking a human to approve
   * what already happens unattended twenty times a minute would be theatre. What it writes is a
   * cache the next redraw would rewrite anyway.
   */
  { name: 'pr_refresh', path: ['pr', 'refresh'], hides: [PREVIEW], acts: false },
  {
    name: 'pr_refresh_preview',
    path: ['pr', 'refresh'],
    fixed: [PREVIEW],
    acts: false,
    lede: 'Says which clones would be asked and why the rest are being skipped. Asks nothing.',
  },
  {
    name: 'browse_preview',
    path: ['browse'],
    fixed: [PREVIEW],
    acts: false,
    lede: 'Prints the URL and opens nothing.',
  },

  // ---- previews ---------------------------------------------------------------------------
  { name: 'sync_preview', path: ['sync'], fixed: [PREVIEW], acts: false, lede: previewLede },
  {
    name: 'checkout_default_preview',
    path: ['checkout-default'],
    fixed: [PREVIEW],
    acts: false,
    lede: previewLede,
  },
  { name: 'open_preview', path: ['open'], fixed: [PREVIEW], acts: false, lede: previewLede },
  { name: 'close_preview', path: ['close'], fixed: [PREVIEW], acts: false, lede: previewLede },
  { name: 'reload_preview', path: ['reload'], fixed: [PREVIEW], acts: false, lede: previewLede },
  { name: 'install_preview', path: ['install'], fixed: [PREVIEW], acts: false, lede: previewLede },
  {
    name: 'tmp_merge_preview',
    path: ['tmp', 'merge'],
    fixed: [PREVIEW],
    acts: false,
    lede: previewLede,
  },
  {
    name: 'plans_collect_preview',
    path: ['plans', 'collect'],
    fixed: [PREVIEW],
    acts: false,
    lede: previewLede,
  },
  {
    name: 'plans_stamp_preview',
    path: ['plans', 'stamp'],
    fixed: [PREVIEW],
    acts: false,
    lede: previewLede,
  },
  {
    name: 'teach_rg_preview',
    path: ['teach-rg'],
    fixed: [PREVIEW],
    acts: false,
    lede: previewLede,
  },
  { name: 'setup_preview', path: ['setup'], fixed: [PREVIEW], acts: false, lede: previewLede },

  // ---- acts -------------------------------------------------------------------------------
  { name: 'sync', path: ['sync'], hides: [PREVIEW], acts: true },
  { name: 'checkout_default', path: ['checkout-default'], hides: [PREVIEW], acts: true },
  { name: 'open', path: ['open'], hides: [PREVIEW], acts: true },
  { name: 'close', path: ['close'], hides: [PREVIEW], acts: true },
  { name: 'reload', path: ['reload'], hides: [PREVIEW], acts: true },
  { name: 'install', path: ['install'], hides: [PREVIEW], acts: true },
  { name: 'add_clone', path: ['add-clone'], shows: ['--remote'], acts: true },
  { name: 'remove_clone', path: ['remove-clone'], acts: true },
  { name: 'colours_change', path: ['colours', 'change'], acts: true },
  { name: 'colours_sync', path: ['colours', 'sync'], hides: [PREVIEW, '--check'], acts: true },
  {
    name: 'doctor_fix',
    path: ['doctor'],
    fixed: ['--fix'],
    acts: true,
    lede: "Writes into every clone's working directory. `doctor` is the report.",
  },
  { name: 'tmp_merge', path: ['tmp', 'merge'], hides: [PREVIEW], acts: true },
  { name: 'plans_collect', path: ['plans', 'collect'], hides: [PREVIEW], acts: true },
  { name: 'plans_stamp', path: ['plans', 'stamp'], hides: [PREVIEW], acts: true },
  { name: 'teach_rg', path: ['teach-rg'], hides: [PREVIEW], acts: true },
  { name: 'browse', path: ['browse'], hides: [PREVIEW], acts: true },
  /*
   * `setup` is exposed rather than left out, and that CLOSES a gap rather than opening one.
   * `modes.md` records it as escalation-adjacent and unlisted: operator mode denies
   * `Bash(hangar claude)` and `Bash(hangar dev)` but has never named `hangar setup`, so
   * `setup --force` sits behind one generic prompt today. As a tool it has a rule of its own.
   */
  { name: 'setup', path: ['setup'], hides: [PREVIEW], acts: true },
  {
    name: 'config_schema_write',
    path: ['config', 'schema'],
    hides: ['--check'],
    acts: true,
    lede: 'Rewrites the tracked `hangar.schema.json` from the zod schema.',
  },
  ...ideExposures,
];

/** The permission rule that governs one tool. The server name is fixed by `mcp.json`. */
export const permissionRule = (name: string): string => `mcp__hangar__${name}`;

/** Walk the registry to the command an exposure names, or undefined if it is not there. */
export const findCommand = (
  program: CommandUnknownOpts,
  path: readonly string[],
): CommandUnknownOpts | undefined => {
  let cmd: CommandUnknownOpts | undefined = program;
  for (const part of path) {
    cmd = cmd?.commands.find((c) => c.name() === part || c.aliases().includes(part));
  }
  return cmd;
};

type JsonSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

/** `--include-busy` -> `include-busy`. Undefined for an option with no long form. */
const propertyOf = (option: Option): string | undefined => option.long?.replace(/^--/, '');

/** A flag that takes no value, so its property is a boolean. */
const isFlag = (option: Option): boolean => !option.required && !option.optional;

const optionIsOffered = (option: Option, exposure: Exposure): boolean => {
  const long = option.long;
  if (long === undefined) return false;
  if (option.hidden && exposure.shows?.includes(long) !== true) return false;
  if (ALWAYS_HIDDEN.includes(long)) return false;
  if (exposure.fixed?.includes(long) === true) return false;
  return exposure.hides?.includes(long) !== true;
};

/**
 * The tool's input schema, read off the registry entry rather than written out again.
 *
 * Positional arguments keep their declared names and order; options keep their long flags. A
 * `.choices()` on either becomes an `enum`, which is what makes `colours_change` reject a hue
 * that is not in the palette before the subprocess is ever started.
 */
export const inputSchemaFor = (cmd: CommandUnknownOpts, exposure: Exposure): JsonSchema => {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const arg of cmd.registeredArguments) {
    const item: Record<string, unknown> = { type: 'string', description: arg.description };
    if (arg.argChoices !== undefined) item['enum'] = [...arg.argChoices];
    properties[arg.name()] = arg.variadic
      ? { type: 'array', items: item, description: arg.description }
      : item;
    if (arg.required) required.push(arg.name());
  }

  for (const option of cmd.options) {
    if (!optionIsOffered(option, exposure)) continue;
    const property = propertyOf(option);
    if (property === undefined) continue;
    const item: Record<string, unknown> = isFlag(option)
      ? { type: 'boolean', description: option.description }
      : { type: 'string', description: option.description };
    if (option.argChoices !== undefined) item['enum'] = [...option.argChoices];
    properties[property] = item;
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
};

export const descriptionFor = (cmd: CommandUnknownOpts, exposure: Exposure): string => {
  const own = cmd.description();
  return exposure.lede === undefined ? own : `${exposure.lede}\n\n${own}`;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
};

/** Every tool this server offers, in table order. Throws if the table names a missing command. */
export const toolDefinitions = (program: CommandUnknownOpts): ToolDefinition[] =>
  EXPOSURES.map((exposure) => {
    const cmd = findCommand(program, exposure.path);
    if (cmd === undefined) {
      throw new CliError(
        `the MCP tool \`${exposure.name}\` names \`hangar ${exposure.path.join(' ')}\`, which is not a command`,
        'Fix the table in app/src/mcp/tools.ts, or restore the command in app/src/cli.ts.',
      );
    }
    return {
      name: exposure.name,
      description: descriptionFor(cmd, exposure),
      inputSchema: inputSchemaFor(cmd, exposure),
    };
  });

/**
 * A tool argument on its way to argv.
 *
 * Refuses an object rather than letting `String()` put `[object Object]` on a command line, where
 * it would be a clone name nothing matches -- or, worse, an argument some command accepts.
 */
const scalar = (exposure: Exposure, property: string, value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new CliError(
    `\`${exposure.name}\`'s \`${property}\` must be a single value, not ${typeof value}`,
  );
};

/**
 * Turn a tool call's arguments back into argv for `bin/hangar`.
 *
 * Positional arguments go in DECLARED order and options follow, which is what commander expects
 * and is also why an unknown property is a refusal rather than something to drop: silently
 * ignoring a name the caller believed in would run a command that is not the one they asked for.
 */
export const argvFor = (
  cmd: CommandUnknownOpts,
  exposure: Exposure,
  args: Readonly<Record<string, unknown>>,
): string[] => {
  const positional: string[] = [];
  const flags: string[] = [];
  const known = new Set<string>();

  for (const arg of cmd.registeredArguments) {
    known.add(arg.name());
    const value = args[arg.name()];
    if (value === undefined) {
      if (arg.required) throw new CliError(`\`${exposure.name}\` needs \`${arg.name()}\``);
      continue;
    }
    if (Array.isArray(value)) {
      positional.push(...value.map((v: unknown) => scalar(exposure, arg.name(), v)));
    } else positional.push(scalar(exposure, arg.name(), value));
  }

  for (const option of cmd.options) {
    const property = propertyOf(option);
    if (property === undefined || !optionIsOffered(option, exposure)) continue;
    known.add(property);
    const value = args[property];
    if (value === undefined) continue;
    if (isFlag(option)) {
      if (value === true) flags.push(option.long ?? '');
      continue;
    }
    flags.push(option.long ?? '', scalar(exposure, property, value));
  }

  for (const name of Object.keys(args)) {
    if (!known.has(name)) {
      throw new CliError(
        `\`${exposure.name}\` has no parameter \`${name}\``,
        known.size === 0 ? 'It takes none.' : `It takes: ${[...known].sort().join(', ')}`,
      );
    }
  }

  return [...exposure.path, ...positional, ...(exposure.fixed ?? []), ...flags];
};

/**
 * Leaf commands with no tool, and the reason each one earns its place here.
 *
 * The bar is high: everything else in this CLI is a tool, `setup` included -- exposed precisely
 * BECAUSE it was escalation-adjacent and unnamed. These four are not omissions.
 *
 * - **`claude`** refuses whenever `$CLAUDECODE` is set, which is every tool call there will ever
 *   be, so the tool could only ever fail -- and it is the escalation boundary the mode pair
 *   exists for. A tool that cannot work, on the one command that must not, is worse than none.
 * - **`dev release`** pushes to origin and cuts a version. Its confirmation reads `/dev/tty` and
 *   fails closed, so the ONLY way it completes as a tool call is with `-y`, which means exposing
 *   it is exposing the dangerous form of it. It stays a thing a person types.
 * - **`dev golden`** writes a capture to `-o <dir>`, and the gate is `pnpm golden`, a script that
 *   runs the binary once per fixture and normalises the result. One call is a PARTIAL capture
 *   that would read as the gate without being it -- and aimed at `dev/golden/gated` it would
 *   half-overwrite the tracked baseline.
 * - **`jira hook`** reads a `PreToolUse` payload from stdin and fails open when there is none, so
 *   a tool call reaches it with nothing to do and it correctly says nothing.
 *
 * `mcp` is the fifth and is this server, which has no business calling itself.
 */
export const NOT_EXPOSED: readonly string[] = [
  'claude',
  // Runs an arbitrary shell snippet in every clone, so an MCP schema could describe it but
  // never constrain it -- the one thing a tool rule is for. The Bash path is the only one.
  'exec',
  'dev golden',
  'dev release',
  'jira hook',
  'mcp',
];

/**
 * Leaf commands the table says nothing about, for a line on stderr when the server starts.
 *
 * A WARNING rather than a refusal, and the asymmetry is deliberate. The two directions fail
 * differently: an exposure with no permission rule is silently classifier-approved, which is a
 * security consequence and gets a test; a command with no exposure is a tool that is merely
 * missing, which is visible the moment somebody looks for it. Refusing to start would take
 * operator mode's whole tool surface away over a developer's omission in the other tab.
 */
export const unexposedCommands = (program: CommandUnknownOpts): string[] => {
  const exposed = new Set(EXPOSURES.map((e) => e.path.join(' ')));
  const missing: string[] = [];
  const walk = (cmd: CommandUnknownOpts, path: readonly string[]): void => {
    const children = cmd.commands;
    if (children.length > 0) {
      for (const child of children) walk(child, [...path, child.name()]);
      return;
    }
    const spelled = path.join(' ');
    if (!exposed.has(spelled) && !NOT_EXPOSED.includes(spelled)) missing.push(spelled);
  };
  for (const child of program.commands) walk(child, [child.name()]);
  return missing;
};
