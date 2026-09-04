import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  claudeLocalMdContent,
  claudeLocalMdPath,
  envLocalContent,
  envLocalPath,
  envrcPrivateContent,
  envrcPrivatePath,
  EXCLUDE_BLOCK,
  excludePath,
  FLEET_BIN_PATH_LINE,
  JIRA_HOOK_COMMAND,
  PLANS_HOOK_COMMAND,
  playwrightEnvLocalPath,
  settingsContentFor,
  settingsPath,
  storybookHealthCheckAllow,
  TMP_HOOK_COMMAND,
  withJiraHook,
  withPlansHook,
  withTmpHook,
  workspaceAngularPath,
  workspaceContent,
  workspacePath,
  type SettingsJson,
} from '../clone-config.ts';
import { CONFIG_FILENAME, findHangar, ROOT_ENV_KEY } from '../config/load.ts';
import { direnvSnippet } from './add-clone.ts';
import { editors } from '../editor/index.ts';
import { cloneAt, discoverClones, type Clone } from '../fleet.ts';
import { cloneColoursArtifact } from '../generate/colours-sh.ts';
import { type Artifact } from '../generate/index.ts';
import { statuslineArtifact } from '../generate/statusline-sh.ts';
import { terminalHookArtifact } from '../generate/terminal-sh.ts';
import { themeArtifact, themeName, themePath } from '../generate/theme-json.ts';
import { fleetRoot } from '../paths.ts';
import { home } from '../user-paths.ts';
import { PORT_ROLE_ORDER, PORT_ROLES } from '../ports.ts';
import { currentHangarId, terminalColourSettings } from '../terminal/index.ts';
import { heading, note, ok } from '../ui.ts';

/**
 * `hangar dev golden` -- the regression net for a CLI with no test suite.
 *
 * It captures every artifact this hangar would WRITE, rather than what a command happens to
 * print, and it does so through the same pure builders `doctor` compares against and
 * `add-clone` writes. Two properties make it worth its weight during Track F:
 *
 * - It records **paths as well as content.** Threading a hangar object, opening the port-role
 *   table and namespacing the `~/.claude` artifacts all change DESTINATIONS, and every path in
 *   this CLI is a bare `string` -- a builder that renders perfect text into the wrong file
 *   typechecks, lints, and passes a content-only diff.
 * - It records the two facts the config readers otherwise swallow: the discovery `source` that
 *   answered, and `EditorSelection.fellBack`. Four call sites catch an unparseable config and
 *   continue on defaults, and while a hangar's config EQUALS the defaults, "read the file" and
 *   "fell into the catch" produce identical output. Without these two lines a diff cannot tell
 *   a wired reader from a swallowed error.
 *
 * Everything is written twice, verbatim and with `%HANGAR%`/`%HOME%` substituted, because the
 * verbatim copy is what catches an unintended path change while the normalised copy is what
 * survives being read on another machine.
 */
export type GoldenOptions = {
  readonly out: string;
  /**
   * Synthesize these clone indices instead of discovering directories, so a capture can run
   * against a hangar root that holds nothing but a `hangar.config.yaml`. That is the whole
   * mechanism behind the hostile fixture: point `HANGAR_ROOT` at the fixture directory and the
   * real config readers read the fixture, with no filesystem to discover.
   */
  readonly indices?: string;
};

/**
 * The settings template every capture renders from -- fixed here, never read off disk.
 *
 * `add-clone` copies a sibling's real `settings.local.json`, which carries personal keys and
 * differs per machine. What this net is checking is what `settingsContentFor` DOES to a
 * template (the theme name, and the one health-check allow it rewrites), so a constant
 * template is both sufficient and the only deterministic choice. The three hooks are applied
 * through the same `with*Hook` writers a repair uses, which is what puts the three hook
 * command strings into the capture.
 */
const TEMPLATE: SettingsJson = {
  permissions: {
    allow: ['Bash(git status)', 'Bash(curl -s -o /dev/null --max-time 3 http://localhost:9999)'],
    deny: ['Read(./.env)'],
  },
  plansDirectory: '.claude/plans',
};

const settingsTemplate = (): SettingsJson =>
  withTmpHook(withJiraHook(withPlansHook(structuredClone(TEMPLATE))));

/** Normalise the two absolute prefixes, longest first -- the hangar root lives under $HOME. */
const normalise = (text: string): string =>
  text.split(fleetRoot).join('%HANGAR%').split(home).join('%HOME%');

const write = (out: string, rel: string, content: string): void => {
  for (const [dir, text] of [
    [join(out, 'verbatim'), content],
    [join(out, 'normalised'), normalise(content)],
  ] as const) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
};

const parseIndices = (spec: string): number[] =>
  spec
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

