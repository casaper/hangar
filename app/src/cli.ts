import { readFileSync } from 'node:fs';

import { Argument, Command, Option, type CommandUnknownOpts } from '@commander-js/extra-typings';
import pc from 'picocolors';

import { addClone } from './commands/add-clone.ts';
import { install } from './commands/install.ts';
import { checkoutDefault } from './commands/checkout-default.ts';
import { coloursChange, coloursList, coloursSync } from './commands/colours.ts';
import { configSchema, configShow, configValidate } from './commands/config.ts';
import { doctor } from './commands/doctor.ts';
import { jiraHook } from './commands/jira.ts';
import { golden } from './commands/dev.ts';
import { release } from './commands/release.ts';
import { list } from './commands/list.ts';
import { open } from './commands/open.ts';
import { plansCollect, plansStamp } from './commands/plans.ts';
import { ports } from './commands/ports.ts';
import { removeClone } from './commands/remove-clone.ts';
import { resume } from './commands/resume.ts';
import { setup } from './commands/setup.ts';
import { status } from './commands/status.ts';
import { teachRg } from './commands/teach-rg.ts';
import { forcedStrategy, sync } from './commands/sync.ts';
import { tmpMerge } from './commands/tmp.ts';
import { syncEditor } from './commands/vscode.ts';
import type { EditorKind } from './editor/index.ts';
import {
  CONFIG_FILENAME,
  EXAMPLE_CONFIG_FILENAME,
  findHangar,
  loadHangar,
  loadHangarTolerant,
  ROOT_ENV_KEY,
  tryLoadHangar,
} from './config/load.ts';
import type { Hangar } from './hangar.ts';
import { CliError } from './exec.ts';
import { PALETTE_NAMES } from './palette.ts';

/**
 * `hangar` -- fleet-level orchestration for a hangar's clones.
 *
 * This is the ONLY place allowed to end the process; every command signals failure by
 * throwing a CliError, which is rendered here as a message rather than a stack trace.
 */
/**
 * The CLI's version, read from `app/package.json` rather than repeated here.
 *
 * It used to be the literal `'1.0.0'`, which is the kind of duplicate nothing notices until a
 * release tool moves the other copy: semantic-release bumps `app/package.json` and would have
 * left `hangar --version` answering last year's number forever. Reading it is the only way the
 * two cannot disagree.
 *
 * The cast is not decoration -- `JSON.parse` returns `any`, which `strictTypeChecked` rejects.
 * The cost is one small synchronous read per invocation, `jira hook` included.
 */
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('hangar')
  .description(
    'Orchestration for one hangar: a directory holding a fleet of full clones of one repo.\n\n' +
      'Clones are discovered from the filesystem; their colour and their ports are pure\n' +
      'functions of the clone index, so adding or removing one needs no bookkeeping.',
  )
  .version(version)
  /*
   * The hangar to act on. Precedence is --hangar > the upward walk from cwd > HANGAR_ROOT,
   * and NOT commander's `.env()`, which would collapse the flag and the variable onto one
   * level and lose that ordering. The walk outranks the variable deliberately: a shell
   * carrying HANGAR_ROOT for one hangar while sitting in another would act on the wrong
   * repo's clones.
   */
  .option('--hangar <path>', 'the hangar root to operate on (default: nearest above cwd)')
  .hook('preAction', (thisCommand, actionCommand) => {
    resolveForCommand(commandPath(actionCommand), thisCommand.opts().hangar);
  })
  /*
   * Commander prints only the FIRST alias, in both the command listing and the usage line
   * (`sync|merge-default`), which would leave `rebase-default` -- one of the two names that
   * select a strategy -- documented nowhere a reader looks, including in the help for the very
   * command they typed. Both are rebuilt here with every alias in them. The argument suffix in
   * the term is reproduced by hand because commander's `humanReadableArgName` is internal.
   */
  .configureHelp({
    subcommandTerm: (cmd) => {
      const args = cmd.registeredArguments
        .map((arg) => {
          const name = arg.variadic ? `${arg.name()}...` : arg.name();
          return arg.required ? `<${name}>` : `[${name}]`;
        })
        .join(' ');
      return [
        allNames(cmd),
        ...(cmd.options.length > 0 ? ['[options]'] : []),
        ...(args === '' ? [] : [args]),
      ].join(' ');
    },
    commandUsage: (cmd) => {
      const ancestors: string[] = [];
      for (let parent = cmd.parent; parent !== null; parent = parent.parent) {
        ancestors.unshift(parent.name());
      }
      return [...ancestors, allNames(cmd), cmd.usage()].join(' ');
    },
  });

