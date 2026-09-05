import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Clone } from './fleet.ts';
import { themeName } from './generate/theme-json.ts';
import { isVscodeFork } from './editor/kinds.ts';
import type { Hangar } from './hangar.ts';
import { tildify } from './user-paths.ts';
import { roleUrl, type ClonePort } from './ports.ts';
import { render, type TokenValues } from './template.ts';

/**
 * The per-clone files that are NOT in git and must be recreated whenever a clone is created
 * or re-cloned. Every one of them is derived from the clone's index, so `add-clone` writes
 * them and `doctor --fix` can repair them.
 *
 * CLAUDE.md's warning applies to two of these in particular: `CLAUDE.local.md` and the
 * `.git/info/exclude` line that hides it are a PAIR. A re-clone loses both, and recreating
 * only the first leaves it as untracked noise that eventually gets committed into a branch.
 */

/**
 * The token values available for one clone.
 *
 * `{port}` is absent on purpose: it belongs to a port ROLE, not to a clone, and leaving it out
 * is what makes `render` throw rather than silently produce a truncated value.
 */
export const cloneTokens = (clone: Clone): TokenValues => ({
  id: clone.hangar.id,
  displayName: clone.hangar.config.displayName ?? clone.hangar.id,
  index: String(clone.index),
  index2: String(clone.index).padStart(clone.hangar.config.clones.pad, '0'),
  clone: clone.name,
  root: clone.path,
  secretsFile: clone.hangar.paths.envShared,
});

export const envLocalPath = (clone: Clone): string =>
  join(clone.path, clone.hangar.config.repo.cloneEnv.file);
export const envrcPrivatePath = (clone: Clone): string => join(clone.path, '.envrc.private');
export const claudeLocalMdPath = (clone: Clone): string => join(clone.path, 'CLAUDE.local.md');
export const settingsPath = (clone: Clone): string =>
  join(clone.path, '.claude', 'settings.local.json');
export const excludePath = (clone: Clone): string => join(clone.path, '.git', 'info', 'exclude');
const workspaceName = (clone: Clone): string =>
  render(
    clone.hangar.config.editor.workspaceFileName,
    cloneTokens(clone),
    'editor.workspaceFileName',
  );

/**
 * Whether any configured editor reads a `*.code-workspace` file at all.
 *
 * The workspace file is a VS Code artifact in the same way `editor.rootPathKeys` is, so it asks
 * the same question the schema's cross-check does -- "is there a kind that CONSUMES it", not "is
 * an editor configured" -- and reuses the same predicate rather than a second list that could
 * disagree with it.
 *
 * **The builders below stay ungated on purpose.** They are pure functions of the clone and are
 * called from inside the VS Code driver, which only exists when a VS Code kind is configured.
 * This is the gate for the three callers that are NOT the driver: `add-clone` writing the file,
 * `doctor` checking and repairing it, and the golden capture recording it. Without it a
 * JetBrains-only or Zed-only hangar got a workspace file per clone for an editor its config says
 * it does not use -- and `doctor --fix` put it back after you deleted it.
 *
 * A hangar whose config will not parse gets `['vscode']` from the schema default and so keeps
 * the file, which is the same fallback `editor/index.ts` documents: with the editors unknown,
 * writing the default editor's artifact is the recoverable answer.
 */
export const wantsWorkspaceFiles = (hangar: Hangar): boolean =>
  hangar.config.editor.kinds.some(isVscodeFork);

/**
 * Every directory of this clone a `*.code-workspace` copy belongs in, from `editor.workspaceDirs`.
 *
 * A list, because VS Code only offers a `*.code-workspace` from the directory you opened, and
 * this repo is opened at its root AND at its app directory -- so the file exists twice,
 * byte-identical. `workspaceDirs: ['.']` is a repo that is only ever opened at its root, which
 * is most of them; it was `['.', 'angular']` hardcoded.
 */
export const workspacePaths = (clone: Clone): string[] =>
  clone.hangar.config.editor.workspaceDirs.map((dir) =>
    join(clone.path, dir === '.' ? '' : dir, workspaceName(clone)),
  );

/** The first (and canonical) workspace copy -- the one at the clone root. */
export const workspacePath = (clone: Clone): string => join(clone.path, workspaceName(clone));

/**
 * The second copy of the workspace file, byte-identical to the first.
 *
 * VS Code only offers `*.code-workspace` files from the directory you opened, and this repo
 * is opened both at its root and at `angular/` -- so the file has to exist in both. Keep
 * them in step with `hangar ide vscode sync`.
 */

/**
 * The symlinks this hangar's config asks for, resolved against one clone.
 *
 * `repo.symlinks[]` has been in the schema since it was written and nothing read it: the one
 * link this fleet needs was hardcoded in `add-clone` and again in `doctor`, so a hangar for
 * another repo could declare a link and watch it be ignored. Each entry's `why` is required by
 * the schema and is printed by both -- nothing in the filesystem explains a symlink, which is
 * the whole reason that field is not optional.
 */
export type CloneSymlink = {
  readonly path: string;
  readonly target: string;
  readonly skipIfDirMissing: boolean;
  readonly why: string;
  readonly relPath: string;
};

