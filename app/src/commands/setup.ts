import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import { configJsonSchemaText } from '../config/json-schema.ts';
import { deriveDefaults, derivedPortRoles, derivedPortStep } from '../config/derive.ts';
import {
  CONFIG_FILENAME,
  EXAMPLE_CONFIG_FILENAME,
  jsonSchemaFileName,
  loadConfigFile,
} from '../config/load.ts';
import { MANAGER_COMMANDS } from '../config/schema.ts';
import { inspectEnvironment, type EnvironmentReport } from '../environment.ts';
import { CliError } from '../exec.ts';
import { fleetRoot, tildify } from '../paths.ts';
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
    else fail(`${tool.name.padEnd(18)} MISSING — ${tool.why}\n  ${tool.install}`);
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
      note(`  ${tool.install}`);
    }
  }

  if (report.missingRequired.length > 0) {
    throw new CliError(
      `missing required tooling: ${report.missingRequired.join(', ')}`,
      'Install the programs listed above, then run `hangar setup` again.',
    );
  }
};

type Answers = {
  id: string;
  displayName: string;
  originUrl: string;
  defaultBranch: string;
  appDir: string;
  installManager: string;
  trackerBaseUrl: string;
  trackerKeyPrefix: string;
  portOffset: string;
};

/**
 * Render the config file.
 *
 * A PURE builder, exported so every variant can be printed side by side without writing
 * anything -- the convention this CLI already uses in place of a test suite. The comments are
 * the point: this file is read far more often than it is written, and a value whose reason is
 * not beside it gets "simplified" later.
 */
