import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import { configJsonSchemaText } from '../config/json-schema.ts';
import { deriveDefaults, derivedPortStep } from '../config/derive.ts';
import {
  CONFIG_FILENAME,
  EXAMPLE_CONFIG_FILENAME,
  jsonSchemaFileName,
  loadConfigFile,
  loadHangar,
  parseConfigText,
} from '../config/load.ts';
import {
  presetByName,
  presetChoices,
  presetNames,
  PRESETS,
  type Preset,
} from '../config/presets.ts';
import { MANAGER_COMMANDS } from '../config/schema.ts';
import { inspectEnvironment, installHint, type EnvironmentReport } from '../environment.ts';
import { CliError } from '../exec.ts';

import {
  hangarClaudeLocalMdContent,
  hangarClaudeLocalMdPath,
  hangarSettingsContent,
  hangarSettingsPath,
} from '../hangar-files.ts';
import { pathsFor } from '../hangar.ts';
import { claudeDir, tildify } from '../user-paths.ts';
import { blank, fail, heading, note, ok, step, warn } from '../ui.ts';

/**
 * `hangar setup` -- the guided first-run.
 *
 * Two jobs, in this order: prove the machine has what Hangar needs, then write a config the
 * user can read. It is deliberately re-runnable against a hangar that already exists, which
 * is the common case (this hangar had four clones and three running dev servers before it
 * had a config file), so every question arrives with an answer already derived from disk.
 */

export type SetupOptions = {
  /** Take every derived default without asking. What CI and a re-run use. */
  readonly yes?: boolean | undefined;
  readonly force?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  /**
   * The origin URL, for `--yes` in a directory with no clone to read one off.
   *
   * Without it `--yes` ALWAYS failed in a fresh checkout, which is the only place `--yes` is
   * useful: `deriveDefaults` leaves `originUrl` undefined with no clone to ask, `ask` returns
   * the empty fallback under `--yes`, and setup threw "a git origin URL is required" after
   * printing a full environment report. There was no flag that could get past it.
   */
  readonly origin?: string | undefined;
  readonly preset?: string | undefined;
  /**
   * The hangar id, for an unattended run in a directory whose name is not a good one.
   *
   * `--yes` derives it from the directory basename, which is right for `~/code/backend_hangar`
   * and wrong for anything generated: the golden capture renders `setup -n` in a `mktemp -d`
   * directory, so the id came out `tmp_lvj1i0wliy` and changed on every regeneration -- turning
   * a gate into a file that is dirty in normal operation, which is a gate nobody reads.
   */
  readonly id?: string | undefined;
};

/**
 * The config points at the schema sitting BESIDE it, never at a URL.
 *
 * `hangar config schema` writes `hangar.schema.json` into every hangar root, so a relative
 * path always resolves, works offline, needs no published repository, and describes the
 * schema of the Hangar version actually installed rather than whatever is on a branch
 * somewhere. `hangar config schema --check` is what keeps the local copy honest.
 *
 * Both references are emitted because editors disagree on which they read: the
 * `# yaml-language-server` modeline is what the VS Code and nvim YAML servers use, while a
 * top-level `$schema` key is the convention JetBrains and several CLI validators follow.
 * Being relative, they cannot drift apart.
 */
const SCHEMA_REF = `./${jsonSchemaFileName}`;