/** `sync|merge-default|rebase-default` -- every name a command answers to, in declared order. */
const allNames = (cmd: CommandUnknownOpts): string => [cmd.name(), ...cmd.aliases()].join('|');

/**
 * A command's full path, e.g. `ide vscode sync`. Commander gives the leaf; the parents carry
 * the rest, and the root program's own name is not part of it.
 */
const commandPath = (leaf: CommandUnknownOpts): string => {
  const parts: string[] = [];
  let cmd: CommandUnknownOpts = leaf;
  while (cmd.parent !== null) {
    parts.unshift(cmd.name());
    cmd = cmd.parent;
  }
  return parts.join(' ');
};

/**
 * Commands that must run where no `hangar.config.yaml` exists yet.
 *
 * `setup` writes the file, so requiring it would be circular. `jira hook` is a Claude Code
 * `PreToolUse` hook with a FAIL-OPEN contract -- it exits 0 and stays silent when it cannot
 * help -- and a non-zero exit from a PreToolUse hook can block the tool call it was meant to
 * accelerate. Neither exemption is a convenience; both are the difference between a clear
 * error and a broken clone session.
 */
const NEEDS_NO_CONFIG: readonly string[] = ['setup', 'jira hook'];

/**
 * Refuse to do anything in a directory that is not a hangar.
 *
 * The marker file IS the hangar -- ports, colours, the forge, the tracker and the editors all
 * come from it -- so acting without one would mean acting on schema defaults while looking like
 * a configured run. `hangar.config.yaml` is also untracked by design (it names one machine's
 * paths and token variables), so a fresh checkout of a hangar repo has none, and this is the
 * message that says what to do about it.
 *
 * EXISTENCE only, deliberately, not validity: `hangar config validate` and `hangar doctor` exist
 * to report an invalid config, and a gate that parsed it would stop them before they could.
 */
const TOLERATES_INVALID_CONFIG: readonly string[] = [
  'doctor',
  'config show',
  'config validate',
  'config schema',
];

/**
 * The hangar for this invocation, resolved ONCE in `preAction` and handed to the action.
 *
 * This module-level slot is the handoff between commander's hook and its action -- two separate
 * callbacks, so there is nowhere else to put it. It is deliberately the only one: no library
 * module reads it, every command takes the value as an argument and passes it down, and `Clone`
 * carries a back-reference. That is what lets two hangars be rendered in one process, which
 * `pnpm golden` does on every run.
 */
let resolved: Hangar | undefined;

const requireHangar = (): Hangar => {
  if (resolved === undefined) {
    // Unreachable through the CLI: `preAction` runs before every action, so this would mean a
    // command was registered on some other program than the one carrying the hook.
    throw new CliError('internal: the hangar was never resolved for this command');
  }
  return resolved;
};

/**
 * Resolve the hangar, or refuse in a directory that is not one.
 *
 * The marker file IS the hangar -- ports, colours, the forge, the tracker and the editors all
 * come from it -- so acting without one would mean acting on schema defaults while looking like
 * a configured run. `hangar.config.yaml` is also untracked by design (it names one machine's
 * paths and token variables), so a fresh checkout of a hangar repo has none, and this is the
 * message that says what to do about it.
 *
 * Three commands exist to REPORT on the config and so must survive one that will not parse;
 * they are resolved tolerantly, with `Hangar.configFellBack` recording that the values are the
 * schema's rather than the developer's. `hangar-internals/reference/config.md` states the rule
 * this preserves: absence is a gate, invalidity is a report.
 */
const resolveForCommand = (path: string, flag: string | undefined): void => {
  const opts = { cwd: process.cwd(), flag, env: process.env[ROOT_ENV_KEY] };

  if (NEEDS_NO_CONFIG.includes(path)) {
    // `setup` writes the file, so requiring it would be circular; `jira hook` must fail open.
    // Neither may throw on an absent hangar, so both get whatever is actually there.
    resolved = tryLoadHangar(opts);
    return;
  }

  if (findHangar(opts) === undefined) {
    throw new CliError(
      `no ${CONFIG_FILENAME} here or in any parent directory, so this is not a hangar`,
      `Run \`hangar setup\` to write one, or start from the committed example:\n` +
        `         cp ${EXAMPLE_CONFIG_FILENAME} ${CONFIG_FILENAME}`,
    );
  }
  resolved = TOLERATES_INVALID_CONFIG.includes(path) ? loadHangarTolerant(opts) : loadHangar(opts);
};