export const cloneSymlinks = (clone: Clone): CloneSymlink[] =>
  clone.hangar.config.repo.symlinks.map((link) => ({
    path: join(clone.path, link.path),
    target: render(link.target, cloneTokens(clone), `repo.symlinks target for ${link.path}`),
    skipIfDirMissing: link.skipIfDirMissing,
    why: link.why,
    relPath: link.path,
  }));

/**
 * What `.git/info/exclude` has to hide, and why it cannot be the tracked `.gitignore`:
 * `/CLAUDE.local.md` is generated per clone and must never travel to a sibling.
 *
 * `/tmp` used to be here too, for a `tmp` that was a symlink to the fleet's shared directory:
 * the tracked rule is `tmp/` and a trailing slash matches a directory only, so the link showed
 * up as untracked. `tmp/` is a real directory again -- only the cache entries INSIDE it are
 * links -- so the tracked rule covers it and this list is back to one line. An existing clone
 * that still carries the `/tmp` line is fine; it excludes something already ignored.
 */
export const EXCLUDE_LINES = ['/CLAUDE.local.md'] as const;
export const EXCLUDE_LINE = EXCLUDE_LINES[0];
/**
 * A FUNCTION, not a constant, and this is one of the five that had to change when the hangar
 * root stopped being known at import time. It embeds the root in text written into a live
 * clone's `.git/info/exclude`; evaluated at import it would have captured whatever the CLI's own
 * location happened to be -- a wrong absolute path that typechecks, lints, and is invisible
 * until someone reads the file.
 */
export const excludeBlock = (hangar: Hangar): string =>
  [
    '',
    `# Per-clone Claude Code identity (hangar: ${tildify(hangar.root)})`,
    ...EXCLUDE_LINES,
    '',
  ].join('\n');

/** The lines `.git/info/exclude` is missing, so `doctor` can append only what is absent. */
export const missingExcludeLines = (exclude: string): string[] => {
  const present = new Set(exclude.split('\n').map((line) => line.trim()));
  return EXCLUDE_LINES.filter((line) => !present.has(line));
};

/**
 * How a session inside a clone asks for a port at run time, as a pasteable command.
 *
 * `repo.portCheckCommand` is the REPO's own resolver and the source of truth: it runs inside the
 * clone, where direnv has loaded that clone's dotenv, so it answers for the checkout you are
 * standing in. Hangar asks it rather than reimplementing it, for the same reason it asks the
 * tracker's own namer script rather than reproducing its filenames.
 *
 * A hangar that declares none falls back to `hangar ports`, which is always on PATH and always
 * correct but answers for the FLEET rather than for one clone. That is the honest degradation
 * and it is why this is not optional text: `node dev/ports.mjs` was hardcoded here, so every
 * clone of every hangar was told to run one repo's script -- a command that does not exist,
 * printed by the file whose whole job is to keep a session from guessing a port.
 */
export const portCheckHint = (hangar: Hangar): string =>
  hangar.config.repo.portCheckCommand?.join(' ') ?? 'hangar ports';

/**
 * A representative issue key, for prose that has to SHOW a cached filename rather than describe
 * one. Takes the first declared prefix; `tracker.keyPrefixes` is optional (absent means the open
 * pattern), so an unconfigured tracker still gets a key-shaped example rather than a real one
 * from somebody else's project.
 */
export const exampleIssueKey = (hangar: Hangar): string =>
  `${hangar.config.tracker.keyPrefixes?.[0] ?? 'ABC'}-1234`;

export const envLocalContent = (clone: Clone): string => {
  const { rootPathEnvKey } = clone.hangar.config.repo.cloneEnv;
  return [
    '# Per-clone values ONLY. Secrets shared by every clone live one level up in',
    `# ${tildify(clone.hangar.paths.envShared)}, loaded by this clone's .envrc.private before this file`,
    '# (so anything set here still overrides the shared value).',
    '#',
    '# Ports must differ per clone: two clones sharing a dev server means a test run in one',
    `# silently verifies the other one's code. Check with \`${portCheckHint(clone.hangar)}\`.`,
    '#',
    `# Generated by \`hangar add-clone\` from the clone index (${clone.index}); repair a drifted`,
    '# value with `hangar doctor --fix` rather than by hand.',
    '',
    ...(rootPathEnvKey === undefined ? [] : [`${rootPathEnvKey}='${clone.path}'`, '']),
    ...clone.ports.map((entry) => `${entry.role.envKey}=${String(entry.port)}`),
    // Whatever else a clone needs to itself: its own database, its own container set. Rendered
    // from the index like the ports, so adding a clone needs no bookkeeping here either.
    ...Object.entries(clone.hangar.config.repo.cloneEnv.vars).map(
      ([key, template]) =>
        `${key}=${render(template, cloneTokens(clone), `repo.cloneEnv.vars.${key}`)}`,
    ),
    '',
  ].join('\n');
};