/** Report the machine's tooling. Throws when something REQUIRED is missing. */
export const reportEnvironment = (report: EnvironmentReport): void => {
  heading('Environment');

  for (const { tool, present } of report.statuses.filter((s) => s.tool.kind === 'required')) {
    if (present) ok(`${tool.name.padEnd(18)} found`);
    else fail(`${tool.name.padEnd(18)} MISSING — ${tool.why}\n  ${installHint(tool)}`);
  }

  const { found, candidates } = report.nodeManager;
  if (found === undefined) {
    fail(
      `${'fnm or nvm'.padEnd(18)} MISSING — resolves the .nvmrc Node version per directory\n` +
        `  brew install fnm   (preferred: a real binary, and faster)\n` +
        `  brew install nvm   (alternative; a shell function, so \`command -v nvm\` never finds it)`,
    );
  } else {
    ok(`${found.padEnd(18)} found (of ${candidates.join(' / ')})`);
  }

  if (report.homebrew.needed) {
    if (report.homebrew.present) ok(`${'homebrew'.padEnd(18)} found at ${report.homebrew.prefix}`);
    else
      fail(
        `${'homebrew'.padEnd(18)} MISSING — Hangar needs it on macOS for the GNU userland and every install hint\n  https://brew.sh`,
      );
  }

  blank();
  const preferred = report.statuses.filter((s) => s.tool.kind === 'preferred');
  if (report.missingPreferred.length === 0) {
    ok(`all ${String(preferred.length)} recommended tools present`);
  } else {
    note('Recommended, not required:');
    for (const { tool, present } of preferred) {
      if (present) continue;
      warn(`${tool.name.padEnd(18)} ${tool.why}`);
      note(`  ${installHint(tool)}`);
    }
  }

  if (report.missingRequired.length > 0) {
    throw new CliError(
      `missing required tooling: ${report.missingRequired.join(', ')}`,
      'Install the programs listed above, then run `hangar setup` again.',
    );
  }
};

export type Answers = {
  readonly id: string;
  readonly displayName: string;
  readonly originUrl: string;
  readonly defaultBranch: string;
  readonly appDir: string;
  readonly installManager: string;
  readonly trackerBaseUrl: string;
  readonly trackerKeyPrefix: string;
  readonly portOffset: string;
  /** Supplies the two things no checkout can answer: the port roles and the per-clone vars. */
  readonly preset: Preset;
  /** Discovered from a clone's tracked `*.envrc` files, never a literal list. */
  readonly envrcDirs: readonly string[];
  /** Discovered from a clone's `.vscode/settings.json`; empty is the normal answer. */
  readonly rootPathKeys: Readonly<Record<string, string>>;
};

/**
 * A comment block, wrapped to this repo's 100-column width at the given indent.
 *
 * Preset prose is a plain sentence in `presets.ts` rather than pre-wrapped lines, so it can be
 * read and edited there without counting columns; the wrapping belongs to the renderer.
 */
const wrapComment = (text: string, indent: string): string => {
  const width = 100 - indent.length - 2;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${indent}# ${l}`).join('\n');
};

/** Single-quote a YAML scalar. Everything templated needs it: `{id}_{index2}` reads as a map. */
const yq = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const yamlRecord = (entries: readonly (readonly [string, string])[], indent: string): string =>
  entries.map(([key, value]) => `${indent}${key}: ${yq(value)}`).join('\n');

/**
 * Render the config file.
 *
 * A PURE builder, exported so every variant can be printed side by side without writing
 * anything -- the convention this CLI already uses in place of a test suite. The comments are
 * the point: this file is read far more often than it is written, and a value whose reason is
 * not beside it gets "simplified" later.
 *
 * **It emits only what was observed or answered.** That is the rule this builder broke, and it
 * broke it in a way only a foreign repo could reach: it wrote this fleet's Playwright symlink,
 * this fleet's eight VS Code path keys, this repo's `node dev/ports.mjs` port check, this
 * organisation's Jira host, and `envrcDirs: ['.', '<appDir>', 'tests/playwright-regression-tests']`
 * -- which for a repo with no `package.json` renders as `['.', '', 'tests/...']`, and `envrcDirs`
 * is `z.array(z.string().min(1))`. So `setup` wrote a config and then threw validating it.
 *
 * A value that cannot be observed is either asked, offered by a preset, or LEFT OUT with a
 * comment saying what it would do. Left out is not a lesser answer: every one of those keys is
 * optional in the schema, and an absent key is a hangar that does one less thing, while a
 * confidently wrong one is a hangar that checks the wrong port or links the wrong file.
 */