program
  .command('list')
  .description('List every clone with its branch and last commit')
  .action(() => {
    list(requireHangar());
  });

program
  .command('ports')
  .description('Show the port map of every clone')
  .option('--json', 'machine-readable output')
  .action((options) => {
    ports(requireHangar(), options);
  });

program
  .command('status')
  .description('Show the status and setup of a clone: branch, sync, Jira, PR, ports, servers')
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2)')
  .option('-a, --all', 'show every clone')
  .option('-f, --fetch', 'fetch first, so the sync answer is authoritative')
  .action((clone, options) => {
    status(requireHangar(), clone, options);
  });

program
  .command('sync')
  .aliases(['merge-default', 'rebase-default'])
  .summary(
    'Bring a clone up to date with what its pull request targets — the name picks the strategy',
  )
  .description(
    [
      'Bring a clone up to date with whatever its pull request targets, stashing and restoring your work around the integration.',
      'The name you type picks the strategy. `sync` decides for itself: it rebases only your own branch with a linear history since it forked, and merges anything else, because rebasing a branch someone else started rewrites their commits. `rebase-default` and `merge-default` are the same command with that choice forced, and forcing a rebase over that rule says so in the output.',
      "All three resolve the same TARGET: whatever the branch's open pull request points at, which is not always the default branch — so the `-default` in those two names is the common case rather than a promise. `--onto <ref>` overrides it.",
    ].join('\n\n'),
  )
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2)')
  .option('-a, --all', 'sync every clone (skips clones with a live Claude session)')
  .option('-n, --dry-run', 'show the resolved target and chosen strategy, and change nothing')
  .option('--no-session-notify', 'do not type pause/closing messages into live Claude sessions')
  .option('--include-busy', 'with --all, also sync clones that have a live Claude session')
  .option('--onto <ref>', 'integrate onto this ref instead, skipping the pull-request lookup')
  .addOption(
    new Option(
      '--strategy <how>',
      'force the integration strategy (the default is whichever name you typed)',
    ).choices(['rebase', 'merge']),
  )
  .action(async (clone, options) => {
    await sync(requireHangar(), clone, {
      ...options,
      strategy: options.strategy ?? forcedStrategy(process.argv),
    });
  });

program
  .command('checkout-default')
  .alias('checkout')
  .summary("Fetch, check out the repo's default branch and fast-forward it")
  .description(
    [
      "Fetch everything, then check out the repo's default branch and bring it up to date.",
      'Which branch that is comes from `forge.defaultBranch` in `hangar.config.yaml` — detected from git the first time anything needs it and recorded there, so the question is asked once per hangar and no command falls back to `master`.',
      'It refuses rather than carry uncommitted changes onto the default branch, and it only ever fast-forwards: a default branch that has diverged from origin is reported and left alone, because reconciling that is `hangar sync`.',
    ].join('\n\n'),
  )
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2)')
  .option('-a, --all', 'every clone (skips clones with a live Claude session)')
  .option('-n, --dry-run', 'show what would happen, and fetch and change nothing')
  .option('--include-busy', 'do not ask about, or skip, clones with a live Claude session')
  .action((clone, options) => {
    checkoutDefault(requireHangar(), clone, options);
  });

program
  .command('open')
  .summary('Open clones in their own tmux sessions, on a current default branch')
  .description(
    [
      "Open each clone in one terminal tab of its own, attached to that clone's tmux session — one tmux window per `terminal.tabs[]` role — plus every configured editor. A clone that is already open is brought forward rather than opened twice, and a clone whose tab was closed reattaches to the session it still has, with whatever was running in it.",
      "Each clone is first fetched and put on its repo's default branch, up to date — a clone you are opening is one you are starting work in, and starting on last week's branch is never what was wanted. `--branch <name>` names another branch, `--no-checkout` leaves each clone as it is, and a clone whose tree cannot be moved (uncommitted work, a half-applied rebase, a live Claude session) is opened as it is with a warning.",
      "The sessions live on this hangar's own tmux socket, so nothing here touches the tmux you run for your own work. `hangar doctor` prints the socket name.",
    ].join('\n\n'),
  )
  .argument('[clones...]', 'clone names, e.g. clone_02 (or just 2) — opened in ascending order')
  .option('--all', 'open every clone in the fleet')
  .option('--no-claude', 'do not start Claude Code in any of the clone’s windows')
  .option('--no-editor', 'do not open the clone in any configured editor')
  .option('--tab', "a tab in the terminal's current window (the default)")
  .option('--window', 'a window of its own instead of a tab')
  .option('-b, --branch <name>', "check this branch out instead of the repo's default branch")
  .option('--no-checkout', 'open each clone on whatever branch it already has')
  .option('--include-busy', 'check the branch out even in a clone with a live Claude session')
  .option('-n, --dry-run', 'print every decision — branch, windows, editors — and change nothing')
  .action((clones: string[], options: { tab?: boolean; window?: boolean }) => {
    if (options.tab === true && options.window === true) {
      throw new CliError('--tab and --window are the two answers to one question, so pick one');
    }
    const placement = options.window === true ? 'window' : options.tab === true ? 'tab' : undefined;
    open(requireHangar(), clones, {
      ...options,
      ...(placement === undefined ? {} : { placement }),
    });
  });

