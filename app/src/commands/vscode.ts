import { existsSync } from 'node:fs';
import { relative } from 'node:path';

import pc from 'picocolors';

import { CONFIG_FILENAME } from '../config/load.ts';
import { CliError } from '../exec.ts';
import { discoverClones, requireClone, type Clone } from '../fleet.ts';
import { currentBranch } from '../git.ts';
import { tildify } from '../user-paths.ts';
import { cloneLabel, heading, note, ok, table, warn } from '../ui.ts';
import {
  editorFor,
  isTracked,
  type EditorArtifact,
  type EditorDriver,
  type EditorKind,
} from '../editor/index.ts';
import {
  changedKeys,
  foreignClonePaths,
  pickSource,
  readCopy,
  render,
  templatize,
  writeCopy,
  type CopyState,
} from '../editor/vscode.ts';

/**
 * `hangar ide vscode sync` -- one VS Code setup across the fleet, with the per-clone paths
 * still per clone.
 *
 * The mechanics live in `../vscode.ts`; this file is the report. Each artifact is handled on
 * its own and chooses its own source -- the most recently modified copy of THAT file -- because
 * they drift independently: `settings.json` may be newest in one clone while `mcp.json` exists
 * in only two.
 */
export type EditorSyncOptions = {
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

const readCopies = (artifact: EditorArtifact, clones: readonly Clone[]): CopyState[] =>
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
/**
 * Is this artifact off-limits, taking the declared flag as a floor and letting git only ADD?
 *
 * Asked of every copy in every clone, and ANY yes wins. That is the conservative direction and
 * the only safe one: an artifact one clone tracks is versioned per branch for the whole fleet,
 * so writing it anywhere would import one branch's content into another's checkout. The declared
 * flag alone would miss a file that is gitignored in this repo and tracked in someone else's --
 * `.idea/` is exactly that -- and git alone would make the protection depend on which branch
 * happens to be checked out, which is worse than not having it.
 */
const trackedAnywhere = (
  artifact: EditorArtifact,
  clones: readonly Clone[],
): { tracked: boolean; byGit: Clone | undefined } => {
  if (artifact.tracked) return { tracked: true, byGit: undefined };
  const byGit = clones.find((clone) =>
    artifact.copies(clone).some((path) => isTracked(artifact, clone, path)),
  );
  return { tracked: byGit !== undefined, byGit };
};

const compareTracked = (
  artifact: EditorArtifact,
  clones: readonly Clone[],
  byGit: Clone | undefined,
): Result => {
  heading(artifact.id);
  note('tracked by git — compared only; git is what syncs it, per branch');
  if (byGit !== undefined) {
    // Worth saying out loud: this artifact's table calls it untracked, and it is only protected
    // because a clone turned out to track it. That is a fact about the repo, not about Hangar.
    note(`not in the declared table — ${byGit.name} tracks it, so no clone is written`);
  }

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
  artifact: EditorArtifact,
  clones: readonly Clone[],
  opts: EditorSyncOptions,
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

/**
 * The engine, for whichever editor was asked for.
 *
 * One implementation serves both editors with no branch in it, and that falls out of the config
 * rather than being arranged: JetBrains artifacts declare no `rootKeys`, which makes
 * `templatize`/`render` an identity transform, so "copy it everywhere" is just the degenerate
 * case of "template it and render it per clone".
 */
export const editorSync = (driver: EditorDriver, opts: EditorSyncOptions): void => {
  const clones = discoverClones();
  if (clones.length === 0) throw new CliError('no clones in the fleet');

  let changed = 0;
  let blocked = false;
  let present = 0;
  const drifted: string[] = [];
  for (const artifact of driver.artifacts) {
    const { tracked, byGit } = trackedAnywhere(artifact, clones);
    const result = tracked
      ? compareTracked(artifact, clones, byGit)
      : syncUntracked(artifact, clones, opts);
    if (clones.some((clone) => artifact.copies(clone).some((path) => existsSync(path)))) {
      present += 1;
    }
    changed += result.changed;
    blocked = blocked || result.blocked;
    drifted.push(...result.drifted);
  }

  console.log();
  if (blocked) {
    throw new CliError(
      'a rendered file still points into another clone',
      'A clone-specific setting is missing from SETTINGS_ROOT_KEYS in app/src/editor/vscode.ts.\n' +
        '       Add it there (key -> path relative to the clone root) and run this again.',
    );
  }
  // Distinct from "nothing changed": an editor nobody has opened a clone in yet has no files at
  // all, and reporting that as "in sync" would hide the reason there is nothing to do.
  if (present === 0) {
    warn(`no clone has any ${driver.label} project files yet — nothing to sync`);
    note(
      `Open a clone in ${driver.label} once; it writes them itself, and Hangar never invents them.`,
    );
    return;
  }
  if (changed === 0) ok(`every clone has the same untracked ${driver.label} setup`);
  else if (opts.dryRun === true) warn(`${changed} file(s) would change — rerun without --dry-run`);
  else ok(`${changed} file(s) updated`);

  if (drifted.length > 0) {
    warn(`${drifted.join(' and ')} differ between clones — resolve with git, not this command`);
    note('they are versioned per branch, so the newest copy is not automatically the right one');
  }
};

/** `hangar ide <kind> sync` -- refuses rather than acting on an editor this hangar is not set up for. */
export const syncEditor = (kind: EditorKind, opts: EditorSyncOptions): void => {
  const { driver, fellBack } = editorFor(kind);
  if (fellBack) {
    // The list this was checked against is the schema default, not the developer's -- so
    // "add it to editor.kinds" would be the wrong advice, and syncing the default editor
    // silently would be worse.
    throw new CliError(
      `${CONFIG_FILENAME} would not parse, so this hangar's editors are unknown`,
      '`hangar config validate` says what is wrong.',
    );
  }
  if (driver === undefined) {
    throw new CliError(
      `${kind} is not one of this hangar's editors`,
      'Add it to `editor.kinds` in hangar.config.yaml.',
    );
  }
  if (!driver.capabilities.syncArtifacts) {
    throw new CliError(
      `${driver.label} has nothing Hangar can sync`,
      'Its project files are either generated state or tracked by git — see the driver header for which.',
    );
  }
  editorSync(driver, opts);
};
