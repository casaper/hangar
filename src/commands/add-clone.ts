import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  claudeLocalMdContent,
  claudeLocalMdPath,
  envLocalContent,
  envLocalPath,
  envrcPrivateContent,
  envrcPrivatePath,
  EXCLUDE_BLOCK,
  EXCLUDE_LINE,
  excludePath,
  playwrightEnvLocalPath,
  readSettings,
  settingsContentFor,
  settingsPath,
  workspaceContent,
  workspacePath,
  type SettingsJson,
} from '../clone-config.ts';
import { CliError, run } from '../exec.ts';
import { cloneAt, discoverClones, nextFreeIndex, type Clone } from '../fleet.ts';
import { git } from '../git.ts';
import { envShared, fleetRoot, originUrl, tildify } from '../paths.ts';
import { cloneLabel, heading, note, ok, step, warn } from '../ui.ts';
import { coloursSync } from './colours.ts';
import { statusOf } from './status.ts';

/**
 * `orch-util add-clone` -- a new clone, wired into the fleet completely.
 *
 * The order matters and the list is exhaustive on purpose: every item here lives OUTSIDE
 * git, so nothing recreates it if this command forgets it. The two that bite hardest are
 * the `CLAUDE.local.md` + `.git/info/exclude` pair (an agent that does not know which clone
 * it is in is the failure this fleet is most prone to) and the per-clone ports (two clones
 * on one dev server means a test run silently verifies the other clone's code).
 */
export type AddCloneOptions = {
  install?: boolean | undefined;
  remote?: string | undefined;
};

const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
};

/** Base settings to copy from: any existing clone. Only theme + health-check port differ. */
const settingsTemplate = (siblings: readonly Clone[]): SettingsJson => {
  for (const sibling of siblings) {
    const settings = readSettings(sibling);
    if (settings) return settings;
  }
  throw new CliError(
    'no existing clone has a .claude/settings.local.json to use as a template',
    'Create the first clone by hand, or copy a settings file into any clone and retry.',
  );
};

export const addClone = (opts: AddCloneOptions): void => {
  const existing = discoverClones();
  const index = nextFreeIndex();
  const clone = cloneAt(index);
  const remoteUrl = opts.remote ?? originUrl;

  if (existsSync(clone.path)) {
    throw new CliError(`${clone.path} already exists`);
  }

  heading(`Creating ${cloneLabel(clone.name, clone.colour)}`);
  note(`ports ${clone.ports.ng} / ${clone.ports.storybook} / ${clone.ports.playwrightReport}`);

  // 1. the clone itself
  step(`git clone ${remoteUrl}`);
  const cloned = run('git', ['clone', remoteUrl, clone.name], { cwd: fleetRoot, inherit: true });
  if (!cloned.ok) throw new CliError(`git clone failed (exit ${cloned.code})`);

  // 2. sibling remotes, BOTH directions -- a one-way wiring is worse than none, because
  //    cherry-picking silently only works from one side.
  for (const sibling of existing) {
    addRemote(clone, sibling.name, `../${sibling.name}`);
    addRemote(sibling, clone.name, `../${clone.name}`);
  }
  ok(`wired ${existing.length} sibling remote(s) in both directions`);

  // 3-5. environment
  writeFile(envLocalPath(clone), envLocalContent(clone));
  ok(`.env.local (${clone.ports.ng} / ${clone.ports.storybook} / ${clone.ports.playwrightReport})`);

  writeFile(envrcPrivatePath(clone), envrcPrivateContent());
  ok(`.envrc.private -> ${tildify(envShared)} + the fleet bin/ on PATH (both absolute on purpose)`);

  const pwPath = playwrightEnvLocalPath(clone);
  if (existsSync(dirname(pwPath))) {
    if (!existsSync(pwPath)) {
      // Not redundant with .envrc.private: the tracked tests/.env sets USER_READWRITE_PASSWORD
      // empty and direnv loads it AFTER .envrc.private, so this reload is what wins.
      symlinkSync(relative(dirname(pwPath), envShared), pwPath);
      ok('tests/playwright-regression-tests/.env.local symlink');
    }
  } else {
    warn('no tests/playwright-regression-tests/ in this branch — playwright symlink skipped');
  }

  // 6. identity file AND its exclude line, created as a pair.
  writeFile(claudeLocalMdPath(clone), claudeLocalMdContent(clone, [...existing, clone]));
  const exclude = existsSync(excludePath(clone)) ? readFileSync(excludePath(clone), 'utf8') : '';
  if (!exclude.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) {
    writeFile(excludePath(clone), exclude + EXCLUDE_BLOCK);
  }
  ok('CLAUDE.local.md + .git/info/exclude (always as a pair)');

  // 7. Claude Code settings: copied, except the two values that must not be.
  writeFile(settingsPath(clone), settingsContentFor(clone, settingsTemplate(existing)));
  ok(`.claude/settings.local.json (theme + Storybook health check on ${clone.ports.storybook})`);

  // 8-9. theme + workspace
  writeFile(workspacePath(clone), workspaceContent(clone));
  ok(workspacePath(clone).split('/').pop() ?? 'code-workspace');

  // 10. regenerate everything derived from the palette, now that the fleet is bigger
  heading('Regenerating colour artifacts');
  coloursSync({});

  // 11. dependencies -- a clone without its own node_modules is the one thing the fleet
  //     exists to provide, so this is the default.
  if (opts.install === false) {
    note(
      'Skipped `npm ci` (--no-install). The clone cannot serve, test or build until you run it.',
    );
  } else {
    heading('Installing dependencies');
    npmCi(clone);
  }

  // 12. direnv
  heading('Run this to let direnv load the new clone');
  console.log(direnvSnippet(clone));

  // 13. status
  statusOf(clone, false);
};

const addRemote = (repo: Clone, name: string, url: string): void => {
  const res = git(repo.path, ['remote', 'add', name, url]);
  if (!res.ok) git(repo.path, ['remote', 'set-url', name, url]);
};

/** Every directory in the clone that has an `.envrc`, so nothing is left un-allowed. */
export const direnvSnippet = (clone: Clone): string => {
  const dirs = ['.', 'angular'].filter((d) => existsSync(join(clone.path, d, '.envrc')));
  const paths = dirs.map((d) => (d === '.' ? clone.path : join(clone.path, d)));
  return paths.map((p) => `(cd ${JSON.stringify(p)} && direnv allow .)`).join('\n');
};

/**
 * `npm ci` under the Node version the clone pins. The machine uses fnm, and shell state does
 * not survive between our spawns, so the version is applied per command rather than by
 * sourcing anything.
 */
const npmCi = (clone: Clone): void => {
  const angular = join(clone.path, 'angular');
  const cwd = existsSync(join(angular, 'package.json')) ? angular : clone.path;
  const nvmrc = join(cwd, '.nvmrc');
  const version = existsSync(nvmrc) ? readFileSync(nvmrc, 'utf8').trim() : undefined;

  const useFnm = version !== undefined && run('fnm', ['--version']).ok;
  const res = useFnm
    ? run('fnm', ['exec', `--using=${version}`, '--', 'npm', 'ci'], { cwd, inherit: true })
    : run('npm', ['ci'], { cwd, inherit: true });

  if (res.ok) ok(`npm ci in ${tildify(cwd)}${version === undefined ? '' : ` (node ${version})`}`);
  else warn(`npm ci failed (exit ${res.code}) — run it by hand in ${tildify(cwd)}`);
};
