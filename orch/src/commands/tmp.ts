import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import pc from 'picocolors';

import { adoptInto, type AdoptAction } from '../adopt.ts';
import { excludePath, EXCLUDE_BLOCK, missingExcludeLines } from '../clone-config.ts';
import { CliError } from '../exec.ts';
import { discoverClones, type Clone } from '../fleet.ts';
import { fleetTmp, jiraStore, tildify } from '../paths.ts';
import { runningServersIn } from '../procs.ts';
import { hasScopedPidDir, isSharedTmp, pidFilesModule } from '../tmp.ts';
import { cloneLabel, fail, heading, note, ok, step, warn } from '../ui.ts';

/**
 * `orch-util tmp merge` -- turn three per-clone `tmp/` directories into one shared one.
 *
 * `tmp/` holds two very different things: per-ticket Jira caches, which every clone wants to
 * share, and live PID files, which are strictly per clone. Sharing the directory is therefore
 * only safe once the clone's own tooling writes its PID files into `tmp/_<clone>/` -- otherwise
 * the first clone to start a dev server blocks the other two, and `dev/pids.mjs --kill` reaches
 * into a sibling. That change is tracked application code, so this command REFUSES until it is
 * present in the clone's checked-out tree.
 */

export type TmpMergeOptions = { dryRun?: boolean | undefined; force?: boolean | undefined };

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
    for (const entry of readdirSync(jiraStore)) {
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

    for (const entry of readdirSync(tmp)) {
      const path = join(tmp, entry);
      if (entry === '.DS_Store') {
        note(pc.dim(`${clone.name}/${entry}: junk, removing`));
        if (!dryRun) rmSync(path);
        continue;
      }
      if (entry.endsWith('.pid')) {
        // The live-server guard above has already established that these are all dead.
        note(pc.dim(`${clone.name}/${entry}: stale pid file, removing`));
        if (!dryRun) rmSync(path);
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
  note('Every clone now sees the same tmp/. PID files stay per clone in tmp/_<clone>/.');
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