export const envrcPrivateContent = (hangar: Hangar): string =>
  [
    '## Private direnv config for this clone -- gitignored, never committed.',
    '#',
    '# It sets no variables of its own. Two dotenv files do that:',
    '#',
    `#   ${tildify(hangar.paths.envShared)}  -- secrets identical in every clone (loaded below)`,
    `#   ./${hangar.config.repo.cloneEnv.file}  -- this clone's own ports and per-clone values`,
    '#',
    '# The file is kept because it is the only gitignored, per-clone shell hook that direnv',
    '# already sources (`.envrc` is tracked and shared, so this load cannot live there).',
    '#',
    '# ABSOLUTE paths on purpose. A repo whose `.envrc` sources this file from a SUBDIRECTORY',
    '# resolves a relative path against that subdirectory, where `dotenv_if_exists` finds',
    '# nothing and says nothing. Do not "simplify" them to relative paths.',
    '#',
    `# Loaded here, which is BEFORE this clone's own \`${hangar.config.repo.cloneEnv.file}\` -- so`,
    '# that file still wins for anything set in both.',
    '',
    envrcDotenvLine(hangar),
    `watch_file "${envSharedShellRef(hangar)}"`,
    '',
    '# The fleet orchestration CLI. direnv loads the nearest .envrc only, so this clone never',
    "# inherits the fleet root's PATH_add -- it has to be repeated here for `hangar` to be",
    '# callable by name from inside the clone. Managed by `hangar add-clone`; repair it',
    '# with `hangar doctor --fix`.',
    `PATH_add "${fleetBinShellRef(hangar)}"`,
    '',
  ].join('\n');

/** The fleet's `bin/`, as `$HOME/...` so the file reads the same on any machine. */
const fleetBinShellRef = (hangar: Hangar): string =>
  join(hangar.root, 'bin').replace(process.env['HOME'] ?? '~', '$HOME');

/**
 * The literal dotenv line, so `doctor` can assert on exactly what the generator writes.
 *
 * Its counterpart below exists for the same reason, and both are here rather than reconstructed
 * in `doctor`: a second spelling of a line one of them writes is how a check ends up green
 * against a file that says something else.
 */
export const envrcDotenvLine = (hangar: Hangar): string =>
  `dotenv_if_exists "${envSharedShellRef(hangar)}"`;

/** The literal PATH line, so `doctor` can assert on exactly what the generator writes. */
export const fleetBinPathLine = (hangar: Hangar): string =>
  `PATH_add "${fleetBinShellRef(hangar)}"`;

/** `$HOME/...` rather than a literal home path, matching the existing clones. */
const envSharedShellRef = (hangar: Hangar): string =>
  hangar.paths.envShared.replace(process.env['HOME'] ?? '~', '$HOME');

/**
 * A markdown table padded the way Prettier pads one.
 *
 * Not cosmetic: the clone's own `npm run md:check` globs `../**\/*.md` from `angular/`, and
 * `.git/info/exclude` hides this file from git, not from Prettier. An unpadded table put the
 * generated identity file into that repo's pre-existing formatting debt, where it looked like
 * the branch's doing and could not be fixed by anyone -- a clone agent that reformatted it
 * would then trip `doctor`'s content check instead.
 */
const paddedTable = (rows: readonly (readonly [string, string])[]): string[] => {
  const width = (column: 0 | 1): number =>
    rows.reduce((max, row) => Math.max(max, row[column].length), 0);
  const widths = [width(0), width(1)] as const;
  const line = (cells: readonly [string, string]): string =>
    `| ${cells[0].padEnd(widths[0])} | ${cells[1].padEnd(widths[1])} |`;
  return [
    line(['', '']),
    `| ${'-'.repeat(widths[0])} | ${'-'.repeat(widths[1])} |`,
    ...rows.map(line),
  ];
};

/**
 * The clone's identity file -- who this session is, and the handful of things that are true of
 * IT rather than of the fleet.
 *
 * A pure function of the clone, like every other per-clone artifact -- in particular it does NOT
 * enumerate the siblings. It used to, and `doctor`'s content check would then have turned every
 * `add-clone` and `remove-clone` into a fleet-wide red report until someone re-ran `--fix`: a
 * check that is red in normal operation is a check nobody reads.
 *
 * The fleet's own `CLAUDE.md` is already in this session's context (Claude Code walks every
 * ancestor directory), so nothing here repeats a fleet rule. What it adds is second-person:
 * text that arrives in this session unbidden, a shared directory inside this checkout, and the
 * commands that would sync the very tree the reader is editing.
 */