program
  .command('resume')
  .description("Pick one of a clone's past Claude Code sessions from a list and resume it")
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2); defaults to the clone you are in')
  .option('-n, --limit <count>', 'how many of the most recent sessions to list (0 = all)', '20')
  .action(async (clone, options) => {
    await resume(requireHangar(), clone, options);
  });

program
  .command('add-clone')
  .description('Create the next clone and wire it into the fleet completely')
  .option(
    '--no-install',
    'skip repo.install[] (the clone is not usable until you run `hangar install`)',
  )
  .addOption(new Option('--remote <url>', 'clone from a different URL').hideHelp())
  .action((options) => {
    addClone(requireHangar(), options);
  });

program
  .command('install')
  .description("Run the repo's declared install steps in a clone (repo.install[])")
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2)')
  .option('--all', 'every clone')
  .option('-n, --dry-run', 'print the steps without running any of them')
  .action((clone, options) => {
    install(requireHangar(), clone, options);
  });

program
  .command('remove-clone')
  .description('Detach a clone from the fleet, and optionally delete it')
  .argument('<clone>', 'clone name, e.g. clone_04')
  .option('--delete', 'also delete the directory (guarded: uncommitted work, servers, sessions)')
  .option('--force', 'delete despite the guards — uncommitted work is NOT recoverable')
  .action((clone, options) => {
    removeClone(requireHangar(), clone, options);
  });

program
  .command('doctor')
  .description('Verify (and optionally repair) every untracked per-clone artifact')
  .argument('[clone]', 'clone to check; defaults to every clone')
  .option('-a, --all', 'check every clone')
  .option('--fix', 'repair the checks that are derivable from the clone index')
  .action((clone, options) => {
    doctor(requireHangar(), clone, options);
  });

program
  .command('setup')
  .description('Guided first-run: check the machine, then write hangar.config.yaml')
  .option('-y, --yes', 'accept every derived default without asking')
  .option('--origin <url>', 'the git origin URL — the one answer nothing can derive')
  .option('--id <name>', 'the hangar id, instead of deriving it from the directory name')
  .option('--preset <name>', 'port roles and per-clone variables: generic, node-web, sql-postgrest')
  .option('--force', 'rewrite an existing config')
  .option('-n, --dry-run', 'print what would be written and stop')
  .action(async (options) => {
    /*
     * `--hangar` names the directory to set UP, when it is given.
     *
     * Every other command resolves it through `preAction`, which cannot help here: `setup` is
     * in `NEEDS_NO_CONFIG` precisely because the marker file does not exist yet, so there is
     * no hangar to resolve. Reading the flag directly is what makes `setup` scriptable --
     * without it, `--hangar /somewhere` was accepted and silently ignored, and setup wrote its
     * config into the working directory instead. `pnpm golden` needs exactly that, and would
     * otherwise have written a config into `app/`.
     */
    const flag: unknown = program.opts().hangar;
    const root = typeof flag === 'string' ? flag : (resolved?.root ?? process.cwd());
    await setup(root, options);
  });

const config = program
  .command('config')
  .description("Inspect and validate this hangar's configuration");

config
  .command('show')
  .description('Print the configuration as the CLI sees it, every default applied')
  .action(() => {
    configShow(program.opts().hangar);
  });

config
  .command('validate')
  .description('Validate hangar.config.yaml and report every problem at once')
  .action(() => {
    configValidate(program.opts().hangar);
  });

