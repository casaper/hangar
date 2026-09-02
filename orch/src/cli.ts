import { Argument, Command, Option } from '@commander-js/extra-typings';
import pc from 'picocolors';

import { addClone } from './commands/add-clone.ts';
import { coloursChange, coloursList, coloursSync } from './commands/colours.ts';
import { doctor } from './commands/doctor.ts';
import { list } from './commands/list.ts';
import { open } from './commands/open.ts';
import { plansCollect, plansStamp } from './commands/plans.ts';
import { ports } from './commands/ports.ts';
import { removeClone } from './commands/remove-clone.ts';
import { resume } from './commands/resume.ts';
import { status } from './commands/status.ts';
import { sync } from './commands/sync.ts';
import { tmpMerge } from './commands/tmp.ts';
import { vscodeSync } from './commands/vscode.ts';
import { CliError } from './exec.ts';
import { PALETTE_NAMES } from './palette.ts';
import { fleetRoot, tildify } from './paths.ts';

/**
 * `orch-util` -- fleet-level orchestration for the storefront_ui clones.
 *
 * This is the ONLY place allowed to end the process; every command signals failure by
 * throwing a CliError, which is rendered here as a message rather than a stack trace.
 */
const program = new Command()
  .name('orch-util')
  .description(
    `Orchestration for the storefront_ui clone fleet in ${tildify(fleetRoot)}.\n\n` +
      'Clones are discovered from the filesystem; their colour and their three ports are\n' +
      'pure functions of the clone index, so adding or removing one needs no bookkeeping.',
  )
  .version('1.0.0');

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
  .option('--no-session-notify', 'do not type pause/resume messages into live Claude sessions')
  .option('--include-busy', 'with --all, also sync clones that have a live Claude session')
  .option('--onto <ref>', 'integrate onto this ref instead, skipping the pull-request lookup')
  .action(async (clone, options) => {
    await sync(clone, options);
  });

program
  .command('open')
  .description(
    'Open clones in one shared iTerm2 window: three tabs each (Claude, shell, angular/) plus the VS Code workspace',
  )
  .argument('[clones...]', 'clone names, e.g. clone_02 (or just 2) — opened in ascending order')
  .option('--all', 'open every clone in the fleet')
  .option('--no-claude', 'do not start Claude Code in the first tab')
  .option('--no-code', 'do not open the VS Code workspace')
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
  .action((options) => {
    tmpMerge(options);
  });

const vscode = program
  .command('vscode')
  .description('The VS Code setup: settings, MCP servers, launchers and the workspace files');

vscode
  .command('sync')
  .description('Give every clone the same VS Code setup, keeping its per-clone paths its own')
  .option('--from <clone>', 'sync from this clone instead of the most recently edited file')
  .option('-n, --dry-run', 'show what would change, write nothing')
  .action((options) => {
    vscodeSync(options);
  });

const colours = program
  .command('colours')
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