export const configYamlContent = (a: Answers): string => {
  const command = MANAGER_COMMANDS[a.installManager];
  const install =
    a.installManager === ''
      ? `  # No install step: nothing in this repo declared a lockfile, which is the normal answer for
  # a repo whose dependencies are not fetched per checkout (SQL, docs, infrastructure).
  install: []
`
      : `  install:
      # A step names either a \`manager\` (whose canonical command is built in) or an explicit
      # \`command\`. Any ecosystem works here -- maven, bundler, pip, cargo -- because Hangar
      # only runs the argv it is given and never assumes Node.
      #   ${a.installManager} => ${(command ?? []).join(' ')}
    - dir: ${a.appDir === '' ? '.' : a.appDir}
      manager: ${a.installManager}
      nodeVersionFile: .nvmrc
      # Required. Printed beside the step by add-clone, \`hangar install\` and doctor -- the only
      # place a reader learns whether it is load-bearing. Say why THIS repo needs it.
      why: each clone needs its own installed dependencies, which is what the fleet is for
`;

  const tracker =
    a.trackerBaseUrl === ''
      ? `tracker:
  # No tracker. \`hangar status\` then infers no issue key and links nothing, and the Jira
  # PreToolUse cache hook does nothing. Set kind: jira and a baseUrl to turn both on;
  # ${EXAMPLE_CONFIG_FILENAME} has the syncScript/namerScript pair the cache hook needs.
  kind: none
`
      : `tracker:
  kind: jira
  baseUrl: ${a.trackerBaseUrl}
${
  a.trackerKeyPrefix === ''
    ? `  # keyPrefixes is a whitelist, so a token like ISO-8601 or SHA-1 in a branch name is never
  # mistaken for an issue key. None was detected from this repo's branch names; without it the
  # pattern stays open and leans on a denylist instead.
`
    : `  # A whitelist, so a token like ISO-8601 or SHA-1 in a branch name is never mistaken for an
  # issue key. Read off this repo's own branch names.
  keyPrefixes: [${a.trackerKeyPrefix}]
`
}  cache:
    ttlMinutes: 60
    bypassEnvKey: JIRA_SYNC_NO_CACHE
  # The per-ticket cache hook needs the repo's OWN scripts -- the namer is the tracked,
  # branch-versioned authority on cache filenames, so Hangar asks it instead of reimplementing
  # the naming. Left out because they are paths inside YOUR repo and nothing here can guess
  # them; the hook stays inert until both are set.
  # syncScript: .claude/skills/jira-ticket-sync/sync.mjs
  # namerScript: .claude/skills/jira-scope/jira-cache.mjs
`;

  const isBitbucket = a.originUrl.includes('bitbucket.org');

  const roles =
    a.preset.roles.length === 0
      ? `  # ${wrapComment(a.preset.roleNote, '  ')}
  # Each role becomes one environment variable in every clone's dotenv, one column in
  # \`hangar ports\`, and optionally one generated health-check permission. A hangar with no
  # roles is legal and manages no ports at all.
  roles: []
`
      : `${wrapComment(a.preset.roleNote, '  ')}
  roles:
${a.preset.roles
  .map(
    (r) => `    - id: ${r.id}
      envKey: ${r.envKey}
      base: ${String(r.base)}
      label: ${yq(r.label)}
      url: ${r.url === null ? 'null' : yq(r.url)}${
        r.healthCheck === undefined
          ? ''
          : `
      # Declared, so the permissions.allow matcher can be GENERATED and stay fully anchored.
      # A looser pattern rewrites the wrong allow entry and leaves a check aimed at a
      # sibling's port.
      healthCheck:
        kind: httpCurl
        timeoutSeconds: ${String(r.healthCheck.timeoutSeconds)}${
          r.healthCheck.path === '' ? '' : `\n        path: ${yq(r.healthCheck.path)}`
        }`
      }`,
  )
  .join('\n')}
`;

  const cloneVars =
    Object.keys(a.preset.cloneEnvVars).length === 0
      ? `    # Per-clone values beyond the ports, as templated KEY: value pairs -- this is where a
    # clone gets its own database or container set: PGDATABASE: '${a.id}_{index2}'.
    vars: {}
`
      : `${wrapComment(a.preset.varsNote, '    ')}
    # Rendered per clone into the dotenv above, so \`doctor\` byte-compares them and \`--fix\`
    # repairs them with no new check.
    vars:
${yamlRecord(Object.entries(a.preset.cloneEnvVars), '      ')}
`;

  const rootPathKeys =
    Object.keys(a.rootPathKeys).length === 0
      ? `  # Settings whose value is an absolute path into the checkout, and so must be rewritten per
  # clone by \`hangar ide vscode sync\`. None were found in this repo's .vscode/settings.json,
  # which is the normal answer -- most settings are relative and shared. An entry's value is
  # the clone-relative path it should point at.
  rootPathKeys: {}
`
      : `  # Settings whose value is an absolute path into the checkout, and so must be rewritten per
  # clone. Read off a clone's own .vscode/settings.json: each value is the clone-relative path
  # the setting points at. A key missing from here is copied verbatim between clones, which
  # aims one clone's tooling at another clone's tree and fails silently.
  rootPathKeys:
${yamlRecord(Object.entries(a.rootPathKeys), '    ')}
`;

  return `# yaml-language-server: $schema=${SCHEMA_REF}
$schema: ${SCHEMA_REF}

_: >-
  Configuration for one hangar: a directory holding a fleet of full clones of one repo.

# Written by \`hangar setup\`, and yours to edit from here. This file is normally GITIGNORED --
# it names this machine's paths, ports and token variables. Every key, its default and every
# alternative is documented in ${EXAMPLE_CONFIG_FILENAME}; \`hangar config validate\` reports
# every problem at once, and \`hangar config show\` prints this file with all defaults applied.
# Validation is strict: an unknown key is an error, because a silently dropped key is a setting
# that looks configured and is not.
#
# Setup writes only what it could OBSERVE in this repo or was told. Anything it could not
# observe is left out with a comment saying what it would do -- an absent key is a hangar that
# does one less thing, and a guessed one is a hangar that checks the wrong port.

# Namespaces everything this hangar writes OUTSIDE its own root: the theme filenames, the
# statusline script and the shell function in the generated colour table. No dashes -- it has
# to be a legal shell identifier.
#
# ASKED FOR, not derived -- ~/work/${a.id} and ~/code/${a.id} would collide in that shared
# state, where the symptom is "the other hangar's clones changed colour". The one exception is
# \`setup --yes\` with no \`--id\`, which falls back to the directory basename because an
# unattended run has nothing else to go on; check the line above if that is how this file was
# written.
id: ${a.id}
displayName: ${yq(a.displayName)}
# The setup preset this config was written from. A LABEL: no code reads it, and changing it
# changes nothing. Everything the preset chose is spelled out below, where you can edit it.
profile: ${a.preset.name}

clones:
  prefix: clone_
  # The generated discovery regex is \\d{2,} -- open at the top on purpose. The old
  # clone_0[0-9] glob stopped matching at clone_10.
  pad: 2

forge:
  kind: ${isBitbucket ? 'bitbucketCloud' : 'none'}
  originUrl: ${a.originUrl}
${
  a.defaultBranch === ''
    ? `  # defaultBranch is left blank on purpose: the first command that needs it detects it from
  # git and writes the line here itself. Nothing guesses \`master\` -- undetectable aborts.
`
    : `  # Detected once and read from here afterwards; no command asks git for it again.
  defaultBranch: ${a.defaultBranch}
`
}${
    isBitbucket
      ? `  # The variable in the secrets file holding an API token. Without it \`sync\` cannot ask which
  # branch a pull request targets, so it falls back to defaultBranch and says the target is a
  # guess -- a soft failure, never an error.
  tokenEnvKey: BITBUCKET_TOKEN
`
      : `  # tokenEnvKey names the variable in the secrets file holding an API token, which lets
  # \`sync\` ask which branch a pull request targets instead of guessing. Only the
  # bitbucketCloud adapter uses it.
`
  }
${tracker}
repo:
  # Where the app package lives; '' means the repo root.
  appDir: ${a.appDir === '' ? "''" : a.appDir}
  # Fallback for direnv discovery -- \`git ls-files -- *.envrc\` is tried first, and discovery
  # beats declaration. Read off this repo's tracked .envrc files.
  envrcDirs: [${a.envrcDirs.map((dir) => yq(dir)).join(', ')}]
  cloneEnv:
    file: .env.local
    rootPathEnvKey: PROJECT_GIT_ROOT_PATH
${cloneVars}  # Symlinks every clone needs, each with a REQUIRED \`why\` -- nothing in a filesystem explains
  # a link, and that string is what add-clone and doctor print. The usual target is
  # '{secretsFile}', for a path that has to reload the shared secrets at a later point than
  # direnv would. Nothing here can be guessed from a checkout, so the list starts empty.
  symlinks: []
${install}  # portCheckCommand names the repo's OWN port resolver, run inside a clone and compared
  # against the roles below -- which turns the by-convention agreement between Hangar and the
  # repo's port table into a checked one. Left out because it is a command inside YOUR repo.
  # portCheckCommand: [node, dev/ports.mjs, --json]

ports:
  # Spacing between clones. Must match across hangars for the offset guarantee to hold.
  step: ${String(derivedPortStep())}
  # This hangar's residue class mod step. Two hangars with different offsets can never
  # collide for ANY clone counts -- unlike a reserved block, which fails silently once a
  # hangar outgrows it. 0 keeps this hangar exactly where it already is, which matters
  # because changing a port moves a running dev server out from under a live session.
  offset: ${a.portOffset}
${roles}
terminal:
  tabs:
    - { role: claude, dir: '.', command: claude }
    - { role: shell, dir: '.' }
${a.appDir === '' ? '' : `    - { role: app, dir: ${a.appDir} }\n`}
editor:
  # A list, because a clone can be open in more than one editor at once. VS Code is the default
  # and the only kind that has to work; jetbrains, zed, emacs, vim, xcode, eclipse and the six
  # VS Code forks are best effort. The full list, with what each one syncs, is in
  # ${EXAMPLE_CONFIG_FILENAME} -- along with the per-editor blocks (editor.jetbrains,
  # editor.vim, editor.eclipse), which are left out here because they configure nothing until
  # their kind is listed below.
  kinds: ['vscode']
  workspaceFileName: '${a.id}_{index2}.code-workspace'
  workspaceFolderLabel: '{index}: ${a.id}'
  workspaceDirs: ['.'${a.appDir === '' ? '' : `, '${a.appDir}'`}]
${rootPathKeys}
secrets:
  # Hangar-root-relative, so it sits OUTSIDE every clone and no clone can commit it.
  file: .env.shared
  mode: '600'
  # What YOUR repo's tooling needs out of that file, each with a required \`why\`. Left empty
  # because nothing in a checkout declares its own credentials: setup scaffolds the names
  # Hangar itself uses (the forge token, the tracker pair) and cannot know the rest.
  #
  # Declare them and \`hangar doctor\` prints a row per unset one, telling "absent" apart from
  # the worse "set but EMPTY". Skip it and the failure is silent in the worst way: the fleet
  # this tool was built in has a Playwright suite whose password its own tracked .env sets
  # EMPTY, so leaving the variable undeclared meant a green doctor and a login that failed
  # with no reason given.
  #
  #   variables:
  #     - name: USER_READWRITE_PASSWORD
  #       why: the tracked tests/.env sets it empty; Playwright logs in with no password without it
  #       optional: false   # true renders the row dim instead of red
  variables: []
`;
};