export const claudeLocalMdContent = (clone: Clone): string => {
  return [
    `# This clone: ${clone.name} (${clone.colour.name})`,
    '',
    `You are working in **\`${clone.name}\`**, one of the sibling clones under \`${tildify(clone.hangar.root)}/\`.`,
    `Announce yourself as **${clone.colour.name}** when the user needs to tell your session apart from`,
    'the others.',
    '',
    'Your colour is wired the same way as every other clone: the shared statusline script',
    `\`${tildify(clone.hangar.paths.statuslineScript)}\` (it derives the hue from this directory) plus the theme`,
    `\`~/.claude/themes/${themeName(clone)}.json\`, both selected in this clone's untracked`,
    '`.claude/settings.local.json`. The status line shows the colour in every permission mode; the',
    'input-box border only does in Manual mode, which is expected — see the shared memory',
    '`clone-colour-identity` before "fixing" it.',
    '',
    ...paddedTable([
      ['Root', `\`${clone.path}\``],
      ['Colour', clone.colour.name],
      ...clone.ports.map((entry): [string, string] => [entry.role.label, String(entry.port)]),
    ]),
    '',
    `These ports are **yours alone**. They come from this clone's untracked \`${clone.hangar.config.repo.cloneEnv.file}\`; resolve`,
    `them at run time with \`${portCheckHint(clone.hangar)}\` rather than typing a number. A server answering on`,
    'any other port in those families belongs to a sibling — never test against it, never restart',
    'it, never kill it.',
    '',
    `Your siblings are the other \`${clone.hangar.config.clones.prefix}<NN>/\` directories beside this one, each also a git remote of`,
    'that same name for cherry-picking (`hangar list`, or `git remote`). Their working trees are',
    'off limits for writes. Which clones exist is deliberately not written down anywhere, this file',
    'included — the fleet adds and removes them without bookkeeping.',
    '',
    `See \`../CLAUDE.md\` for the fleet rules; this clone's own \`CLAUDE.md\` and \`AGENTS.md\` are`,
    'authoritative for everything about the project itself.',
    '',
    '## If a `SYNC PAUSE` line appears in your input',
    '',
    'The user can sync this clone while you are working, and `hangar sync` has no way to message',
    'a running session except to type into its terminal. So two lines may arrive that the user did',
    'not write: `SYNC PAUSE`, then exactly one `SYNC FINISHED` or `SYNC ABORTED` saying what state',
    'the working tree was left in. On a pause, stop, say that you have paused, and wait — while it',
    'runs, a separate headless Claude Code run may be resolving conflicts in this very tree, and two',
    'agents editing one file is the failure the pause exists to prevent.',
    '',
    'Stopping is always safe, so treat the pause as genuine. Resuming is not: if the closing line',
    'never comes, or describes a tree that does not match what you find, or a `SYNC FINISHED` shows',
    'up with no pause before it, tell the user rather than picking up where you left off.',
    '',
    '## `tmp/` is shared with the whole fleet',
    '',
    `Every \`tmp/<name>\` entry is a symlink into \`${tildify(clone.hangar.root)}/tmp/\`, so anything`,
    'you write there is written for the whole fleet.',
    '',
    // The hard-link warning is about the TRACKER's record store, so a hangar with no tracker
    // must not be shown a cached filename it will never have. The rule above it holds either
    // way, and is what stays.
    ...(clone.hangar.config.tracker.kind === 'none'
      ? [
          'Files under it may also be **hard links** to one shared inode, so editing one in place',
          "can rewrite every clone's copy and you cannot tell from inside the clone. Regenerate",
          'them rather than hand-editing them; the links are not damage, so leave them alone.',
        ]
      : [
          `Each cached issue record is normally a **hard link** to one file the whole fleet shares — so`,
          `editing \`tmp/${exampleIssueKey(clone.hangar)}/ticket_${exampleIssueKey(clone.hangar)}.md\` in place may rewrite every clone's copy of it, and`,
          'you cannot tell from inside the clone (a re-sync detaches that one file until the next',
          '`tmp merge`). Read those files and regenerate them with the skill; never hand-edit one.',
          'The links are not damage, so leave them alone.',
        ]),
    '',
    'Dev-server PID files are the exception: they are real files, they stay in this clone, and',
    'they are why `tmp/` itself is never a symlink.',
    '',
    '## `hangar` is on your PATH — read with it, do not sync with it',
    '',
    'Reading is free and often the right move: `hangar list`, `hangar ports`, and',
    '`hangar status <N>` to see what a sibling is up to before you read its tree.',
    '',
    `But \`hangar sync ${String(clone.index)}\` — this clone — starts with a`,
    '`git stash push --include-untracked` of the tree you are working in, and the busy-clone skip',
    'applies only to `--all`, so naming a clone explicitly does not protect it. It would then type',
    'the pause message above into this very session. `merge-default` and `rebase-default` are that',
    'same command under another name, so they do all of it too. `checkout-default` would switch',
    'this working tree to the default branch and sends no pause message at all — the only thing',
    'standing in front of it is a question put to whoever is at the terminal. `open` does that',
    'same checkout before it opens a tab, so it is not only a window either. Those and',
    "`remove-clone` are the user's to run, from the fleet root.",
    '',
    'This file is local to this clone, generated by `hangar`, and excluded via',
    '`.git/info/exclude` — it never commits and never travels to a sibling. Do not hand-edit it:',
    '`hangar doctor --fix` rewrites it whenever it differs from what the generator produces. For',
    "the same reason, nothing fleet-specific belongs in this clone's tracked `.claude/` — that",
    'directory ships to every other contributor, who has one checkout and no fleet.',
    '',
  ].join('\n');
};

export const workspaceContent = (clone: Clone): string =>
  `${JSON.stringify(
    {
      settings: { 'yaml.maxItemsComputed': 25000 },
      folders: [
        {
          name: render(
            clone.hangar.config.editor.workspaceFolderLabel,
            cloneTokens(clone),
            'editor.workspaceFolderLabel',
          ),
          path: clone.path,
        },
      ],
    },
    null,
    2,
  )}\n`;

/**
 * The health-check permission for one role, which embeds that role's own port.
 *
 * Per ROLE now, not per clone: `ports.roles[].healthCheck` says which roles want one and with
 * what timeout and path, so a hangar with three servers gets three allows and a hangar with none
 * gets none. It used to be hardcoded to Storybook -- one allow, one port, one product.
 */
