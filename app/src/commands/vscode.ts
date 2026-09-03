import { relative } from 'node:path';

import pc from 'picocolors';

import { CliError } from '../exec.ts';
import { discoverClones, requireClone, type Clone } from '../fleet.ts';
import { currentBranch } from '../git.ts';
import { tildify } from '../paths.ts';
import { cloneLabel, heading, note, ok, table, warn } from '../ui.ts';
import {
  changedKeys,
  foreignClonePaths,
  pickSource,
  readCopy,
  render,
  templatize,
  writeCopy,
  VSCODE_ARTIFACTS,
  type CopyState,
  type VscodeArtifact,
} from '../vscode.ts';

/**
 * `hangar vscode sync` -- one VS Code setup across the fleet, with the per-clone paths
 * still per clone.
 *
 * The mechanics live in `../vscode.ts`; this file is the report. Each artifact is handled on
 * its own and chooses its own source -- the most recently modified copy of THAT file -- because
 * they drift independently: `settings.json` may be newest in one clone while `mcp.json` exists
 * in only two.
 */
export type VscodeSyncOptions = {
  from?: string | undefined;
  dryRun?: boolean | undefined;
};

type Outcome = 'source' | 'in-sync' | 'rewritten' | 'created' | 'would-rewrite' | 'would-create';

const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  source: pc.cyan('source'),
  'in-sync': pc.dim('in sync'),
  rewritten: pc.green('rewritten'),
  created: pc.green('created'),
  'would-rewrite': pc.yellow('would rewrite'),
  'would-create': pc.yellow('would create'),
};

/** What changed, in the file's own vocabulary, or a line count when the shape shifted. */
const describeChange = (before: string | undefined, after: string): string => {
  if (before === undefined) return '';
  const keys = changedKeys(before, after);
  if (keys.length === 0) return 'formatting only';
  if (before.split('\n').length !== after.split('\n').length) {
    return `${keys.length} key(s), and the file gains or loses lines`;
  }
  return keys.join(', ');
};

type Result = { changed: number; blocked: boolean; drifted: string[] };

const nothing = (): Result => ({ changed: 0, blocked: false, drifted: [] });

const readCopies = (artifact: VscodeArtifact, clones: readonly Clone[]): CopyState[] =>
  clones.flatMap((clone) => artifact.copies(clone).map((path) => readCopy(clone, path)));

/**
 * A git-tracked artifact: compared across the clones, never written.
 *
 * There is deliberately no `--force` here. These files are **versioned per branch**, so the
 * newest copy is not the "right" one -- it is whatever the branch of the clone that last
 * touched it says. Writing it into a sibling would both dirty that sibling's checked-out
 * branch and import another branch's content into it, which is the same mistake as hoisting
 * branch-specific guidance out of a clone. Drift here is git's to resolve, and the branch is
 * printed because that is almost always the explanation.
 */
const compareTracked = (artifact: VscodeArtifact, clones: readonly Clone[]): Result => {
  heading(artifact.id);
  note('tracked by git — compared only; git is what syncs it, per branch');

  const copies = readCopies(artifact, clones).filter((c) => c.text !== undefined);
  if (copies.length === 0) {
    note('no clone has this file');
    return nothing();
  }

  const groups = new Map<string, CopyState[]>();
  for (const copy of copies) {
    const key = copy.text ?? '';
    groups.set(key, [...(groups.get(key) ?? []), copy]);
  }

  const missing = clones.filter((clone) => !copies.some((c) => c.clone.index === clone.index));
  const agrees = groups.size === 1 && missing.length === 0;

  table(
    clones.map((clone) => {
      const copy = copies.find((c) => c.clone.index === clone.index);
      const branch = currentBranch(clone.path);
      if (!copy) return [cloneLabel(clone), pc.yellow('absent'), branch];
      if (agrees) return [cloneLabel(clone), pc.dim('identical'), branch];
      const group = [...groups.keys()].indexOf(copy.text ?? '');
      return [cloneLabel(clone), pc.yellow(`version ${group + 1}`), branch];
    }),
  );

  if (agrees) return nothing();
  return { changed: 0, blocked: false, drifted: [artifact.id] };
};