/**
 * The secrets file, as `setup` creates it: variable names, commented out, and nothing else.
 *
 * A PURE builder, and it exists because `setup` used to NAME a secrets file it never created.
 * On a fresh hangar `.env.shared` is therefore absent, which makes `doctor` red and leaves
 * `sync` with no token to read -- both diagnosed as bugs rather than as "nobody filled this in".
 *
 * Every line is commented out. An empty `BITBUCKET_TOKEN=` would be worse than a missing file:
 * a set-but-empty variable is indistinguishable from a real one to everything downstream, so
 * `sync` would send an empty bearer token and report a 401 rather than "no token configured".
 * Filling this in is the one manual step, and it says so.
 */
export const secretsFileContent = (a: Answers): string => {
  const names = a.originUrl.includes('bitbucket.org') ? ['BITBUCKET_TOKEN'] : [];
  if (a.trackerBaseUrl !== '') names.push('ATLASSIAN_USER_EMAIL', 'ATLASSIAN_API_TOKEN');
  return `# Every credential this hangar needs, in ONE file, outside every clone -- so no clone can
# commit it. Mode 600. Each clone's .envrc.private loads it by ABSOLUTE path; a relative one
# would resolve against the clone's subdirectory and silently load nothing.
#
# UNCOMMENT AND FILL IN what you use. Left commented on purpose: a set-but-empty variable is
# indistinguishable from a real one downstream, so an empty token makes \`sync\` report a 401
# instead of "no token configured".
#
# These are the names HANGAR uses. Whatever your repo's own tooling reads -- a test suite's
# password, a registry token -- goes here too, and belongs in \`secrets.variables\` in
# hangar.config.yaml so that \`hangar doctor\` prints a row when one is missing.
${names.length === 0 ? '#\n# This hangar declared no forge token and no tracker, so it needs nothing yet.\n' : names.map((name) => `#\n# ${name}=\n`).join('')}`;
};