export const healthCheckAllow = (entry: ClonePort): string | undefined => {
  const check = entry.role.healthCheck;
  if (check === undefined) return undefined;
  const url = roleUrl(entry);
  if (url === undefined) return undefined;
  return `Bash(curl -s -o /dev/null -w "%{http_code}" --max-time ${String(check.timeoutSeconds)} ${url}${check.path})`;
};

/** Every health-check allow this clone's roles ask for, in config order. */
export const healthCheckAllows = (clone: Clone): string[] =>
  clone.ports.map((entry) => healthCheckAllow(entry)).filter((x) => x !== undefined);

/*
 * Matches a health-check allow THIS generator wrote, and nothing else.
 *
 * It stays anchored to the exact template rather than loosening to "any curl allow", for the
 * original reason: a looser pattern would also match a hand-written curl permission, and
 * replacing the wrong one leaves a health check pointed at another clone's port -- exactly the
 * silent cross-clone verification the per-clone ports exist to prevent. What widened is only
 * the timeout and the path, because those now come from each role's `healthCheck` instead of
 * being fixed at 3 seconds and no path.
 */
const HEALTH_CHECK_RE =
  /^Bash\(curl -s -o \/dev\/null -w "%\{http_code\}" --max-time \d+ https?:\/\/[^\s)]+\)$/;

export type HookEntry = { type: string; command: string; timeout?: number };
export type HookMatcher = { matcher?: string; hooks: HookEntry[] };

export type SettingsJson = {
  theme?: string;
  /** Must resolve INSIDE the clone -- Claude Code rejects a path that escapes the project root. */
  plansDirectory?: string;
  hooks?: Record<string, HookMatcher[]>;
  permissions?: { allow?: string[]; deny?: string[] };
  [key: string]: unknown;
};

/**
 * The `SessionEnd` hook that keeps the shared plan archive current.
 *
 * Claude Code will not write plans outside the project root -- it resolves `plansDirectory`
 * against the root and rejects anything that escapes it, symlinks followed -- so a clone
 * cannot write into `<fleet>/plans` however the setting is spelled. The clone writes to its
 * own `.claude/plans`, and this hook sweeps a session's plan into the shared archive the
 * moment that session ends, which is also the first moment it is safe to move: nothing can
 * rewrite it any more.
 *
 * It lives in the untracked per-clone settings, not in the repo: it names an absolute path in
 * this fleet, and a teammate with a single checkout has nothing to collect into.
 */
/**
 * Does this hook command invoke THIS hangar's CLI with this subcommand, whatever the binary was
 * called at the time it was written?
 *
 * The distinction matters exactly once per rename, and it is invisible when it goes wrong. The
 * `with*Hook` writers replace by filtering the existing matchers, so a filter keyed on the
 * CURRENT command string leaves a matcher naming yesterday's binary untouched and appends a
 * second one beside it. Every clone then carries a dead hook -- and the Jira one is designed to
 * fail open, so it would never say a word about the path not existing.
 *
 * Matching on the hangar's own `bin/` directory plus the subcommand is what survives a rename:
 * `bin/orch-util jira hook` and `bin/hangar jira hook` are both recognised as ours, while
 * a different subcommand is not.
 *
 * **The second arm is what survives a MOVE of the hangar root**, and it was added because a test
 * against a template from another root showed the first arm alone appending beside the stale
 * matcher instead of replacing it -- so a moved fleet ended up with two `SessionEnd` collectors
 * and, worse, two `PreToolUse` Jira hooks, one of them a path that is not there. `bin/hangar`
 * exits 0 silently for `jira hook` precisely because a non-zero `PreToolUse` exit BLOCKS the
 * tool call; a matcher naming a binary that no longer exists cannot exit 0 at all.
 *
 * `<abs>/bin/<binary> --hangar <path> <subcommand>` is a shape only this CLI emits, and a clone
 * belongs to exactly one hangar -- it lives inside that hangar's root -- so a matcher in a
 * clone's settings naming some OTHER root is always this hangar's own stale one, never a
 * neighbour's live one.
 *
 * It is a REGEX anchored at the start rather than two `includes`, and that is the difference
 * between widening it and breaking it. `subcommand` is matched as a substring, so a bare
 * `includes(' --hangar ')` would also have swallowed a hook a developer wrapped themselves --
 * `sh -c '... && /other/bin/hangar --hangar /other tmp merge'` -- which is theirs to keep. The
 * anchor means only a command that IS the invocation qualifies, never one that contains it.
 *
 * The `has*Hook` readers deliberately do NOT use this: they answer "is the hook `doctor` would
 * write already in place", so a stale one has to read as a PROBLEM rather than as fine.
 */
const MOVED_ROOT_INVOCATION = /^\/\S*\/bin\/\S+ --hangar \S+ /;

const invokesOurCli = (hangar: Hangar, command: string | undefined, subcommand: string): boolean =>
  command !== undefined &&
  command.includes(subcommand) &&
  (command.startsWith(`${join(hangar.root, 'bin')}/`) || MOVED_ROOT_INVOCATION.test(command));

export const plansHookCommand = (hangar: Hangar): string =>
  `${hangar.paths.bin} --hangar ${hangar.root} plans collect --quiet`;

const plansHook = (hangar: Hangar): HookMatcher => ({
  hooks: [{ type: 'command', command: plansHookCommand(hangar), timeout: 60 }],
});

