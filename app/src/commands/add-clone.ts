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
  missingExcludeLines,
  excludePath,
  playwrightEnvLocalPath,
  readSettings,
  settingsContentFor,
  settingsPath,
  workspaceAngularPath,
  workspaceContent,
  workspacePath,
  type SettingsJson,
} from '../clone-config.ts';
import { clearColourAssignment } from '../colour-assignments.ts';
import { CliError, run } from '../exec.ts';
import { cloneAt, discoverClones, nextFreeIndex, type Clone } from '../fleet.ts';
import { FLEET_GIT_CONFIG, git, gitTry, setFleetGitConfig } from '../git.ts';
import { envShared, fleetRoot, fleetTmp, originUrl, tildify } from '../paths.ts';
import { cloneTmpPath, linkStoreEntriesInto } from '../tmp.ts';
import { cloneLabel, heading, note, ok, step, warn } from '../ui.ts';
import { coloursSync } from './colours.ts';
import { statusOf } from './status.ts';

/**
 * `hangar add-clone` -- a new clone, wired into the fleet completely.
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

  heading(`Creating ${cloneLabel(clone)}`);
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

  // 2b. and the config those remotes make necessary, in EVERY clone for the same reason the
  //     remotes go both ways: this clone makes `git checkout <branch>` newly ambiguous in all
  //     the others, so setting it only here fixes the one clone that did not have the problem.
  const configFailures = [clone, ...existing].flatMap((repo) => {
    const { failed } = setFleetGitConfig(repo.path);
    return failed.map((key) => `${repo.name}: ${key}`);
  });
  if (configFailures.length === 0) {
    ok(`git config ${FLEET_GIT_CONFIG.map(([k, v]) => `${k}=${v}`).join(', ')} in every clone`);
  } else {
    warn(`could not set ${configFailures.join(', ')} — run \`hangar doctor --fix\``);
  }

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
  writeFile(claudeLocalMdPath(clone), claudeLocalMdContent(clone));
  const exclude = existsSync(excludePath(clone)) ? readFileSync(excludePath(clone), 'utf8') : '';
  if (missingExcludeLines(exclude).length > 0) {
    writeFile(excludePath(clone), exclude + EXCLUDE_BLOCK);
  }
  ok('CLAUDE.local.md + .git/info/exclude (always as a pair)');

  // 6b. its own tmp/, with a link to every entry of the shared store. The directory is the
  // clone's -- its PID files go in it -- and only the cache entries in it are shared, exactly
  // as `hangar tmp merge` maintains for the others. A fresh clone has no cache of its own,
  // so there is nothing to merge, only links to make.
  const tmp = cloneTmpPath(clone);
  mkdirSync(tmp, { recursive: true });
  const { linked, taken } = linkStoreEntriesInto(tmp);
  ok(`tmp/ (its own) with ${String(linked.length)} link(s) into ${tildify(fleetTmp)}`);
  if (taken.length > 0) warn(`tmp/ already had ${taken.join(', ')} — not linked`);

  // 7. Claude Code settings: copied, except the two values that must not be.
  writeFile(settingsPath(clone), settingsContentFor(clone, settingsTemplate(existing)));
  ok(`.claude/settings.local.json (theme + Storybook health check on ${clone.ports.storybook})`);

  // 8-9. theme + workspace. BOTH copies of the workspace file: VS Code only offers a
  //       `*.code-workspace` from the directory you opened, and this repo is opened at its
  //       root and at `angular/`. One of the two is the same silent gap as a missing
  //       `.envrc` -- `doctor` reports it, but only if someone runs `doctor`.
  const workspace = workspaceContent(clone);
  for (const path of [workspacePath(clone), workspaceAngularPath(clone)]) {
    if (!existsSync(dirname(path))) {
      warn(`${relative(clone.path, path)} skipped — no ${relative(clone.path, dirname(path))}/`);
      continue;
    }
    writeFile(path, workspace);
    ok(relative(clone.path, path));
  }

  // 10. regenerate everything derived from the palette, now that the fleet is bigger. A
  //     colour assignment left at this index by a clone that used to live here is dropped
  //     first: a new clone starts on the formula, and `nextFreeIndex()` reuses gaps.
  if (clearColourAssignment(clone.index)) {
    warn(`dropped a leftover colour assignment for index ${String(clone.index)}`);
  }
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

/**
 * Directories the repo is KNOWN to put an `.envrc` in, as the fallback for the discovery
 * below. Not the list itself: a hardcoded `['.', 'angular']` silently left
 * `tests/playwright-regression-tests` un-allowed, and that one carries the symlink that
 * reloads `.env.shared` after the tracked `.env` blanks `USER_READWRITE_PASSWORD` -- so
 * Playwright's login fails with an empty password and nothing says why.
 */
const KNOWN_ENVRC_DIRS = ['.', 'angular', 'tests/playwright-regression-tests'] as const;

/**
 * Every directory in the clone that has an `.envrc`, root first.
 *
 * Discovered from git rather than declared: all of them are tracked, so `ls-files` is exact
 * and costs nothing, and a branch that adds a fourth `.envrc` is covered without editing this
 * file. The known list above is the union'd fallback for a checkout git cannot answer for.
 */
const direnvDirs = (clone: Clone): string[] => {
  const tracked = gitTry(clone.path, ['ls-files', '-z', '--', '*.envrc']) ?? '';
  const dirs = new Set(
    tracked
      .split('\0')
      .filter((file) => file.endsWith('.envrc'))
      .map((file) => dirname(file)),
  );
  for (const dir of KNOWN_ENVRC_DIRS) dirs.add(dir);
  return [...dirs]
    .filter((dir) => existsSync(join(clone.path, dir, '.envrc')))
    .sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
};

/** The `direnv allow` lines for those directories, ready to paste into a shell. */
export const direnvSnippet = (clone: Clone): string =>
  direnvDirs(clone)
    .map((dir) => (dir === '.' ? clone.path : join(clone.path, dir)))
    .map((path) => `(cd ${JSON.stringify(path)} && direnv allow .)`)
    .join('\n');

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
