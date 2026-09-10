import { readFileSync } from 'node:fs';

import { Argument, Command, Option, type CommandUnknownOpts } from '@commander-js/extra-typings';
import pc from 'picocolors';

import { addClone } from './commands/add-clone.ts';
import { exec, splitExecArgv } from './commands/exec.ts';
import { install } from './commands/install.ts';
import { browse } from './commands/browse.ts';
import { checkoutDefault } from './commands/checkout-default.ts';
import { claude, claudeArgvFromProcess } from './commands/claude.ts';
import { coloursChange, coloursList, coloursSync } from './commands/colours.ts';
import { configSchema, configShow, configValidate } from './commands/config.ts';
import { doctor } from './commands/doctor.ts';
import { jiraHook } from './commands/jira.ts';
import { golden } from './commands/dev.ts';
import { release } from './commands/release.ts';
import { list } from './commands/list.ts';
import { mcp } from './commands/mcp.ts';
import { closeClones, type CloseOptions } from './commands/close.ts';
import { open } from './commands/open.ts';
import { reloadClones, type ReloadOptions } from './commands/reload.ts';
import { plansCollect, plansStamp } from './commands/plans.ts';
import { prCreate, prRefresh, prUpdate } from './commands/pr.ts';
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
  // Not a reporting command, and the one entry here that is not. It needs the root and the id
  // and nothing else -- and a config too broken to parse is exactly the moment somebody needs
  // developer mode to fix it. Requiring a valid one would make a typo a lockout.
  'claude',
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
  .command('browse')
  .summary("Open a clone's ticket or pull request in the browser")
  .description(
    [
      "Opens what a clone's branch says it is working on: the tracker issue whose key is in the branch name, or the pull request for that branch. `hangar status` prints both as text; this one hands them to the browser.",
      "It is also what a click on the clone's tmux bar runs. tmux cannot put a real hyperlink in a status line, so the bar marks the ticket and the pull request as clickable regions and binds a click to this command — which is why the clone is an argument rather than the one you are standing in.",
      'The pull request is asked of Bitbucket only when it is not already known, and the answer is remembered per branch. That is what lets the bar name the number without ever making the network call itself, and it means the first `browse pr` on a new branch is the slow one.',
    ].join('\n\n'),
  )
  .argument('<what>', 'ticket or pr')
  .argument('<clone>', 'clone name, e.g. clone_02 (or just 2)')
  .option('-n, --dry-run', 'print the URL and open nothing')
  .action(async (what, clone, options) => {
    await browse(requireHangar(), what, clone, options);
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
  .command('close')
  .summary('Close a clone: its editor window, its Claude session and its tmux session')
  .description(
    [
      "The other end of `hangar open`. The editor window is closed, the clone's tmux session is killed — every window in it, and the Claude Code session running in one of them — and the plans that session cannot collect for itself are collected.",
      'There is **one tmux server per hangar, not one per clone**, so this kills the clone SESSION and never the server: `kill-server` would end every other clone in the fleet. The server goes away on its own once its last session closes, which is also what makes the next `hangar open` read a freshly generated conf.',
      'It refuses to close the clone whose own session you typed this in — that would kill the terminal mid-command — and `--force` is the way past that. Anything else worth knowing (a live Claude session, a dev server that dies with it) is named in one confirmation, which `-y` skips.',
      'Closing an editor window needs macOS and Accessibility permission for the terminal `hangar` runs from. Without either, the window stays open and the command says so, in one line, and does everything else.',
    ].join('\n\n'),
  )
  .argument('[clones...]', 'clone names, e.g. clone_02 (or just 2) — closed in ascending order')
  .option('--all', 'close every clone in the fleet')
  .option('--no-editor', 'leave every editor window open')
  .option('-y, --yes', 'do not ask, even when a live session or a dev server dies with it')
  .option('--force', "close it even when this command is running inside that clone's session")
  .option('-n, --dry-run', 'print every decision and close nothing')
  .action((clones: string[], options: CloseOptions) => {
    closeClones(requireHangar(), clones, options);
  });

program
  .command('reload')
  .summary('Put an open clone back on current config, without closing it')
  .description(
    [
      'Re-executes `clone-tmux.conf` on the live tmux server, restarts each idle shell so it re-runs direnv and picks up the current PATH and prompt, and restarts Claude Code in the same conversation it was already in — so a config change reaches a clone you are working in.',
      '**This is the path `kill-server` used to be the only answer for.** `colours sync` writes the bar onto a running server but cannot reach a SERVER option, and two of the four settings Claude Code needs inside tmux are server options. `source-file` re-executes the whole conf, `set -s` included, with nothing interrupted. `extended-keys` and `focus-events` are negotiated when a client attaches, so those two still want the tab reopened.',
      "A pane running anything other than a shell — a dev server, a test run — is left alone and named. Claude Code's pane is the exception: it is what holds the settings and `CLAUDE.md` read once at start-up, so it is restarted with `--resume <session-id>` and the conversation continues. `--no-claude` leaves it running and `--no-shells` leaves the shells alone.",
    ].join('\n\n'),
  )
  .argument('[clones...]', 'clone names, e.g. clone_02 (or just 2) — reloaded in ascending order')
  .option('--all', 'reload every open clone in the fleet')
  .option('--no-shells', 'leave every idle shell pane as it is')
  .option('--no-claude', 'leave Claude Code running, on the settings it started with')
  .option('--no-editor', "do not rewrite the editors' per-clone artifacts")
  .option('-y, --yes', 'do not ask before restarting Claude Code')
  .option('-n, --dry-run', 'print every decision and reload nothing')
  .action((clones: string[], options: ReloadOptions) => {
    reloadClones(requireHangar(), clones, options);
  });

/*
 * `hangar claude` -- both hangar-root modes and a shell, three tabs of one tmux window.
 *
 * Registered unlike every other command here, and each departure is forced by what the command
 * IS: a wrapper whose arguments belong to another program.
 *
 * - `.allowUnknownOption()` and `.allowExcessArguments()`, because claude's whole flag surface
 *   arrives here and commander must not refuse a flag it has never heard of.
 * - `.helpOption(false)`, because `--help` has to reach the action -- it prints CLAUDE's help
 *   with hangar's one added row folded in, which commander's own help page cannot do.
 * - the action reads `process.argv` rather than its parameters. Commander cannot keep
 *   `--model sonnet` together without also breaking `--resume <id> -m dev`; `claudeArgvFromProcess`
 *   says why, and `sync`'s `forcedStrategy` is the existing precedent for the route.
 *
 * The options below are therefore DOCUMENTATION, not parsing -- `splitClaudeArgv` is what reads
 * them. Declared anyway so `hangar --help` lists them, and `-n` is deliberately absent: it is
 * claude's own `--name`, so the dry run is spelled out in full here.
 */
program
  .command('claude')
  .summary('Open both hangar-root Claude sessions, and a shell, in one tmux window')
  .description(
    [
      'Start the two sessions a hangar root has — operator, which drives the fleet, and developer, which changes the CLI — as two tabs of one tmux window, with a third tab holding a plain shell at the hangar root, and attach this terminal to them. The operator tab is selected; `-m dev` selects the other, and `C-b 3` reaches the shell. Each mode tab says in the header what it is for.',
      'Every other argument is passed straight through to `claude`, so `hangar claude --resume <id> -m ops` resumes that session back into operator mode, with its permissions and its remit in force. A bare `claude --resume` of the same session comes back in no mode at all.',
      'The pair is a singleton: one operator tab and one developer tab, on a tmux socket of their own so a bare `tmux -L hangar-<id> ls` still lists exactly the clones. A tab whose claude has exited is simply gone and is recreated by the next run — which is when passed-through arguments can be honoured. `--replace` is for when it cannot: it ends the claude in that tab, and asks first. The shell tab is not a mode: it takes no `-m`, carries no permission rules, and is recreated the same way after an `exit`.',
      'From the hangar root, a bare `claude` reaches this command. Inside a clone it does not, and neither does this: a clone shell gets the real binary. Run from the shell tab, where `claude` is also on PATH, it does everything but re-attach — the client is already here, so it selects the tab and says so.',
    ].join('\n\n'),
  )
  .allowUnknownOption()
  .allowExcessArguments()
  .helpOption(false)
  .argument('[claude-args...]', 'anything claude takes — passed through untouched')
  .option('-m, --mode <ops|dev>', 'which tab this session runs in', 'ops')
  .option('--replace', 'end the claude already in that tab and start this one in its place')
  .option('--yes', 'do not ask before --replace ends a session')
  .option('--dry-run', 'report what would be created and change nothing')
  .action(() => {
    claude(requireHangar(), { argv: claudeArgvFromProcess(process.argv.slice(2)) });
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

/*
 * Registered with a variadic positional it deliberately does NOT read for the snippet.
 *
 * Commander swallows `--` and merges everything after it into `[clones...]`, so
 * `exec 1 3 -- git status -sb` reaches the action as `["1","3","git","status","-sb"]` -- a clone
 * ref and a snippet word are the same thing to it. `splitExecArgv` re-reads `process.argv` and
 * splits at the `--` itself, which is the house route for pass-through argv (`claude`, `sync`'s
 * `forcedStrategy`, `merge-default`).
 *
 * No `.allowUnknownOption()`: measured, commander already treats `--oneline` and `--watch` AFTER
 * a `--` as operands rather than unknown options, so the ordinary registration is enough.
 */
program
  .command('exec')
  .description("Run a shell snippet in selected or all clones, in each clone's root")
  .argument(
    '[clones...]',
    'clone names or indexes, e.g. 1 3 (everything after `--` is the snippet)',
  )
  .option('-a, --all', 'every clone')
  .option('-n, --dry-run', 'print what would run, and where, without running it')
  .option('--no-direnv', "do not load each clone's own direnv environment first")
  .option('--serial', 'one clone at a time, streaming live, in index order')
  .option('-j, --jobs <n>', 'how many clones to run at once (default: all of them)')
  .addHelpText(
    'after',
    [
      '',
      'Everything after `--` is the snippet, joined with single spaces and handed to your',
      'own $SHELL with -i, so your shell functions and aliases are available.',
      '',
      '  hangar exec --all -- git status -sb',
      '  hangar exec 1 3 -- git fetch --prune',
      '',
      'Quote the whole snippet as one argument when spacing matters -- your shell splits argv',
      'before hangar sees it:',
      '',
      '  hangar exec --all -- \'grep "two words" .\'',
      '',
      'An interactive shell costs several seconds to start, so clones run in parallel and each',
      "clone's output is printed as a block when it finishes. --serial streams instead.",
      'Snippets that prompt for input are not supported: stdin is closed in both modes.',
    ].join('\n'),
  )
  .action(async (_clones: string[], options) => {
    // Not `slice(3)`: the global `--hangar <path>` may precede the command, which would shift
    // it. The command token is the first bare `exec` in argv, and any `exec` inside the snippet
    // necessarily comes after it.
    const { refs, snippet } = splitExecArgv(process.argv.slice(process.argv.indexOf('exec') + 1));
    await exec(requireHangar(), refs, snippet, options);
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

const pr = program
  .command('pr')
  .description(
    "A clone branch's pull request: open one, rewrite your own, or refresh what is known",
  );

pr.command('refresh')
  .summary("Ask the forge about a clone's pull request and cache the answer")
  .description(
    "Asks Bitbucket what the clone's current branch has open -- the number, whether it is a draft, its build status and where its reviews stand -- and writes it where the clone bar reads it.\n\nThe bar spawns this itself, detached, whenever what it has is older than `forge.prCacheTtlSeconds`, so it is rarely typed. Run it by hand when the bar is saying something surprising and you want to see the answer come back.",
  )
  .argument('[clones...]', 'clone names or indices')
  .option('-a, --all', 'every clone')
  .option('--force', 'ask even when the cached answer is still fresh')
  .option('-n, --dry-run', 'show which clones would be asked, change nothing')
  .option('-q, --quiet', "say nothing but warnings (for the status bar's own spawn)")
  .action(async (clones: string[], options) => {
    await prRefresh(requireHangar(), clones, options);
  });

/*
 * `create` and `update` take ONE clone and default to the clone you are standing in, unlike
 * `refresh` above, which takes a list and an `--all`. That is not an inconsistency: refreshing a
 * cache six times is six harmless reads, and opening six pull requests is not something anybody
 * means by one command. `src/commands/pr.ts` has the rest of the reasoning.
 */
pr.command('create')
  .summary('Open the pull request this branch does not have yet')
  .description(
    "Opens a pull request on Bitbucket from the clone's current branch, unless the branch already has one open -- in which case it says which and changes nothing, so it is safe to run twice.\n\nThe title and description come from the description file the repo's own agent writes into the shared tmp/ store; when there is none, or it was written before the branch's last commit, `forge.prDescriptionPrompt` is run as a headless Claude Code session in that clone to write one. IT OPENS A DRAFT: pass --ready to open it ready for review, which notifies its reviewers.\n\nThe clone comes from where the command is run: inside a clone the argument may be left out, and naming a DIFFERENT clone is refused.",
  )
  .argument('[clone]', 'clone name or index — defaults to the clone you are in')
  .option('--onto <branch>', 'target branch (default: the repo default branch)')
  .option('--title <text>', "use this title instead of the description file's heading")
  .option('--file <path>', 'take the title and body from this file instead')
  .option('--ready', 'open it ready for review instead of as a draft')
  .option('--no-describe', 'refuse instead of writing a missing or out-of-date description')
  .option('--include-busy', 'write a description in a clone that has a live session')
  .option('-y, --yes', 'do not ask before opening it')
  .option('-n, --dry-run', 'say what would be opened, create nothing')
  .action(async (clone: string | undefined, options) => {
    await prCreate(requireHangar(), clone, options);
  });

pr.command('update')
  .summary('Rewrite the title, description or draft state of your OWN pull request')
  .description(
    "Replaces the title and description of the pull request open for this clone's branch, from the same description file `pr create` uses.\n\nONLY ON PULL REQUESTS YOU OPENED. Bitbucket lets anyone with write access rewrite anyone's; this refuses unless the token owner is the author, and refuses too when it cannot tell whose it is.\n\nThe draft state is left exactly as it is unless --draft or --ready says otherwise. --keep-title and --keep-body each hold one half back.",
  )
  .argument('[clone]', 'clone name or index — defaults to the clone you are in')
  .option('--title <text>', "use this title instead of the description file's heading")
  .option('--file <path>', 'take the title and body from this file instead')
  .option('--keep-title', 'leave the title as it is')
  .option('--keep-body', 'leave the description as it is')
  .option('--draft', 'mark it a draft')
  .option('--ready', 'mark it ready for review')
  .option('--no-describe', 'refuse instead of writing a missing or out-of-date description')
  .option('--include-busy', 'write a description in a clone that has a live session')
  .option('-y, --yes', 'do not ask before rewriting it')
  .option('-n, --dry-run', 'say what would change, change nothing')
  .action(async (clone: string | undefined, options) => {
    await prUpdate(requireHangar(), clone, options);
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

program
  .command('mcp')
  .summary("Serve this hangar's commands to a Claude Code session as MCP tools")
  .description(
    [
      'Speaks the Model Context Protocol on stdin and stdout, offering one tool per hangar command. `.claude/modes/mcp.json` names it and `hangar claude` hands that file to Claude Code as `--mcp-config`, so a mode session starts one of these itself.',
      'There is nothing to read here at a terminal: with no client speaking to it, it waits. What it is useful for by hand is a probe -- pipe it an `initialize` and a `tools/list` line and read the replies.',
      'A tool is not a second way to do anything. Each one runs `bin/hangar` exactly as a person would type it, which is why the two can never disagree; what a tool adds is a name of its own, so a permission rule can separate a report from the command that writes.',
    ].join('\n\n'),
  )
  .action(async () => {
    await mcp(requireHangar(), program);
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
    // Every LINE indented, not just the first. Six hints in this CLI are already several lines
    // long (`release`'s preflight, `config/load`'s discovery failure) and each of them printed
    // its first line under the `error:` gutter and the rest hard against the left margin, which
    // reads as two messages rather than one.
    if (error.hint !== undefined) {
      for (const line of error.hint.split('\n')) console.error(`       ${line}`);
    }
    process.exit(1);
  }
  throw error;
};

try {
  await program.parseAsync();
} catch (error) {
  report(error);
}