export const hasPlansHook = (hangar: Hangar, settings: SettingsJson | undefined): boolean =>
  (settings?.hooks?.['SessionEnd'] ?? []).some((matcher) =>
    matcher.hooks.some((hook) => hook.command === plansHookCommand(hangar)),
  );

/**
 * The `PreToolUse` hook that serves a Jira ticket from the shared record store.
 *
 * Untracked for the same reason as the plan collector, and a stronger one: the clones' `.claude`
 * is shared with every other contributor and has to work without this fleet, so nothing about
 * the record store can be in a tracked file. The matcher is `Bash` because that is how the
 * skill's sync script is invoked; the hook itself decides whether the command is one it knows,
 * and fails open on everything else.
 *
 * Additive, not a replacement: Claude Code merges the tracked settings' hooks with these, so
 * the repo's own `PreToolUse` guard still runs.
 */
export const jiraHookCommand = (hangar: Hangar): string =>
  `${hangar.paths.bin} --hangar ${hangar.root} jira hook`;

const jiraHookMatcher = (hangar: Hangar): HookMatcher => ({
  matcher: 'Bash',
  hooks: [{ type: 'command', command: jiraHookCommand(hangar), timeout: 30 }],
});

/** The hook, wired exactly as this hangar would write it today. */
export const hasJiraHook = (hangar: Hangar, settings: SettingsJson | undefined): boolean =>
  (settings?.hooks?.['PreToolUse'] ?? []).some((matcher) =>
    matcher.hooks.some((hook) => hook.command === jiraHookCommand(hangar)),
  );

/**
 * A jira hook of OURS in any form, which is a deliberately weaker question than `hasJiraHook`.
 *
 * The two are not interchangeable and picking the wrong one is silent. `hasJiraHook` is exact
 * equality, which is right where the answer decides whether to REWRITE: a command that has
 * drifted from what this hangar would write -- an older form with no `--hangar`, or one left
 * behind by a hangar-root move -- should be rewritten, so reporting it as absent is correct
 * there. It is wrong where the answer decides whether something must be REMOVED: `withJiraHook`
 * strips by `invokesOurCli`, so an exact-equality check would report "correctly absent" about a
 * stale hook sitting right there that its own repair would then delete. Doctor's report and
 * doctor's fix would disagree, which is the failure this pair exists to make impossible.
 */
export const hasAnyJiraHook = (hangar: Hangar, settings: SettingsJson | undefined): boolean =>
  (settings?.hooks?.['PreToolUse'] ?? []).some((matcher) =>
    matcher.hooks.some((hook) => invokesOurCli(hangar, hook.command, 'jira hook')),
  );

/**
 * Reconcile the jira hook with what the config declares -- add it, or take it away.
 *
 * **This is the one place that decides whether a clone carries the hook at all**, which is why
 * the gate is here and not at the four call sites (`defaultSettings`, `settingsContentFor`,
 * `doctor`'s repair and the golden capture's template). A gate at the call sites is one someone
 * adds a fifth caller without.
 *
 * Filter-then-append is what makes the jira -> none transition repairable rather than merely
 * un-made: a hangar that switches its tracker off still has the hook wired in every clone, where
 * it is inert (`jiraHook` declines on `kind: none`) but spawns a Node process on every Bash tool
 * call forever. Dropping the append turns the existing filter into the removal, so `doctor --fix`
 * repairs both directions through this one function.
 */
export const withJiraHook = (hangar: Hangar, settings: SettingsJson): SettingsJson => {
  const hooks = { ...settings.hooks };
  const existing = (hooks['PreToolUse'] ?? []).filter(
    (matcher) => !matcher.hooks.some((hook) => invokesOurCli(hangar, hook.command, 'jira hook')),
  );
  if (hangar.config.tracker.kind !== 'none') {
    hooks['PreToolUse'] = [...existing, jiraHookMatcher(hangar)];
  } else if (existing.length > 0) {
    hooks['PreToolUse'] = existing;
  } else {
    // Not `[]`: an empty array is a `PreToolUse` key in every tracker-less clone's settings
    // promising a hook that is not there, and it would differ from a clone that never had one.
    delete hooks['PreToolUse'];
  }
  return { ...settings, hooks };
};

/**
 * The `SessionEnd` hook that folds this clone's new Jira cache entries into the shared store.
 *
 * A re-sync of a ticket that already has a `tmp/<KEY>` directory writes straight into the
 * store -- that path is a symlink -- so what this catches is the two cases that need a move: a
 * brand-new ticket directory, created inside the clone by `dirFor`'s `mkdirSync`, and a record
 * whose inode a `writeAtomic` re-sync detached from the store copy.
 *
 * `SessionEnd` rather than a trigger on the write itself, and that is not a compromise: the
 * store pass deliberately leaves alone any copy written in the last two minutes, because a
 * session may be mid-refresh and the pass replaces content. A hook that fired BECAUSE a ticket
 * was just written would arrive inside its own exclusion window every time and do nothing. At
 * session end nothing is mid-write, so the guard never trips.
 *
 * The cost of not having it is bounded and worth knowing: one wasted re-fetch in a sibling.
 * The store is never a wrong answer either way -- `jira hook` reads `fetched_at:` out of the
 * file and refuses to hand back anything older than the copy the clone already holds.
 */
