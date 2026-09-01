import { Command, Option } from '@commander-js/extra-typings';
import pc from 'picocolors';

import { addClone } from './commands/add-clone.ts';
import { coloursSync } from './commands/colours.ts';
import { doctor } from './commands/doctor.ts';
import { jiraLink } from './commands/jira.ts';
import { list } from './commands/list.ts';
import { open } from './commands/open.ts';
import { plansCollect, plansStamp } from './commands/plans.ts';
import { ports } from './commands/ports.ts';
import { removeClone } from './commands/remove-clone.ts';
import { status } from './commands/status.ts';
import { sync } from './commands/sync.ts';
import { tmpMerge } from './commands/tmp.ts';
import { CliError } from './exec.ts';
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
  .description('Rebase or merge a clone onto the default branch, stashing and restoring your work')
  .argument('[clone]', 'clone name, e.g. clone_02 (or just 2)')
  .option('-a, --all', 'sync every clone (skips clones with a live Claude session)')
  .option('-n, --dry-run', 'show the chosen strategy and change nothing')
  .option('--no-session-notify', 'do not type pause/resume messages into live Claude sessions')
  .option('--include-busy', 'with --all, also sync clones that have a live Claude session')
  .action((clone, options) => {
    sync(clone, options);
  });

program
  .command('open')
  .description(
    'Open a clone: three iTerm2 tabs (Claude, shell, angular/) and the VS Code workspace',
  )
  .argument('<clone>', 'clone name, e.g. clone_02 (or just 2)')
  .option('--no-claude', 'do not start Claude Code in the first tab')
  .option('--no-code', 'do not open the VS Code workspace')
  .action((clone, options) => {
    open(clone, options);
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
  .description("The shared tmp/: one directory, every clone's `tmp` a symlink to it");

tmp
  .command('merge')
  .description("Merge every clone's tmp/ into <fleet>/tmp and link them to it")
  .option('-n, --dry-run', 'show what would move, change nothing')
  .option(
    '--force',
    'merge even where a clone still writes flat tmp/<name>.pid (two clones then cannot both serve)',
  )
  .action((options) => {
    tmpMerge(options);
  });

const jira = program
  .command('jira')
  .description('Per-ticket Jira cache (superseded by `tmp merge` once every tmp/ is shared)');

jira
  .command('link')
  .description('Link every clone tmp/<KEY> into the legacy store, adopting real dirs in place')
  .argument('[keys...]', 'issue keys to link; default is every key found anywhere')
  .option('-n, --dry-run', 'show what would happen, change nothing')
  .action((keys, options) => {
    jiraLink(keys, options);
  });

program
  .command('colours')
  .description('Regenerate the shell and theme artifacts derived from the clone palette')
  .argument('[action]', 'sync', 'sync')
  .option('-n, --dry-run', 'show what would change, write nothing')
  .option('--check', 'exit non-zero if any artifact is out of date (writes nothing)')
  .action((action, options) => {
    if (action !== 'sync') throw new CliError(`unknown colours action: ${action}`);
    coloursSync(options);
  });

try {
  program.parse();
} catch (error) {
  if (error instanceof CliError) {
    console.error(`${pc.red('error')}: ${error.message}`);
    if (error.hint !== undefined) console.error(`       ${error.hint}`);
    process.exit(1);
  }
  throw error;
}
