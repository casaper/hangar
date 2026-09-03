import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Argument, Command, Option, type CommandUnknownOpts } from '@commander-js/extra-typings';
import pc from 'picocolors';

import { addClone } from './commands/add-clone.ts';
import { coloursChange, coloursList, coloursSync } from './commands/colours.ts';
import { configSchema, configShow, configValidate } from './commands/config.ts';
import { doctor } from './commands/doctor.ts';
import { jiraHook } from './commands/jira.ts';
import { list } from './commands/list.ts';
import { open } from './commands/open.ts';
import { plansCollect, plansStamp } from './commands/plans.ts';
import { ports } from './commands/ports.ts';
import { removeClone } from './commands/remove-clone.ts';
import { resume } from './commands/resume.ts';
import { setup } from './commands/setup.ts';
import { status } from './commands/status.ts';
import { teachRg } from './commands/teach-rg.ts';
import { sync } from './commands/sync.ts';
import { tmpMerge } from './commands/tmp.ts';
import { syncEditor } from './commands/vscode.ts';
import type { EditorKind } from './editor/index.ts';
import { CONFIG_FILENAME, EXAMPLE_CONFIG_FILENAME } from './config/load.ts';
import { CliError } from './exec.ts';
import { fleetRoot, tildify } from './paths.ts';
import { PALETTE_NAMES } from './palette.ts';

/**
 * `hangar` -- fleet-level orchestration for the storefront_ui clones.
 *
 * This is the ONLY place allowed to end the process; every command signals failure by
 * throwing a CliError, which is rendered here as a message rather than a stack trace.
 */
const program = new Command()
  .name('hangar')
  .description(
    'Orchestration for one hangar: a directory holding a fleet of full clones of one repo.\n\n' +
      'Clones are discovered from the filesystem; their colour and their ports are pure\n' +
      'functions of the clone index, so adding or removing one needs no bookkeeping.',
  )
  .version('1.0.0')
  /*
   * The hangar to act on. Precedence is --hangar > the upward walk from cwd > HANGAR_ROOT,
   * and NOT commander's `.env()`, which would collapse the flag and the variable onto one
   * level and lose that ordering. The walk outranks the variable deliberately: a shell
   * carrying HANGAR_ROOT for one hangar while sitting in another would act on the wrong
   * repo's clones.
   */
  .option('--hangar <path>', 'the hangar root to operate on (default: nearest above cwd)')
  .hook('preAction', (_thisCommand, actionCommand) => {
    requireHangarConfig(commandPath(actionCommand));
  });

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
const requireHangarConfig = (path: string): void => {
  if (NEEDS_NO_CONFIG.includes(path)) return;
  const configPath = join(fleetRoot, CONFIG_FILENAME);
  if (existsSync(configPath)) return;
  throw new CliError(
    `no ${CONFIG_FILENAME} in ${tildify(fleetRoot)}, so this is not a hangar`,
    `Run \`hangar setup\` to write one, or start from the committed example:\n` +
      `         cp ${EXAMPLE_CONFIG_FILENAME} ${CONFIG_FILENAME}`,
  );
};

program
  .command('list')
  .description('List every clone with its branch and last commit')
  .action(() => {
    list();
  });

program
  .command('ports')
  .description('Show the port map of every clone')
  .option('--json', 'machine-readable output')
  .action((options) => {
    ports(options);
  });

program
  .command('status')
  .description('Show the status and setup of a clone: branch, sync, Jira, PR, ports, servers')
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2)')
  .option('-a, --all', 'show every clone')
  .option('-f, --fetch', 'fetch first, so the sync answer is authoritative')
  .action((clone, options) => {
    status(clone, options);
  });

program
  .command('sync')
  .description(
    'Rebase or merge a clone onto whatever its pull request targets, stashing and restoring your work',
  )
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2)')
  .option('-a, --all', 'sync every clone (skips clones with a live Claude session)')
  .option('-n, --dry-run', 'show the resolved target and chosen strategy, and change nothing')
  .option('--no-session-notify', 'do not type pause/closing messages into live Claude sessions')
  .option('--include-busy', 'with --all, also sync clones that have a live Claude session')
  .option('--onto <ref>', 'integrate onto this ref instead, skipping the pull-request lookup')
  .action(async (clone, options) => {
    await sync(clone, options);
  });