config
  .command('schema')
  .description('Regenerate hangar.schema.json from the zod schema')
  .option('--check', 'fail if the committed schema is out of date instead of writing it')
  .option('--out <path>', 'write somewhere other than the hangar root')
  .action((options) => {
    configSchema(requireHangar(), options);
  });

program
  .command('teach-rg')
  .description("Have Claude Code make ripgrep the default search tool in a clone's instructions")
  .argument('<clone>', 'clone index, e.g. 2')
  .option('-n, --dry-run', 'print the prompt and stop')
  .option('-y, --yes', 'skip the confirmation')
  .action((clone, options) => {
    teachRg(requireHangar(), clone, options);
  });

const jira = program
  .command('jira')
  .description(
    'The shared ticket record store: one file per ticket, every cached name a link to it',
  );

jira
  .command('hook')
  .description('PreToolUse hook: serve a cached ticket from the record store instead of fetching')
  // No commander default: an unset flag has to fall through to `tracker.cache.ttlMinutes`, and
  // a default here made `opts.ttl` permanently set, so the config value was unreachable.
  .option('--ttl <minutes>', 'how old a stored record may be and still be served')
  .option('-n, --dry-run', 'decide without making any link')
  .option(
    '--explain',
    'say on stderr why nothing was served — a fail-open hook is otherwise silent',
  )
  .action((options) => {
    jiraHook(resolved, options);
  });

const plans = program
  .command('plans')
  .description("The shared plan archive: gather the clones' plans and date them");

plans
  .command('collect')
  .description("Move every clone's finished plans into <fleet>/plans, dated and deduplicated")
  .option('-n, --dry-run', 'show what would move, change nothing')
  .option('-q, --quiet', 'say nothing unless a plan actually moved (for the SessionEnd hook)')
  .option('--no-transcript-scan', 'do not fall back to session transcripts for a missing date')
  .option(
    '--in-use-window <minutes>',
    'treat plans named in transcripts written this recently as in use',
    '30',
  )
  .action((options) => {
    plansCollect(requireHangar(), options);
  });

plans
  .command('stamp')
  .description('Prefix every plan in <fleet>/plans with its ISO creation date')
  .option('-n, --dry-run', 'show what would be renamed, change nothing')
  .option('--no-transcript-scan', 'do not fall back to session transcripts for a missing date')
  .option(
    '--in-use-window <minutes>',
    'treat plans named in transcripts written this recently as in use',
    '30',
  )
  .action((options) => {
    plansStamp(requireHangar(), options);
  });

const tmp = program
  .command('tmp')
  .description("The shared tmp/ cache: one store, a symlink per entry in every clone's own tmp/");

tmp
  .command('merge')
  .description("Move every clone's shareable tmp/ content into <fleet>/tmp and link it back")
  .option('-n, --dry-run', 'show what would move, change nothing')
  .option('-q, --quiet', 'say nothing unless something needs a human (for the SessionEnd hook)')
  .action((options) => {
    tmpMerge(requireHangar(), options);
  });

/*
 * One `<editor> sync` subcommand per editor that has files worth keeping in step, registered in
 * a loop rather than written out four times.
 *
 * Deliberately NOT one unified `editor sync`. The editors keep different files in step, only the
 * VS Code family's path can be exercised on the machine this was built on, and folding them
 * together would rename the command that works to make room for three that are unverified.
 * `editor.kinds` is already the single place that says which editors this hangar has, and each
 * command refuses when its editor is not in that list.
 *
 * The VS Code forks share `ide vscode sync`: Cursor, Windsurf and the rest all read `.vscode/`, so
 * there is one set of files for the family rather than one per fork.
 */
const SYNCABLE: readonly { kind: EditorKind; command: string; what: string; syncs: string }[] = [
  {
    kind: 'vscode',
    command: 'vscode',
    what: 'The VS Code setup: settings, MCP servers, launchers and the workspace files',
    syncs: 'Give every clone the same VS Code setup, keeping its per-clone paths its own',
  },
  {
    kind: 'jetbrains',
    command: 'jetbrains',
    what: "The JetBrains setup: the shareable half of each clone's .idea/ directory",
    syncs: 'Give every clone the same JetBrains project settings (never workspace.xml)',
  },
  {
    kind: 'zed',
    command: 'zed',
    what: "The Zed setup: each clone's .zed/ settings and tasks",
    syncs: 'Give every clone the same Zed settings and tasks',
  },
  {
    kind: 'emacs',
    command: 'emacs',
    what: "The Emacs setup: each clone's .dir-locals.el",
    syncs: 'Give every clone the same .dir-locals.el',
  },
];

