import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import pc from 'picocolors';

import { CliError, run } from '../exec.ts';
import { discoverClones } from '../fleet.ts';
import { fleetPlans, fleetRoot, legacyPlans, tildify, userPlans } from '../paths.ts';
import {
  archiveNames,
  bulkCopySeconds,
  conflictName,
  fleetAttribution,
  isStamped,
  moveInto,
  planFilesIn,
  planSources,
  resolveDay,
  setMtimeToDay,
  stampedName,
  type PlanFile,
} from '../plans.ts';
import { planFilesInUse } from '../sessions.ts';
import { fail, heading, note, ok, step, warn } from '../ui.ts';

/**
 * `orch-util plans collect` and `orch-util plans stamp`.
 *
 * Between them they replace the shared `plansDirectory` that Claude Code will not accept (it
 * requires the directory to resolve inside the project root, symlinks followed). Each clone
 * writes plans to its own `.claude/plans`; `collect` gathers them into `<fleet>/plans` with a
 * date in front of the name; `stamp` dates anything already in the archive that has none.
 *
 * Both refuse to touch a plan a live session may still be holding -- see `sessions.ts`.
 */

export type CollectOptions = {
  dryRun?: boolean | undefined;
  transcriptScan?: boolean | undefined;
  inUseWindow?: string | undefined;
};

export type StampOptions = CollectOptions;

const windowMinutes = (opts: CollectOptions): number => {
  const parsed = Number.parseInt(opts.inUseWindow ?? '30', 10);
  return Number.isNaN(parsed) ? 30 : parsed;
};

/** A plan tracked in git is not ours to move -- `~/.claude` is a symlink into a dotfiles repo. */
const isTracked = (path: string): boolean =>
  run('git', ['-C', dirname(path), 'ls-files', '--error-unmatch', basename(path)]).ok;

const relabel = (file: PlanFile): string => `${file.source}/${file.name}`;