program
  .command('open')
  .description(
    'Open clones in one shared terminal window: three tabs each (Claude, shell, angular/) plus every configured editor',
  )
  .argument('[clones...]', 'clone names, e.g. clone_02 (or just 2) — opened in ascending order')
  .option('--all', 'open every clone in the fleet')
  .option('--no-claude', 'do not start Claude Code in the first tab')
  .option('--no-editor', 'do not open the clone in any configured editor')
  .action((clones: string[], options) => {
    open(clones, options);
  });

program
  .command('resume')
  .description("Pick one of a clone's past Claude Code sessions from a list and resume it")
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2); defaults to the clone you are in')
  .option('-n, --limit <count>', 'how many of the most recent sessions to list (0 = all)', '20')
  .action(async (clone, options) => {
    await resume(clone, options);
  });

program
  .command('add-clone')
  .description('Create the next clone and wire it into the fleet completely')
  .option('--no-install', 'skip `npm ci` (the clone cannot serve, test or build until you run it)')
  .addOption(new Option('--remote <url>', 'clone from a different URL').hideHelp())
  .action((options) => {
    addClone(options);
  });

program
  .command('remove-clone')
  .description('Detach a clone from the fleet, and optionally delete it')
  .argument('<clone>', 'clone name, e.g. clone_04')
  .option('--delete', 'also delete the directory (guarded: uncommitted work, servers, sessions)')
  .option('--force', 'delete despite the guards — uncommitted work is NOT recoverable')
  .action((clone, options) => {
    removeClone(clone, options);
  });

program
  .command('doctor')
  .description('Verify (and optionally repair) every untracked per-clone artifact')
  .argument('[clone]', 'clone to check; defaults to every clone')
  .option('-a, --all', 'check every clone')
  .option('--fix', 'repair the checks that are derivable from the clone index')
  .action((clone, options) => {
    doctor(clone, options);
  });

program
  .command('setup')
  .description('Guided first-run: check the machine, then write hangar.config.yaml')
  .option('-y, --yes', 'accept every derived default without asking')
  .option('--force', 'rewrite an existing config')
  .option('-n, --dry-run', 'print what would be written and stop')
  .action(async (options) => {
    await setup(options);
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
    configSchema(options);
  });

program
  .command('teach-rg')
  .description("Have Claude Code make ripgrep the default search tool in a clone's instructions")
  .argument('<clone>', 'clone index, e.g. 2')
  .option('-n, --dry-run', 'print the prompt and stop')
  .option('-y, --yes', 'skip the confirmation')
  .action((clone, options) => {
    teachRg(clone, options);
  });

const jira = program
  .command('jira')
  .description(
    'The shared ticket record store: one file per ticket, every cached name a link to it',
  );

jira
  .command('hook')
  .description('PreToolUse hook: serve a cached ticket from the record store instead of fetching')
  .option('--ttl <minutes>', 'how old a stored record may be and still be served', '60')
  .option('-n, --dry-run', 'decide without making any link')
  .option(
    '--explain',
    'say on stderr why nothing was served — a fail-open hook is otherwise silent',
  )
  .action((options) => {
    jiraHook(options);
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
    plansCollect(options);
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
    plansStamp(options);
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
    tmpMerge(options);
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
      syncEditor(editor.kind, options);
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
  .description('Regenerate the shell and theme artifacts derived from the clone palette')
  .option('-n, --dry-run', 'show what would change, write nothing')
  .option('--check', 'exit non-zero if any artifact is out of date (writes nothing)')
  .action((options) => {
    coloursSync(options);
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
    coloursChange(clone, colour, options);
  });

colours
  .command('list')
  .description('Show the palette, painted, and which clone holds each hue')
  .action(() => {
    coloursList();
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