export const tmpHookCommand = (hangar: Hangar): string =>
  `${hangar.paths.bin} --hangar ${hangar.root} tmp merge --quiet`;

const tmpHook = (hangar: Hangar): HookMatcher => ({
  hooks: [{ type: 'command', command: tmpHookCommand(hangar), timeout: 120 }],
});

export const hasTmpHook = (hangar: Hangar, settings: SettingsJson | undefined): boolean =>
  (settings?.hooks?.['SessionEnd'] ?? []).some((matcher) =>
    matcher.hooks.some((hook) => hook.command === tmpHookCommand(hangar)),
  );

export const withTmpHook = (hangar: Hangar, settings: SettingsJson): SettingsJson => {
  const hooks = { ...settings.hooks };
  const existing = (hooks['SessionEnd'] ?? []).filter(
    (matcher) => !matcher.hooks.some((hook) => invokesOurCli(hangar, hook.command, 'tmp merge')),
  );
  hooks['SessionEnd'] = [...existing, tmpHook(hangar)];
  return { ...settings, hooks };
};

/**
 * Settings with the plan-collecting hook in place and no `plansDirectory` override.
 *
 * The override is removed deliberately: the repo's own tracked `.claude/settings.json` already
 * says `.claude/plans`, which is the only value that works, so a per-clone copy of it is one
 * more place to drift.
 */
export const withPlansHook = (hangar: Hangar, settings: SettingsJson): SettingsJson => {
  const { plansDirectory: _dropped, ...rest } = settings;
  const hooks = { ...rest.hooks };
  const existing = (hooks['SessionEnd'] ?? []).filter(
    (matcher) =>
      !matcher.hooks.some((hook) => invokesOurCli(hangar, hook.command, 'plans collect')),
  );
  hooks['SessionEnd'] = [...existing, plansHook(hangar)];
  return { ...rest, hooks };
};

/**
 * The per-clone Claude Code settings a hangar can DERIVE, with no sibling to copy from.
 *
 * This is what unblocked clone #1. `add-clone` used to copy an existing sibling's
 * `settings.local.json` wholesale and throw when there was none -- so the very first clone of a
 * fresh hangar had to be made by hand, which is the one step a stranger cannot be talked through.
 *
 * The split between this and the sibling copy is the interesting part, and it is deliberate:
 *
 * - **DERIVED, here**: the shared secrets deny rule, the read allow for the hangar root, one
 *   health-check allow per role that declares one, the three `SessionEnd`/`PreToolUse` hooks, the
 *   statusline, the shared memory directory and the theme. Every one of them is a function of the
 *   hangar and the clone index, and every one lives outside git -- which is exactly what
 *   `doctor` exists to hold in place.
 * - **PERSONAL, and so sibling-copy-only**: `enabledMcpjsonServers`, `enabledPlugins` and the
 *   `terminal.*` keys. Those are one developer's setup on one machine. Emitting them as defaults
 *   would ship this machine's seven MCP servers to a stranger's fresh hangar, where none of them
 *   resolve -- a config that looks configured and is not, which is the failure this whole track
 *   is about.
 *
 * So `add-clone` still prefers a sibling when there is one (the personal half carries forward,
 * which is what a developer expects of a new clone), and falls back to this. `settingsContentFor`
 * then regenerates the derived half on top either way, so the two paths cannot disagree about a
 * theme or a port.
 */
/*
 * The hangar root is readable, its secrets file is not.
 *
 * The deny rule has to be an ABSOLUTE path: the secrets file sits outside every clone (so that
 * no clone can commit it), which also means no `Read(./**)`-relative rule can reach it. A clone
 * session that could read it would put credentials in a transcript.
 *
 * Both are functions rather than literals in `defaultSettings` because `settingsContentFor` has
 * to be able to ask for the SAME two strings when it reapplies the derived half over a template.
 */
export const hangarRootAllow = (hangar: Hangar): string => `Read(${hangar.root}/**)`;
export const secretsDeny = (hangar: Hangar): string => `Read(${hangar.paths.envShared})`;

export const defaultSettings = (clone: Clone): SettingsJson => {
  const hangar = clone.hangar;
  const base: SettingsJson = {
    permissions: {
      allow: [hangarRootAllow(hangar), ...healthCheckAllows(clone)],
      deny: [secretsDeny(hangar)],
    },
    statusLine: { type: 'command', command: hangar.paths.statuslineScript },
    autoMemoryDirectory: hangar.paths.memory,
  };
  return withTmpHook(hangar, withPlansHook(hangar, withJiraHook(hangar, base)));
};