export const plansCollect = (opts: CollectOptions): void => {
  const dryRun = opts.dryRun === true;
  heading(`Collecting plans into ${tildify(fleetPlans)}${dryRun ? pc.dim(' (dry run)') : ''}`);

  const inUse = planFilesInUse(windowMinutes(opts));
  note(
    `${inUse.sessions.length} live fleet session(s); ${inUse.names.size} plan file(s) they may still be holding`,
  );

  const sources = planSources();
  // Without a clone there is nothing to collect FROM, and the shared user plans directory is
  // not fleet-scoped: a mistyped DVB_FLEET_ROOT would otherwise drain another project's plans
  // into a stray directory.
  if (discoverClones().length === 0) {
    throw new CliError(
      `no clones found in ${tildify(fleetRoot)}`,
      'plans collect gathers from the clones; run it from the fleet root.',
    );
  }
  const candidates: PlanFile[] = [];
  for (const source of sources) {
    const files = planFilesIn(source.dir, source.label);
    step(`${tildify(source.dir)} — ${files.length} plan(s)`);
    candidates.push(...files);
  }
  const archive = planFilesIn(fleetPlans, 'plans');
  const bulk = bulkCopySeconds([...candidates, ...archive]);
  const attributed = fleetAttribution();
  const userLabel = tildify(userPlans);

  // Skip what is not ours to move, before grouping: an unattributed file in the shared user
  // plans directory belongs to one of this machine's other projects.
  const skipped: string[] = [];
  const movable: PlanFile[] = [];
  for (const file of candidates) {
    const why = inUse.names.get(file.name);
    if (why !== undefined) {
      skipped.push(`${relabel(file)} — ${why}`);
    } else if (isTracked(file.path)) {
      skipped.push(`${relabel(file)} — tracked in git where it lives`);
    } else if (file.source === userLabel && !attributed.has(file.name)) {
      skipped.push(`${relabel(file)} — no fleet session ever mentions it`);
    } else {
      movable.push(file);
    }
  }

  const groups = new Map<string, PlanFile[]>();
  for (const file of [...archive, ...movable]) {
    groups.set(file.stem, [...(groups.get(file.stem) ?? []), file]);
  }

  if (!dryRun) mkdirSync(fleetPlans, { recursive: true });
  const taken = archiveNames();
  let moved = 0;
  let dropped = 0;
  const conflicts: string[] = [];
  const undated: string[] = [];

  for (const [stem, files] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const dated = resolveDay(files, bulk, opts.transcriptScan !== false);
    if (dated === undefined) undated.push(stem);
    const target = dated === undefined ? stem : stampedName(dated.day, stem);

    const inArchive = files.filter((f) => f.source === 'plans');
    const incoming = files.filter((f) => f.source !== 'plans');
    if (incoming.length === 0) continue;

    // One survivor per distinct content. Anything already in the archive wins its own hash.
    const survivors = new Map<string, PlanFile>();
    for (const file of inArchive) survivors.set(file.hash, file);

    for (const file of incoming) {
      const survivor = survivors.get(file.hash);
      if (survivor !== undefined) {
        dropped += 1;
        note(pc.dim(`${relabel(file)} — identical to ${basename(survivor.path)}, dropping`));
        if (!dryRun) rmSync(file.path);
        continue;
      }
      const name =
        survivors.size === 0 && !taken.has(target) ? target : conflictName(target, file.source);
      if (taken.has(name)) {
        conflicts.push(`${relabel(file)} — ${name} already exists, left in place`);
        continue;
      }
      const to = join(fleetPlans, name);
      moved += 1;
      ok(`${relabel(file)} → ${name}${dated === undefined ? pc.dim(' (undated)') : ''}`);
      if (!dryRun) {
        moveInto(file.path, to);
        if (dated !== undefined) setMtimeToDay(to, dated.day);
      }
      taken.add(name);
      survivors.set(file.hash, { ...file, path: to, source: 'plans', name });
    }
  }

  console.log('');
  ok(`${moved} plan(s) ${dryRun ? 'would move' : 'moved'}, ${dropped} duplicate(s) dropped`);
  for (const line of conflicts) warn(line);
  if (undated.length > 0) {
    warn(`${undated.length} plan(s) have no recoverable date and stay unstamped:`);
    for (const stem of undated) note(stem);
  }
  if (skipped.length > 0) {
    note(`${skipped.length} left where they are:`);
    for (const line of skipped) note(line);
  }
  if (existsSync(legacyPlans) && planFilesIn(legacyPlans, 'dvb-gn-plans').length === 0) {
    if (dryRun) note(`${tildify(legacyPlans)} would be empty and can be removed`);
    else {
      rmSync(legacyPlans, { recursive: true });
      ok(`removed the empty ${tildify(legacyPlans)}`);
    }
  }
};

export const plansStamp = (opts: StampOptions): void => {
  const dryRun = opts.dryRun === true;
  heading(`Dating plans in ${tildify(fleetPlans)}${dryRun ? pc.dim(' (dry run)') : ''}`);
  if (!existsSync(fleetPlans)) {
    note('no archive yet — run `orch-util plans collect` first');
    return;
  }

  const inUse = planFilesInUse(windowMinutes(opts));
  const files = planFilesIn(fleetPlans, 'plans');
  const bulk = bulkCopySeconds(files);
  const taken = archiveNames();
  let renamed = 0;
  let already = 0;

  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isStamped(file.name)) {
      already += 1;
      continue;
    }
    const why = inUse.names.get(file.name);
    if (why !== undefined) {
      warn(`${file.name} — ${why}, left alone`);
      continue;
    }
    const dated = resolveDay([file], bulk, opts.transcriptScan !== false);
    if (dated === undefined) {
      fail(`${file.name} — no recoverable date (filename, stat and transcripts all silent)`);
      continue;
    }
    const name = stampedName(dated.day, file.stem);
    if (taken.has(name)) {
      warn(`${file.name} → ${name} already exists, left alone`);
      continue;
    }
    renamed += 1;
    ok(`${file.name} → ${name} ${pc.dim(`(from ${dated.from})`)}`);
    if (!dryRun) {
      moveInto(file.path, join(fleetPlans, name));
      setMtimeToDay(join(fleetPlans, name), dated.day);
    }
    taken.add(name);
  }

  console.log('');
  ok(
    `${renamed} plan(s) ${dryRun ? 'would be dated' : 'dated'}, ${already} already carried a date`,
  );
};
