import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  claudeLocalMdContent,
  healthCheckAllows,
  claudeLocalMdPath,
  envLocalContent,
  envLocalPath,
  envrcPrivateContent,
  envrcPrivatePath,
  excludeBlock,
  missingExcludeLines,
  excludePath,
  cloneSymlinks,
  readSettings,
  settingsContentFor,
  settingsPath,
  workspacePaths,
  workspaceContent,
  type SettingsJson,
} from '../clone-config.ts';
import { clearColourAssignment } from '../colour-assignments.ts';
import { CliError, run } from '../exec.ts';
import { cloneAt, discoverClones, nextFreeIndex, type Clone } from '../fleet.ts';
import { installPlanLines, runInstall } from '../install.ts';
import { FLEET_GIT_CONFIG, git, gitTry, setFleetGitConfig } from '../git.ts';
import { originUrl } from '../paths.ts';
import { tildify } from '../user-paths.ts';
import { cloneTmpPath, linkStoreEntriesInto } from '../tmp.ts';
import { cloneLabel, heading, note, ok, step, warn } from '../ui.ts';
import { coloursSync } from './colours.ts';
import { statusOf } from './status.ts';
import type { Hangar } from '../hangar.ts';
import { portSummary } from '../ports.ts';

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

export const addClone = (hangar: Hangar, opts: AddCloneOptions): void => {
  const existing = discoverClones(hangar);
  const index = nextFreeIndex(hangar);
  const clone = cloneAt(hangar, index);
  const remoteUrl = opts.remote ?? originUrl;

  if (existsSync(clone.path)) {
    throw new CliError(`${clone.path} already exists`);
  }

  heading(`Creating ${cloneLabel(clone)}`);
  note(`ports ${portSummary(clone.ports)}`);

  // 1. the clone itself
  step(`git clone ${remoteUrl}`);
  const cloned = run('git', ['clone', remoteUrl, clone.name], { cwd: hangar.root, inherit: true });
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
  ok(`.env.local (${portSummary(clone.ports)})`);

  writeFile(envrcPrivatePath(clone), envrcPrivateContent(hangar));
  ok(
    `.envrc.private -> ${tildify(hangar.paths.envShared)} + the fleet bin/ on PATH (both absolute on purpose)`,
  );

  for (const link of cloneSymlinks(clone)) {
    if (!existsSync(dirname(link.path))) {
      if (link.skipIfDirMissing) {
        warn(`no ${dirname(link.relPath)}/ in this branch — ${link.relPath} skipped`);
        continue;
      }
      throw new CliError(
        `${dirname(link.relPath)}/ does not exist, so ${link.relPath} cannot be linked`,
        'Set `skipIfDirMissing: true` on that symlink if a branch may legitimately lack it.',
      );
    }
    if (existsSync(link.path)) continue;
    symlinkSync(relative(dirname(link.path), link.target), link.path);
    ok(`${link.relPath} symlink — ${link.why}`);
  }

  // 6. identity file AND its exclude line, created as a pair.
  writeFile(claudeLocalMdPath(clone), claudeLocalMdContent(clone));
  const exclude = existsSync(excludePath(clone)) ? readFileSync(excludePath(clone), 'utf8') : '';
  if (missingExcludeLines(exclude).length > 0) {
    writeFile(excludePath(clone), exclude + excludeBlock(hangar));
  }
  ok('CLAUDE.local.md + .git/info/exclude (always as a pair)');

  // 6b. its own tmp/, with a link to every entry of the shared store. The directory is the
  // clone's -- its PID files go in it -- and only the cache entries in it are shared, exactly
  // as `hangar tmp merge` maintains for the others. A fresh clone has no cache of its own,
  // so there is nothing to merge, only links to make.
  const tmp = cloneTmpPath(clone);
  mkdirSync(tmp, { recursive: true });
  const { linked, taken } = linkStoreEntriesInto(hangar, tmp);
  ok(`tmp/ (its own) with ${String(linked.length)} link(s) into ${tildify(hangar.paths.tmp)}`);
  if (taken.length > 0) warn(`tmp/ already had ${taken.join(', ')} — not linked`);

  // 7. Claude Code settings: copied, except the two values that must not be.
  writeFile(settingsPath(clone), settingsContentFor(clone, settingsTemplate(existing)));
  ok(
    `.claude/settings.local.json (theme + ${String(healthCheckAllows(clone).length)} health check(s))`,
  );

  // 8-9. theme + workspace. BOTH copies of the workspace file: VS Code only offers a
  //       `*.code-workspace` from the directory you opened, and this repo is opened at its
  //       root and at `angular/`. One of the two is the same silent gap as a missing
  //       `.envrc` -- `doctor` reports it, but only if someone runs `doctor`.
  const workspace = workspaceContent(clone);
  for (const path of workspacePaths(clone)) {
    if (!existsSync(dirname(path))) {
      warn(`${relative(clone.path, path)} skipped — no ${relative(clone.path, dirname(path))}/`);
      continue;
    }
    writeFile(path, workspace);
    ok(relative(clone.path, path));
  }

  // 10. regenerate everything derived from the palette, now that the fleet is bigger. A
  //     colour assignment left at this index by a clone that used to live here is dropped
  //     first: a new clone starts on the formula, and `nextFreeIndex(hangar)` reuses gaps.
  if (clearColourAssignment(hangar, clone.index)) {
    warn(`dropped a leftover colour assignment for index ${String(clone.index)}`);
  }
  heading('Regenerating colour artifacts');
  coloursSync(hangar, {});

  // 11. dependencies -- a clone with its own installed dependencies is the one thing the fleet
  //     exists to provide, so this is the default. The steps come from `repo.install[]`, so a
  //     repo that fetches nothing declares nothing and this prints one line saying so.
  if (opts.install === false) {
    note('Skipped the install steps (--no-install). The clone is not usable until you run them:');
    for (const line of installPlanLines(clone)) note(`  ${line}`);
    note(`Run them with \`hangar install ${clone.name}\`.`);
  } else {
    heading('Installing dependencies');
    runInstall(clone);
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
// From `repo.envrcDirs`, not a hardcoded list. It was `['.', 'angular',
// 'tests/playwright-regression-tests']`, which is this one repo's layout: a hangar for another
// would silently write no `.envrc.private` where its own `.envrc` files live, and direnv would
// load nothing there.
const knownEnvrcDirs = (hangar: Hangar): readonly string[] => hangar.config.repo.envrcDirs;

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
  for (const dir of knownEnvrcDirs(clone.hangar)) dirs.add(dir);
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