export const configYamlContent = (a: Answers): string => {
  const roles = derivedPortRoles();
  const step = derivedPortStep();
  const command = MANAGER_COMMANDS[a.installManager];
  const install =
    a.installManager === ''
      ? '  install: []\n'
      : `  install:
      # A step names either a \`manager\` (whose canonical command is built in) or an explicit
      # \`command\`. Any ecosystem works here -- maven, bundler, pip, cargo -- because Hangar
      # only runs the argv it is given and never assumes Node.
      #   ${a.installManager} => ${(command ?? []).join(' ')}
    - dir: ${a.appDir === '' ? '.' : a.appDir}
      manager: ${a.installManager}
      nodeVersionFile: .nvmrc
`;

  const tracker =
    a.trackerBaseUrl === ''
      ? `tracker:
  kind: none
`
      : `tracker:
  kind: jira
  baseUrl: ${a.trackerBaseUrl}
  # A whitelist, so a token like ISO-8601 or SHA-1 in a branch name is never mistaken for an
  # issue key. Without it the pattern stays open and leans on a denylist instead.
  keyPrefixes: [${a.trackerKeyPrefix}]
  cache:
    ttlMinutes: 60
    bypassEnvKey: JIRA_SYNC_NO_CACHE
  # Repo-relative, and deliberately the repo's OWN scripts: the namer is the tracked,
  # branch-versioned authority on cache filenames, so Hangar asks it instead of
  # reimplementing the naming -- an untracked copy drifts the first time a branch changes a
  # relation slug.
  syncScript: .claude/skills/jira-ticket-sync/sync.mjs
  namerScript: .claude/skills/jira-scope/jira-cache.mjs
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

# Namespaces everything this hangar writes OUTSIDE its own root: ~/.claude/hangar/<id>,
# the theme filenames, and the shell function in the generated colour table. No dashes --
# it has to be a legal shell identifier. Never derived from the directory name, because
# ~/work/${a.id} and ~/code/${a.id} would collide in that shared state.
id: ${a.id}
displayName: ${a.displayName}
profile: ${a.trackerBaseUrl === '' ? 'generic' : 'storefront-ui'}

clones:
  prefix: clone_
  # The generated discovery regex is \\d{2,} -- open at the top on purpose. The old
  # clone_0[0-9] glob stopped matching at clone_10.
  pad: 2

forge:
  kind: ${a.originUrl.includes('bitbucket.org') ? 'bitbucketCloud' : 'none'}
  originUrl: ${a.originUrl}
${
  a.defaultBranch === ''
    ? `  # defaultBranch is left blank on purpose: the first command that needs it detects it from
  # git and writes the line here itself. Nothing guesses \`master\` -- undetectable aborts.
`
    : `  # Detected once and read from here afterwards; no command asks git for it again.
  defaultBranch: ${a.defaultBranch}
`
}  tokenEnvKey: BITBUCKET_TOKEN

${tracker}
repo:
  # Where the app package lives; '' means the repo root.
  appDir: ${a.appDir === '' ? "''" : a.appDir}
  # Fallback only -- \`git ls-files -- *.envrc\` is tried first, and discovery beats declaration.
  envrcDirs: ['.', '${a.appDir}', 'tests/playwright-regression-tests']
  cloneEnv:
    file: .env.local
    rootPathEnvKey: PROJECT_GIT_ROOT_PATH
  symlinks:
    - path: tests/playwright-regression-tests/.env.local
      target: '{secretsFile}'
      skipIfDirMissing: true
      # \`why\` is required, and this is a worked example of the reason: nothing in the
      # filesystem explains this link, and it is printed by add-clone and by doctor.
      why: >-
        the tracked tests/.env sets USER_READWRITE_PASSWORD= (empty) and direnv loads it
        AFTER .envrc.private, so this reload is what wins; delete it and Playwright logs in
        with an empty password
${install}  # Run inside a clone, where direnv has loaded its dotenv, and compared against the ports
  # below. Never run from the hangar root: there it reports clone_01's fallbacks for every
  # clone and does not error -- it just answers wrong.
  portCheckCommand: [node, dev/ports.mjs, --json]

ports:
  # Spacing between clones. Must match across hangars for the offset guarantee to hold.
  step: ${String(step)}
  # This hangar's residue class mod step. Two hangars with different offsets can never
  # collide for ANY clone counts -- unlike a reserved block, which fails silently once a
  # hangar outgrows it. 0 keeps this hangar exactly where it already is, which matters
  # because changing a port moves a running dev server out from under a live session.
  offset: ${a.portOffset}
  roles:
${roles
  .map(
    (r) => `    - id: ${r.id}
      envKey: ${r.envKey}
      base: ${String(r.base)}
      label: ${r.label}${
        r.id === 'storybook'
          ? `
      # Declared, so the permissions.allow matcher can be GENERATED and stay fully anchored.
      # A looser pattern rewrites the wrong allow entry and leaves a check aimed at a
      # sibling's port.
      healthCheck:
        kind: httpCurl
        timeoutSeconds: 3`
          : ''
      }`,
  )
  .join('\n')}

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
  # Settings whose value is a clone-relative path and so must be rewritten per clone.
  rootPathKeys:
    stylelint.configBasedir: ${a.appDir}
    stylelint.configFile: ${a.appDir}/stylelint.config.mjs
    stylelint.stylelintPath: ${a.appDir}/node_modules/stylelint
    jestrunner.projectPath: ${a.appDir}
    coverage-gutters.manualCoverageFilePaths: ${a.appDir}/coverage/lcov.info
    prettier.configPath: ${a.appDir}/.prettierrc
    prettier.prettierPath: ${a.appDir}/node_modules/prettier
    storyExplorer.server.internal.npm.dir: ${a.appDir}

secrets:
  # Hangar-root-relative, so it sits OUTSIDE every clone and no clone can commit it.
  file: .env.shared
  mode: '600'
`;
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

export const setup = async (opts: SetupOptions): Promise<void> => {
  const dryRun = opts.dryRun === true;
  const yes = opts.yes === true;

  heading(`hangar setup — ${tildify(fleetRoot)}`);
  reportEnvironment(inspectEnvironment());

  const configPath = join(fleetRoot, CONFIG_FILENAME);
  if (existsSync(configPath) && opts.force !== true) {
    // Re-running setup on a configured hangar should not silently rewrite hand edits.
    loadConfigFile(configPath);
    blank();
    ok(`${tildify(configPath)} already exists and is valid`);
    note('Pass --force to rewrite it, or edit it directly and run `hangar config validate`.');
    return;
  }

  const derived = deriveDefaults(fleetRoot);
  blank();
  heading('Configuration');
  note(
    derived.cloneCount === 0
      ? 'No clones here yet — answers come from your input.'
      : `Read off ${String(derived.cloneCount)} existing clone(s); press enter to accept each.`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answers: Answers;
  try {
    answers = {
      id: await ask(rl, 'hangar id', derived.id, { yes }),
      displayName: await ask(rl, 'display name', derived.displayName ?? derived.id, { yes }),
      originUrl: await ask(rl, 'git origin URL', derived.originUrl ?? '', { yes }),
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
    };
  } finally {
    rl.close();
  }

  if (answers.originUrl === '') {
    throw new CliError(
      'a git origin URL is required',
      'There is nothing for `hangar add-clone` to clone from.',
    );
  }

  const yaml = configYamlContent(answers);
  const schema = configJsonSchemaText();
  const schemaPath = join(fleetRoot, jsonSchemaFileName);

  blank();
  if (dryRun) {
    step(`would write ${tildify(configPath)}`);
    step(`would write ${tildify(schemaPath)}`);
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

  // Validating what we just wrote is the only proof the builder and the schema agree.
  loadConfigFile(configPath);
  blank();
  ok('config validates against the schema');
  note(
    'Next: `hangar config show` to see every applied default, `hangar doctor --all` to check the clones.',
  );
};
