import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import pc from 'picocolors';

import { adoptInto, type AdoptAction } from '../adopt.ts';
import { excludePath, EXCLUDE_BLOCK, missingExcludeLines } from '../clone-config.ts';
import { CliError } from '../exec.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import { fleetTmp, jiraStore, tildify } from '../paths.ts';
import { runningServersIn } from '../procs.ts';
import { hasScopedPidDir, isSharedTmp, pidFilesModule, strayPidFilesInSharedTmp } from '../tmp.ts';
import { cloneLabel, fail, heading, note, ok, step, warn } from '../ui.ts';

/**
 * `orch-util tmp merge` -- turn three per-clone `tmp/` directories into one shared one.
 *
 * `tmp/` holds two very different things: per-ticket Jira caches, which every clone wants to
 * share, and live PID files, which are strictly per clone and are never carried across at all
 * (see `discardPidFiles`). Sharing the directory is only safe once the clone's own tooling
 * writes its PID files into `tmp/_<clone>/` -- otherwise the first clone to start a dev server
 * blocks the other two, and `dev/pids.mjs --kill` reaches into a sibling. That change is
 * tracked application code, so this command REFUSES until it is present in the clone's
 * checked-out tree.
 */

export type TmpMergeOptions = { dryRun?: boolean | undefined; force?: boolean | undefined };

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Every file under `dir`, at any depth.
 *
 * Depth matters because the per-clone PID directory `tmp/_<clone>/` is exactly where the
 * migrated tooling writes, so the interesting files are one level down rather than in the
 * root -- and a recursive walk needs no list of the shapes they can take.
 */
const filesUnder = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    return isDirectory(path) ? filesUnder(path) : [path];
  });
};

const isPidFile = (path: string): boolean => path.endsWith('.pid');

/**
 * A directory with nothing worth sharing in it: the per-clone PID directory `_<clone>/`, and
 * the empty shell it becomes once its PID files are discarded.
 *
 * The empty case is the one that matters. `discardPidFiles` runs first, so by the time the
 * entries are walked the PID directory is already empty -- and an empty directory handed to
 * `adoptInto` is recreated in the shared `tmp/`, which is precisely the `tmp/_clone_NN/` that
 * must not be merged. `[].every()` is true, so both cases fall out of one test.
 */
const holdsNothingToShare = (path: string): boolean =>
  isDirectory(path) && filesUnder(path).every(isPidFile);

/**
 * PID files are NEVER carried into the shared `tmp/`, at any depth.
 *
 * They are per clone and they are ephemeral: the file holds a bare pid, the guard above has
 * already established that no server is running, and the clone's own tooling recreates
 * `tmp/_<clone>/` the moment it next starts one. So a PID file in the tmp/ being merged is
 * dead weight -- carrying it into the shared directory would put one clone's leftovers in
 * front of every other clone, which is the exact confusion sharing `tmp/` has to avoid.
 */
const discardPidFiles = (label: string, dir: string, dryRun: boolean): void => {
  for (const path of filesUnder(dir).filter(isPidFile)) {
    note(
      pc.dim(
        `${label}/${relative(dir, path)}: pid file — never shared, ${dryRun ? 'would be discarded' : 'discarded'}`,
      ),
    );
    if (!dryRun) rmSync(path);
  }
};