/** Every per-clone artifact, as `<relative capture path>` -> `[destination, content]`. */
const cloneCaptures = (clone: Clone): readonly (readonly [string, string, string])[] => {
  const theme = themeArtifact(clone);
  return [
    ['env.local', envLocalPath(clone), envLocalContent(clone)],
    ['envrc.private', envrcPrivatePath(clone), envrcPrivateContent()],
    ['CLAUDE.local.md', claudeLocalMdPath(clone), claudeLocalMdContent(clone)],
    ['settings.local.json', settingsPath(clone), settingsContentFor(clone, settingsTemplate())],
    ['workspace.json', workspacePath(clone), workspaceContent(clone)],
    ['workspace-appdir.json', workspaceAngularPath(clone), workspaceContent(clone)],
    ['theme.json', themePath(clone), theme.content],
    ['git-info-exclude', excludePath(clone), EXCLUDE_BLOCK],
    ['direnv-snippet', envrcPrivatePath(clone), direnvSnippet(clone)],
    ['health-check-allow', settingsPath(clone), `${storybookHealthCheckAllow(clone)}\n`],
    ['playwright-symlink', playwrightEnvLocalPath(clone), '(symlink; target in the manifest)\n'],
  ];
};

export const golden = (opts: GoldenOptions): void => {
  const out = opts.out;
  const clones =
    opts.indices === undefined
      ? discoverClones()
      : parseIndices(opts.indices).map((i) => cloneAt(i));

  heading(`Capturing ${String(clones.length)} clone(s) into ${out}`);

  // The two facts a content diff cannot see. `findHangar` is asked with no flag, so this
  // records which mechanism actually answered for this invocation.
  //
  // `hangar-root` and `discovery-root` below are TWO INDEPENDENT MECHANISMS, and their
  // agreement today is a coincidence rather than evidence: `fleetRoot` is
  // `HANGAR_ROOT ?? import.meta.dirname/../..`, while this is the real upward walk that only
  // `config show` and `config validate` currently reach. They match because the tool happens
  // to live inside the hangar it manages. Do not read two identical lines as "discovery is
  // wired" -- the proof of that is `fleetRoot` DISAPPEARING from the manifest, not the two
  // lines continuing to agree.
  const found = findHangar({ cwd: process.cwd(), env: process.env[ROOT_ENV_KEY] });
  const selection = editors();
  const manifest: string[] = [
    `hangar-root        ${fleetRoot}   (fleetRoot: what commands use)`,
    `hangar-id          ${currentHangarId()}`,
    `discovery-source   ${found?.source ?? '(none: no config found)'}`,
    `discovery-root     ${found?.root ?? '(none)'}   (findHangar: the real walk)`,
    `config-file        ${join(fleetRoot, CONFIG_FILENAME)}`,
    `editor-fell-back   ${String(selection.fellBack)}`,
    `editor-kinds       ${selection.drivers.map((d) => d.kind).join(', ') || '(none)'}`,
    `plans-hook         ${PLANS_HOOK_COMMAND}`,
    `jira-hook          ${JIRA_HOOK_COMMAND}`,
    `tmp-hook           ${TMP_HOOK_COMMAND}`,
    `fleet-bin-path     ${FLEET_BIN_PATH_LINE()}`,
    `port-roles         ${PORT_ROLE_ORDER.map((r) => `${r}=${String(PORT_ROLES[r].base)}`).join(' ')}`,
    '',
  ];

  for (const clone of clones) {
    manifest.push(
      `clone ${clone.name}  index=${String(clone.index)}  colour=${clone.colour.name}  theme=${themeName(clone)}`,
      `  ports  ${PORT_ROLE_ORDER.map((r) => `${r}=${String(clone.ports[r])}`).join(' ')}`,
    );
    for (const [rel, destination, content] of cloneCaptures(clone)) {
      write(out, join('builders', clone.name, rel), content);
      manifest.push(`  ${rel.padEnd(22)} -> ${destination}`);
    }
    manifest.push('');
  }

  const shared: readonly Artifact[] = [
    cloneColoursArtifact(clones, currentHangarId()),
    terminalHookArtifact(currentHangarId(), terminalColourSettings()),
    statuslineArtifact(clones),
  ];
  for (const artifact of shared) {
    const name = artifact.path.split('/').pop() ?? 'artifact';
    write(out, join('artifacts', name), artifact.content);
    manifest.push(`artifact ${name.padEnd(22)} -> ${artifact.path}`);
  }

  write(out, 'manifest.txt', `${manifest.join('\n')}\n`);
  ok(`${String(clones.length)} clone(s), ${String(shared.length)} shared artifact(s)`);
  note('verbatim/ and normalised/ hold the same tree; diff both.');
};