/*
 * They live under one `ide` command (aliased `editor`), so `hangar --help` shows one entry for
 * the editors instead of one per editor -- and adding a fifth does not make the top level
 * longer. `ide` is the primary name because `editor.kinds` is already the config key: two
 * spellings of the same idea at the top level would read as two different things.
 */
const ide = program
  .command('ide')
  .alias('editor')
  .description("The editors' shared project files: one setup per editor across the fleet");

for (const editor of SYNCABLE) {
  ide
    .command(editor.command)
    .description(editor.what)
    .command('sync')
    .description(editor.syncs)
    .option('--from <clone>', 'sync from this clone instead of the most recently edited file')
    .option('-n, --dry-run', 'show what would change, write nothing')
    .action((options) => {
      syncEditor(requireHangar(), editor.kind, options);
    });
}

const colours = program
  .command('colours')
  // `colors` too: the code spells it the British way throughout and the flag names follow, but
  // nobody should have to remember which spelling a CLI chose.
  .alias('colors')
  .description("The clones' colour identity: the palette, the themes and the shell artifacts");

colours
  .command('sync')
  .description('Regenerate the shell, theme and tmux artifacts this hangar generates')
  .option('-n, --dry-run', 'show what would change, write nothing')
  .option('--check', 'exit non-zero if any artifact is out of date (writes nothing)')
  .action((options) => {
    coloursSync(requireHangar(), options);
  });

colours
  .command('change')
  .description('Give one clone a colour of your choosing, and rebuild everything that names it')
  .argument('<clone>', 'clone name, e.g. clone_02 (or just 2)')
  // `.choices()` rather than a free string: extra-typings narrows the argument to the palette
  // names, so a typo is a usage error listing the real ones instead of a clone silently keeping
  // the hue it had. The names are DATA in src/palette.ts -- adding a hue extends this list.
  .addArgument(new Argument('<colour>', 'palette colour').choices(PALETTE_NAMES))
  .option('--force', 'allow a colour a sibling clone already has')
  .action((clone, colour, options) => {
    coloursChange(requireHangar(), clone, colour, options);
  });

colours
  .command('list')
  .description('Show the palette, painted, and which clone holds each hue')
  .action(() => {
    coloursList(requireHangar());
  });

/**
 * `dev` is HIDDEN, and that is the whole of its interface contract: it exists for work on this
 * repository itself and nothing about it is promised to an operator -- which is why neither
 * subcommand has a row in `hangar-ops/reference/commands.md`. It is not in `NEEDS_NO_CONFIG`:
 * a capture of a hangar with no config would be a capture of the schema defaults, the one
 * output the regression net must never be able to mistake for a real one, and a release cut
 * from an unconfigured checkout would be cut from the same fiction.
 */
const dev = program
  .command('dev', { hidden: true })
  .description('Maintainer tools for this repository itself');

dev
  .command('golden')
  .description('Capture every artifact this hangar would write, with its destination')
  .requiredOption('-o, --out <dir>', 'directory to write the capture into')
  .option(
    '-i, --indices <list>',
    'synthesize these clone indices (e.g. 1,2,3) instead of discovering directories',
  )
  .action((options: { out: string; indices?: string }) => {
    golden(requireHangar(), options);
  });

dev
  .command('release')
  .description("Run this repo's gates, then hand over to semantic-release")
  .option('-n, --dry-run', 'run the gates and semantic-release --dry-run, change nothing')
  .option('--skip-checks', 'skip the gates, having just run them by hand')
  .option('-y, --yes', 'do not ask before releasing, for a run with no terminal to ask at')
  .action((options) => {
    release(requireHangar(), options);
  });

/**
 * `parseAsync`, not `parse`: `sync` awaits a streaming `claude -p` run. A synchronous
 * `try/catch` around `parseAsync()` would NOT catch a CliError thrown inside an async action
 * -- it would surface as an unhandled rejection with a stack trace, which is the exact
 * failure mode CliError exists to prevent. So both paths funnel through one handler.
 */
const report = (error: unknown): never => {
  if (error instanceof CliError) {
    console.error(`${pc.red('error')}: ${error.message}`);
    if (error.hint !== undefined) console.error(`       ${error.hint}`);
    process.exit(1);
  }
  throw error;
};

try {
  await program.parseAsync();
} catch (error) {
  report(error);
}