export const tmpMerge = (opts: TmpMergeOptions): void => {
  const dryRun = opts.dryRun === true;
  const clones = discoverClones();
  if (clones.length === 0) throw new CliError('no clones found');

  heading(
    `Merging every clone's tmp/ into ${tildify(fleetTmp)}${dryRun ? pc.dim(' (dry run)') : ''}`,
  );

  // --- guards ------------------------------------------------------------------------
  const serving = clones.filter((clone) => runningServersIn(clone.path).length > 0);
  if (serving.length > 0) {
    for (const clone of serving) {
      const servers = runningServersIn(clone.path);
      fail(`${clone.name}: ${servers.map((s) => `${s.name} (pid ${s.pid})`).join(', ')}`);
    }
    throw new CliError(
      'a live server holds a PID file in the tmp/ being moved',
      'Stop them (`node dev/pids.mjs --kill <name>` in that clone) and run this again.',
    );
  }

  const stale = clones.filter((clone) => !hasScopedPidDir(clone));
  if (stale.length > 0 && opts.force !== true) {
    for (const clone of stale)
      fail(`${clone.name}: ${tildify(pidFilesModule(clone))} still writes tmp/<name>.pid`);
    throw new CliError(
      'a clone would write PID files into the shared tmp/ root',
      'That branch predates the per-clone pid path: two clones could not both run a dev server, ' +
        'and `dev/pids.mjs --kill` could reach a sibling. Land that change and sync, or --force.',
    );
  }
  for (const clone of stale) warn(`${clone.name}: flat PID paths — forced`);

  if (!dryRun) mkdirSync(fleetTmp, { recursive: true });
  const actions: AdoptAction[] = [];

  // --- the old shared Jira store becomes the shared tmp ------------------------------
  if (existsSync(jiraStore)) {
    step(`${tildify(jiraStore)} → ${tildify(fleetTmp)}`);
    discardPidFiles('jira-store', jiraStore, dryRun);
    for (const entry of readdirSync(jiraStore)) {
      if (entry.endsWith('.pid')) continue;
      actions.push(...adoptInto(join(jiraStore, entry), fleetTmp, { label: 'jira-store', dryRun }));
    }
    if (!dryRun) {
      try {
        rmdirSync(jiraStore);
        ok(`removed the empty ${tildify(jiraStore)}`);
      } catch {
        warn(`${tildify(jiraStore)} is not empty — left in place`);
      }
    }
  }

  // --- each clone's tmp/ -------------------------------------------------------------
  for (const clone of clones) {
    const tmp = join(clone.path, 'tmp');
    heading(`${cloneLabel(clone)} ${pc.dim(tildify(tmp))}`);
    if (!existsSync(tmp)) {
      note('no tmp/ yet');
      if (!dryRun) symlinkSync(fleetTmp, tmp);
      ok(`linked → ${tildify(fleetTmp)}`);
      continue;
    }
    if (isSharedTmp(clone)) {
      ok('already shared');
      continue;
    }

    discardPidFiles(clone.name, tmp, dryRun);

    for (const entry of readdirSync(tmp)) {
      const path = join(tmp, entry);
      if (entry === '.DS_Store') {
        note(pc.dim(`${clone.name}/${entry}: junk, removing`));
        if (!dryRun) rmSync(path);
        continue;
      }
      // Already reported and discarded above -- listed again here because a dry run leaves
      // them on disk, and an entry that reaches `adoptInto` is an entry that gets shared.
      if (entry.endsWith('.pid')) continue;
      if (holdsNothingToShare(path)) {
        const why = filesUnder(path).length > 0 ? 'pid files only' : 'nothing left in it';
        note(pc.dim(`${clone.name}/${entry}/: ${why} — not shared, removing`));
        if (!dryRun) rmSync(path, { recursive: true });
        continue;
      }
      // The OLD sharing mechanism: `tmp/<KEY>` linked into ~/.claude/dvb-gn-jira, whose
      // contents have just been moved into the shared tmp. The link is all that is left.
      // Checked by target rather than by `realpathSync`, so a dry run reports it correctly
      // even though the store is still there.
      const link = linkTarget(path);
      if (link !== undefined && (isInside(link, jiraStore) || isInside(link, fleetTmp))) {
        note(pc.dim(`${clone.name}/${entry}: symlink into the store, removing`));
        if (!dryRun) rmSync(path);
        continue;
      }
      actions.push(...adoptInto(path, fleetTmp, { label: clone.name, dryRun }));
    }

    if (dryRun) {
      note(`tmp/ would become a symlink to ${tildify(fleetTmp)}`);
    } else {
      try {
        rmdirSync(tmp);
      } catch {
        warn(`${clone.name}: tmp/ is not empty after the merge — NOT linked`);
        continue;
      }
      symlinkSync(fleetTmp, tmp);
      ok(`tmp/ → ${tildify(fleetTmp)}`);
    }
    excludeTmp(clone, dryRun);
  }

  // --- report ------------------------------------------------------------------------
  console.log('');
  const counts = new Map<string, number>();
  for (const action of actions) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  for (const action of actions) {
    if (action.kind === 'conflict') warn(action.message);
    else if (action.kind === 'skipped') warn(action.message);
  }
  const summary =
    counts.size === 0
      ? 'nothing left to move'
      : [...counts].map(([kind, n]) => `${n} ${kind}`).join(', ');
  ok(`${summary}${dryRun ? ' (dry run)' : ''}`);
  note(
    'Every clone now sees the same tmp/. PID files were not carried over — each clone ' +
      'recreates tmp/_<clone>/ the next time it starts a server.',
  );

  // Nothing this command does can put one here -- so one that IS here came from a clone that
  // still writes flat paths, and it is the file that makes one clone's server look like
  // everyone's. Reported, not deleted: it may belong to a process started since the guard ran.
  const strays = strayPidFilesInSharedTmp();
  if (strays.length > 0) {
    warn(`pid files in the root of the shared tmp/: ${strays.join(', ')}`);
    note('Not put there by this command — a clone on a pre-migration branch writes flat paths.');
  }
};

const linkTarget = (path: string): string | undefined => {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
};

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

/** `.gitignore` says `tmp/`, which does not match a symlink -- the exclude file has to. */
const excludeTmp = (clone: Clone, dryRun: boolean): void => {
  const path = excludePath(clone);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (missingExcludeLines(current).length === 0) return;
  if (dryRun) {
    note(`${clone.name}: .git/info/exclude would gain ${missingExcludeLines(current).join(', ')}`);
    return;
  }
  writeFileSync(path, current + EXCLUDE_BLOCK, 'utf8');
  ok(`${clone.name}: .git/info/exclude hides the tmp symlink`);
};