/** An untracked artifact: templated from one clone's copy and rendered into every clone. */
const syncUntracked = (
  artifact: VscodeArtifact,
  clones: readonly Clone[],
  opts: VscodeSyncOptions,
): Result => {
  const copies = readCopies(artifact, clones);
  const from = opts.from === undefined ? undefined : requireClone(opts.from);
  const source = pickSource(
    from === undefined ? copies : copies.filter((c) => c.clone.index === from.index),
  );

  heading(artifact.id);

  if (!source?.text) {
    note(
      from === undefined
        ? 'no clone has this file — nothing to sync'
        : `clone ${from.index} does not have this file`,
    );
    return nothing();
  }

  const { template, root, nonconforming } = templatize(artifact, source.text, source.clone);
  note(`source: ${tildify(source.path)}`);
  if (root !== undefined) {
    note(
      root === source.clone.path
        ? `clone root in it: ${tildify(root)}`
        : `clone root in it: ${tildify(root)} ${pc.yellow('(not this clone — rewriting per clone repairs it)')}`,
    );
  }
  for (const issue of nonconforming) warn(issue);

  const rows: string[][] = [];
  let changed = 0;
  let blocked = false;

  for (const clone of clones) {
    const wanted = render(template, clone);

    const foreign = foreignClonePaths(wanted, clone);
    if (foreign.length > 0) {
      blocked = true;
      rows.push([
        cloneLabel(clone),
        pc.red('blocked'),
        `points into ${foreign.map((p) => p.split('/').pop() ?? p).join(', ')}`,
      ]);
      continue;
    }

    for (const path of artifact.copies(clone)) {
      const current = readCopy(clone, path);
      // Only worth naming when the artifact has more than one copy per clone, and then it is
      // the path within the clone that distinguishes them, not the clone.
      const detail = artifact.copies(clone).length > 1 ? relative(clone.path, path) : '';

      if (current.text === wanted) {
        rows.push([
          cloneLabel(clone),
          OUTCOME_LABEL[path === source.path ? 'source' : 'in-sync'],
          detail,
        ]);
        continue;
      }

      const creating = current.text === undefined;
      const outcome: Outcome =
        opts.dryRun === true
          ? creating
            ? 'would-create'
            : 'would-rewrite'
          : creating
            ? 'created'
            : 'rewritten';

      if (opts.dryRun !== true) writeCopy(path, wanted);
      changed += 1;
      rows.push([
        cloneLabel(clone),
        OUTCOME_LABEL[outcome],
        [detail, describeChange(current.text, wanted)].filter(Boolean).join(' — '),
      ]);
    }
  }

  table(rows);
  return { changed, blocked, drifted: [] };
};

export const vscodeSync = (opts: VscodeSyncOptions): void => {
  const clones = discoverClones();
  if (clones.length === 0) throw new CliError('no clones in the fleet');

  let changed = 0;
  let blocked = false;
  const drifted: string[] = [];
  for (const artifact of VSCODE_ARTIFACTS) {
    const result = artifact.tracked
      ? compareTracked(artifact, clones)
      : syncUntracked(artifact, clones, opts);
    changed += result.changed;
    blocked = blocked || result.blocked;
    drifted.push(...result.drifted);
  }

  console.log();
  if (blocked) {
    throw new CliError(
      'a rendered file still points into another clone',
      'A clone-specific setting is missing from SETTINGS_ROOT_KEYS in app/src/vscode.ts.\n' +
        '       Add it there (key -> path relative to the clone root) and run this again.',
    );
  }
  if (changed === 0) ok('every clone has the same untracked VS Code setup');
  else if (opts.dryRun === true) warn(`${changed} file(s) would change — rerun without --dry-run`);
  else ok(`${changed} file(s) updated`);

  if (drifted.length > 0) {
    warn(`${drifted.join(' and ')} differ between clones — resolve with git, not this command`);
    note('they are versioned per branch, so the newest copy is not automatically the right one');
  }
};
