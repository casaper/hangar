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
import { runningServersIn, type RunningServer } from '../procs.ts';
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
 * tracked application code, so a clone whose checked-out tree still writes flat paths keeps its
 * own `tmp/` -- see `blockerFor`, which is also the only thing a live dev server stops.
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
 * They are per clone and they are ephemeral: the file holds a bare pid, `blockerFor` has
 * already left every clone with a live server alone, and the clone's own tooling recreates
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

/** Why one clone keeps its own `tmp/` this time round, and what to do about it. */
type Blocker = { readonly reason: string; readonly hint: string };

/**
 * Whether a clone can be shared yet, and if not, why not.
 *
 * Both conditions used to abort the WHOLE command before the first clone was looked at, which
 * was wrong twice over. A dry run touches nothing, so it has nothing to refuse -- it should
 * report what a real run would leave alone and preview the rest. And one busy clone is no
 * reason to leave the others on their own `tmp/`. They are resolved per clone instead, and in
 * ONE place: two skip conditions tested in two places is how the second one gets forgotten,
 * and how a command that had just stopped erroring errored again on the next line down.
 */
const blockerFor = (
  clone: Clone,
  servers: readonly RunningServer[],
  force: boolean,
): Blocker | undefined => {
  // NOT because the server's PID file would be merged -- no PID file ever is, at any depth
  // (see `discardPidFiles`). Because `tmp/` is about to become a symlink into the shared
  // directory, and a server that outlives the merge writes and unlinks its PID file through
  // whatever that path resolves to NOW: the first thing it touches lands a flat pid file in
  // the shared root, belonging to a clone nobody can identify. The file on disk is stale
  // paperwork; the running process is the problem, so the clone is left as it is.
  if (servers.length > 0) {
    return {
      reason: `${servers.map((s) => `${s.name} (pid ${String(s.pid)})`).join(', ')} still running`,
      hint:
        'Its tmp/ would become a symlink, and that server would then write its PID file ' +
        'through it into the shared root. Stop it (`node dev/pids.mjs --kill <name>` in that ' +
        'clone) and run this again.',
    };
  }
  if (!force && !hasScopedPidDir(clone)) {
    return {
      reason: `${tildify(pidFilesModule(clone))} still writes tmp/<name>.pid`,
      hint:
        'That branch predates the per-clone pid path: two clones could not both run a dev ' +
        'server, and `dev/pids.mjs --kill` could reach a sibling. Land that change and sync, ' +
        'or --force.',
    };
  }
  return undefined;
};

export const tmpMerge = (opts: TmpMergeOptions): void => {
  const dryRun = opts.dryRun === true;
  const clones = discoverClones();
  if (clones.length === 0) throw new CliError('no clones found');

  heading(
    `Merging every clone's tmp/ into ${tildify(fleetTmp)}${dryRun ? pc.dim(' (dry run)') : ''}`,
  );

  // --- which clones can be shared this time round ------------------------------------
  const blockers = new Map<string, Blocker>();
  for (const clone of clones) {
    const blocker = blockerFor(clone, runningServersIn(clone.path), opts.force === true);
    if (blocker !== undefined) blockers.set(clone.name, blocker);
  }
  // Said once, up front, because otherwise a dry run reads as the preview of a merge that is
  // about to happen when in fact not one clone would move.
  if (blockers.size === clones.length) {
    warn(`no clone can be shared yet — all ${String(clones.length)} keep their own tmp/`);
    note('Each one says why below; nothing else here changes either.');
  }

  if (!dryRun) mkdirSync(fleetTmp, { recursive: true });
  const actions: AdoptAction[] = [];

  // --- the old shared Jira store becomes the shared tmp ------------------------------
  // Only once every clone is coming with it. Draining the store MOVES its ticket directories,
  // and a clone that keeps its own `tmp/` keeps a `tmp/<KEY>` symlink pointing into the store
  // -- the old mechanism this replaces. Emptying it under those links leaves every one of them
  // dangling, and `jira-cache.mjs` mkdirs straight through them. The fleet-wide abort used to
  // make that unreachable; with per-clone skipping it is one `if` away.
  const drainStore = existsSync(jiraStore) && blockers.size === 0;
  if (existsSync(jiraStore) && !drainStore) {
    step(`${tildify(jiraStore)} ${pc.dim('— left in place')}`);
    // Named, not counted: the store can only be drained once every one of them is shared, so
    // the list IS the remaining work -- and a clone parked on an old branch can hold it
    // indefinitely, which is only obvious when you can see which clone it is.
    const kept = [...blockers.keys()].join(', ');
    const who =
      blockers.size === 1
        ? `${kept} still links into it from its own tmp/`
        : `${kept} still link into it from their own tmp/`;
    note(`${who}; draining it now would leave those links dangling.`);
  } else if (drainStore) {
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
    // Asked before the blocker: a clone that is already shared has nothing to keep, and a dev
    // server running in one is the stray report's business, not a reason to say "left alone".
    if (isSharedTmp(clone)) {
      ok('already shared');
      continue;
    }
    const blocker = blockers.get(clone.name);
    if (blocker !== undefined) {
      fail(`${blocker.reason} — keeping its own tmp/`);
      note(blocker.hint);
      continue;
    }
    if (!hasScopedPidDir(clone)) warn('flat PID paths — forced');
    if (!existsSync(tmp)) {
      note('no tmp/ yet');
      if (!dryRun) symlinkSync(fleetTmp, tmp);
      ok(`linked → ${tildify(fleetTmp)}`);
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
      // The OLD sharing mechanism: `tmp/<KEY>` linked into ~/.claude/dvb-gn-jira. The link
      // goes either way, but for different reasons -- the store's contents have just been
      // moved into the shared tmp, or the store is still there and holding it for the clones
      // that could not come along, in which case this clone re-fetches the ticket into the
      // shared tmp on demand. Checked by target rather than by `realpathSync`, so a dry run
      // reports it correctly even though the store is still there either way.
      const link = linkTarget(path);
      if (link !== undefined && (isInside(link, jiraStore) || isInside(link, fleetTmp))) {
        const why = drainStore ? 'symlink into the store' : 'symlink into the store it kept';
        note(pc.dim(`${clone.name}/${entry}: ${why}, removing`));
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
  const carried =
    'PID files are never carried over, at any depth — each clone recreates ' +
    'tmp/_<clone>/ the next time it starts a server.';
  if (blockers.size === 0) {
    note(`Every clone ${dryRun ? 'would see' : 'now sees'} the same tmp/. ${carried}`);
  } else {
    const kept = [...blockers.keys()].join(', ');
    note(
      `${String(clones.length - blockers.size)} of ${String(clones.length)} clones ` +
        `${dryRun ? 'would share' : 'share'} tmp/; ${kept} ` +
        `${blockers.size === 1 ? 'keeps its' : 'keep their'} own for the reason above. ${carried}`,
    );
  }

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