/**
 * The clone's `.claude/settings.local.json`: the template's PERSONAL half, this hangar's DERIVED
 * half reapplied over it.
 *
 * This used to regenerate `theme` and the health-check allows and nothing else, while its own
 * header claimed it reapplied "the derived half" -- eight things -- "so the two paths cannot
 * disagree". Six of the eight were written once by `add-clone` and never looked at again, and
 * `doctor` held the same two. What that costs shows up at a rename or a move of the hangar root,
 * and it showed up here: after `<id>-clone-…` replaced `dvb-clone-…`, all four clones went on
 * naming `~/.claude/dvb-clone-statusline.sh` and `~/.claude/dvb-gn-memory` while the generator
 * and the hangar-root session had moved to the new names. The fleet's ONE shared memory
 * directory was two directories, and `doctor` said `No problems in 4 clone(s).` -- because the
 * only check on the statusline asked whether the named path exists, and the pre-rename script
 * was still sitting there.
 *
 * OVERLAY, never regenerate. The template carries the personal half no generator can invent --
 * `enabledMcpjsonServers`, `enabledPlugins`, the `terminal.*` keys -- and a rewrite from
 * `defaultSettings` would delete a developer's MCP servers to fix a theme.
 *
 * The two arrays are ADD-IF-ABSENT rather than replace-by-shape. Adding the CURRENT secrets deny
 * is what closes the hole -- a hangar whose root or `secrets.file` moved had every clone denying
 * a path that no longer exists while still allowing `Read(<root>/**)` over the live one. A
 * leftover deny for the old path is inert (a deny only ever restricts), and a developer's own
 * rules have to survive, so nothing here removes an entry it did not write. The health-check
 * allows are the exception, and they are removable precisely because `HEALTH_CHECK_RE` matches
 * only the exact string this generator emits.
 */
export const settingsContentFor = (clone: Clone, template: SettingsJson): string => {
  const hangar = clone.hangar;
  const settings: SettingsJson = structuredClone(template);
  settings.theme = `custom:${themeName(clone)}`;
  settings['statusLine'] = { type: 'command', command: hangar.paths.statuslineScript };
  settings['autoMemoryDirectory'] = hangar.paths.memory;

  const permissions = { ...settings.permissions };
  /*
   * Drop every health-check allow this generator wrote, then write this clone's own.
   *
   * It used to find the ONE match and replace it in place, refusing when there were two because
   * there was no way to tell which port was meant. With a role table there is no ambiguity to
   * protect against: the generated set IS the answer, however many roles declare a health check,
   * so removing and re-appending is both simpler and correct for N. The order follows
   * `ports.roles[]`, so the file is stable across runs.
   */
  const kept = (permissions.allow ?? []).filter((entry) => !HEALTH_CHECK_RE.test(entry));
  const rootAllow = hangarRootAllow(hangar);
  permissions.allow = [
    ...kept,
    ...(kept.includes(rootAllow) ? [] : [rootAllow]),
    ...healthCheckAllows(clone),
  ];
  const deny = permissions.deny ?? [];
  const wantDeny = secretsDeny(hangar);
  permissions.deny = deny.includes(wantDeny) ? deny : [...deny, wantDeny];
  settings.permissions = permissions;

  /*
   * `plansDirectory` is carried across, and that is why the three hook writers are applied here
   * rather than `withPlansHook` alone being trusted with it: that one DROPS the key, because a
   * per-clone copy of the repo's own tracked `.claude/plans` is one more place to drift. But
   * `doctor` has a separate repair that WRITES an explicit `plansDirectory` for the one case
   * that needs it -- a tracked value resolving outside the clone, which Claude Code rejects
   * silently. Letting this builder strip it would undo that repair on the next `--fix`.
   */
  const plansDirectory = settings.plansDirectory;
  const withHooks = withTmpHook(hangar, withPlansHook(hangar, withJiraHook(hangar, settings)));
  const final: SettingsJson =
    plansDirectory === undefined ? withHooks : { ...withHooks, plansDirectory };
  return `${JSON.stringify(final, null, 2)}\n`;
};

const readSettingsFile = (path: string): SettingsJson | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SettingsJson;
  } catch {
    return undefined;
  }
};

export const readSettings = (clone: Clone): SettingsJson | undefined =>
  readSettingsFile(settingsPath(clone));

/** The repo's own tracked settings -- shared with the team, and not ours to edit from here. */
export const readTrackedSettings = (clone: Clone): SettingsJson | undefined =>
  readSettingsFile(join(clone.path, '.claude', 'settings.json'));

/**
 * Where this clone's plans actually land, and whether Claude Code will accept it.
 *
 * The local settings outrank the tracked ones. A value that resolves outside the clone is
 * REJECTED (with only a debug-level log) and plans fall back to `~/.claude/plans`, mixed in
 * with every other project on the machine -- which is what happened for a day when all three
 * clones pointed at an absolute shared path.
 */
export const effectivePlansDirectory = (
  clone: Clone,
): { readonly value: string | undefined; readonly resolved: string | undefined } => {
  const value = readSettings(clone)?.plansDirectory ?? readTrackedSettings(clone)?.plansDirectory;
  if (value === undefined) return { value: undefined, resolved: undefined };
  const resolved = resolve(clone.path, value);
  const inside = resolved === clone.path || resolved.startsWith(`${clone.path}/`);
  return { value, resolved: inside ? resolved : undefined };
};

/** Ports as they are actually written in the clone's `.env.local`, for drift detection. */
export const readEnvLocalPorts = (clone: Clone): Partial<Record<string, number>> => {
  const path = envLocalPath(clone);
  const found: Record<string, number> = {};
  if (!existsSync(path)) return found;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_]+)\s*=\s*'?"?(\d+)'?"?\s*$/.exec(line);
    if (match?.[1] && match[2]) found[match[1]] = Number.parseInt(match[2], 10);
  }
  return found;
};