const ask = async (
  rl: ReturnType<typeof createInterface>,
  question: string,
  fallback: string,
  opts: { readonly yes: boolean; readonly allowEmpty?: boolean },
): Promise<string> => {
  if (opts.yes) return fallback;
  const shown = fallback === '' ? '' : ` [${fallback}]`;
  const answer = (await rl.question(`  ${question}${shown}: `)).trim();
  return answer === '' ? fallback : answer;
};

/**
 * Takes the target DIRECTORY, not a `Hangar`.
 *
 * This is the one command that runs where a hangar does not exist yet -- that is what it is for
 * -- so it cannot be handed one. `cli.ts` passes the nearest hangar's root when there is one (a
 * re-run with `--force`) and the working directory when there is not.
 */
export const setup = async (root: string, opts: SetupOptions): Promise<void> => {
  const dryRun = opts.dryRun === true;
  const yes = opts.yes === true;

  heading(`hangar setup — ${tildify(root)}`);
  reportEnvironment(inspectEnvironment(root));

  const configPath = join(root, CONFIG_FILENAME);
  if (existsSync(configPath) && opts.force !== true) {
    // Re-running setup on a configured hangar should not silently rewrite hand edits.
    loadConfigFile(configPath);
    blank();
    ok(`${tildify(configPath)} already exists and is valid`);
    note('Pass --force to rewrite it, or edit it directly and run `hangar config validate`.');
    return;
  }

  const derived = deriveDefaults(root);
  blank();
  heading('Configuration');
  note(
    derived.cloneCount === 0
      ? 'No clones here yet — answers come from your input.'
      : `Read off ${String(derived.cloneCount)} existing clone(s); press enter to accept each.`,
  );

  const namedPreset = opts.preset === undefined ? undefined : presetByName(opts.preset);
  if (opts.preset !== undefined && namedPreset === undefined) {
    throw new CliError(
      `unknown preset "${opts.preset}"`,
      `Known presets: ${presetNames().join(', ')}`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answers: Answers;
  try {
    const id = opts.id ?? (await ask(rl, 'hangar id', derived.id, { yes }));
    /*
     * Asked even under `--yes`, unlike every other question.
     *
     * It is the one field with no derivable default and no usable empty value -- there is
     * nothing for `add-clone` to clone from without it. `--origin` is what lets `--yes` work
     * unattended; without either, asking is strictly better than the throw this used to do
     * after the whole environment report had scrolled past.
     */
    const knownOrigin = opts.origin ?? derived.originUrl ?? '';
    /*
     * Only ASK when there is a terminal to ask.
     *
     * With stdin closed -- a script, a CI job, `</dev/null` -- `rl.question` never settles, so
     * the process exited 0 with an "unsettled top-level await" warning and no config written.
     * That is worse than the throw it replaced: it looks like success. No tty and no origin is
     * a missing `--origin`, and it says so.
     */
    if (knownOrigin === '' && !process.stdin.isTTY) {
      throw new CliError(
        'a git origin URL is required, and there is no terminal to ask on',
        'Pass --origin <url>. There is nothing for `hangar add-clone` to clone from without it.',
      );
    }
    const originUrl =
      knownOrigin === ''
        ? await ask(rl, 'git origin URL (required)', '', { yes: false })
        : knownOrigin;

    const preset = namedPreset ?? (await askPreset(rl, yes));

    answers = {
      id,
      displayName: await ask(rl, 'display name', derived.displayName ?? id, { yes }),
      originUrl,
      preset,
      defaultBranch: await ask(
        rl,
        'default branch (blank = detect it on first use)',
        derived.defaultBranch ?? '',
        { yes, allowEmpty: true },
      ),
      appDir: await ask(rl, "app subdirectory ('' = repo root)", derived.appDir, {
        yes,
        allowEmpty: true,
      }),
      installManager: await ask(rl, 'package manager for install', derived.installManager ?? '', {
        yes,
        allowEmpty: true,
      }),
      trackerBaseUrl: await ask(
        rl,
        'issue tracker base URL (blank = none)',
        derived.trackerBaseUrl ?? '',
        { yes, allowEmpty: true },
      ),
      trackerKeyPrefix: await ask(rl, 'issue key prefix', derived.trackerKeyPrefix ?? '', {
        yes,
        allowEmpty: true,
      }),
      portOffset: await ask(rl, 'port offset (0 keeps existing ports)', '0', { yes }),
      // Not asked: both are observations, and both used to be literals of this one repo.
      envrcDirs: derived.envrcDirs,
      rootPathKeys: derived.rootPathKeys,
    };
  } finally {
    rl.close();
  }

  if (answers.originUrl === '') {
    throw new CliError(
      'a git origin URL is required',
      'Pass --origin <url>, or answer the question. There is nothing for `hangar add-clone` to clone from without it.',
    );
  }

  const yaml = configYamlContent(answers);
  const schema = configJsonSchemaText();
  const schemaPath = join(root, jsonSchemaFileName);
  const secretsPath = join(root, '.env.shared');
  /*
   * The settings file needs a `Hangar`, which does not exist until the config is on disk -- so it
   * is rendered from the answers rather than from a loaded hangar. `pathsFor` is a pure function
   * of its arguments precisely so this is possible before anything has been written.
   */
  const paths = pathsFor(root, answers.id, '.env.shared', claudeDir);
  const settingsFile = hangarSettingsPath(root);
  const settingsBody = hangarSettingsContent(root, paths.memory);

  /*
   * Validate the rendered YAML BEFORE printing or writing it, and in memory.
   *
   * The dry run used to return before `loadConfigFile`, so `setup -n` never validated what it
   * would write -- which is why the `envrcDirs: ['.', '', ...]` bug was reachable at all: the
   * one command that could have caught it was the one that skipped the check. Now both paths go
   * through the same parse, so `-n` is a real rehearsal.
   */
  validateRendered(yaml);

  blank();
  if (dryRun) {
    step(`would write ${tildify(configPath)}`);
    step(`would write ${tildify(schemaPath)}`);
    step(`would write ${tildify(settingsFile)}`);
    step(`would write ${tildify(hangarClaudeLocalMdPath(root))}`);
    if (!existsSync(secretsPath)) step(`would create ${tildify(secretsPath)} (mode 600)`);
    ok('the rendered config validates against the schema');
    process.stdout.write(`\n${yaml}`);
    return;
  }

  writeFileSync(configPath, yaml);
  ok(`written  ${tildify(configPath)}`);
  if (!existsSync(schemaPath) || readFileSync(schemaPath, 'utf8') !== schema) {
    writeFileSync(schemaPath, schema);
    ok(`written  ${tildify(schemaPath)}`);
  } else {
    note(`unchanged ${tildify(schemaPath)}`);
  }

  /*
   * The hangar root's own Claude Code settings: shared memory, the plan archive, the mode badge.
   *
   * Written here rather than shipped tracked, because two of its three values are absolute paths
   * on THIS machine -- and Claude Code fails silently on all three, so a stranger cloning a
   * tracked copy would get no shared memory, no archive and no badge, with nothing said.
   */
  writeFileSync(settingsFile, settingsBody);
  ok(`written  ${tildify(settingsFile)}`);

  /*
   * This hangar's `CLAUDE.local.md`, the half of the fleet map that is not generic.
   *
   * Written from the config that was just validated, through the same builder `doctor` holds it
   * to. It reaches every clone session through Claude Code's ancestor walk, which is what lets
   * the tracked `CLAUDE.md` beside it carry no paths, no ports and no repo name at all.
   */
  const hangar = loadHangar({ cwd: root, flag: root, env: undefined });
  writeFileSync(hangarClaudeLocalMdPath(root), hangarClaudeLocalMdContent(hangar));
  ok(`written  ${tildify(hangarClaudeLocalMdPath(root))}`);

  /*
   * The secrets file, created empty-but-named. Never overwritten: it holds live credentials.
   *
   * `setup` used to name this file and not create it, so a fresh hangar had `doctor` red and
   * `sync` with no token to read -- both of which get diagnosed as bugs rather than as "nobody
   * has filled this in yet".
   */
  if (existsSync(secretsPath)) {
    note(`unchanged ${tildify(secretsPath)} (it already exists — never overwritten)`);
  } else {
    writeFileSync(secretsPath, secretsFileContent(answers));
    chmodSync(secretsPath, 0o600);
    ok(`created  ${tildify(secretsPath)} (mode 600) — filling it in is your one manual step`);
  }

  // Validating what we just wrote is the only proof the builder and the schema agree.
  loadConfigFile(configPath);
  blank();
  ok('config validates against the schema');
  note(
    'Next: `hangar config show` to see every applied default, `hangar doctor --all` to check the clones.',
  );
};

/**
 * Parse the rendered YAML without touching the filesystem.
 *
 * Written as a temp-file-free check on purpose: the point is that `-n` proves the render is
 * loadable, and a check that had to write the file first would not be a dry run.
 */
const validateRendered = (yaml: string): void => {
  try {
    parseConfigText(yaml, '(the config setup just rendered)');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `the config setup rendered does not validate: ${detail}`,
      'This is a bug in `hangar setup`, not in your answers. Report the answers you gave.',
    );
  }
};

const askPreset = async (rl: ReturnType<typeof createInterface>, yes: boolean): Promise<Preset> => {
  const fallback = PRESETS[0];
  if (fallback === undefined) throw new CliError('no setup presets are defined');
  if (yes) return fallback;
  note('Preset — supplies the port roles and per-clone variables no checkout can answer:');
  note(presetChoices());
  const answer = await ask(rl, 'preset', fallback.name, { yes: false });
  const chosen = presetByName(answer);
  if (chosen === undefined) {
    throw new CliError(`unknown preset "${answer}"`, `Known presets: ${presetNames().join(', ')}`);
  }
  return chosen;
};
