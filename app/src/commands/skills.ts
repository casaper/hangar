import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { CliError } from '../exec.ts';
import { discoverClones } from '../fleet.ts';
import { gitTry } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { blank, heading, note, ok, step, table, warn } from '../ui.ts';
import { claudeDir, tildify } from '../user-paths.ts';

/**
 * `hangar skills` -- the personal Claude Code skills this hangar keeps, and whether they have
 * gone stale.
 *
 * **Why hangar owns this at all.** A skill at `~/.claude/skills/<name>/` shadows a same-named
 * project skill ENTIRELY, on this machine, in every repo -- documented precedence is enterprise >
 * personal > project, keyed on the directory name. That is the supported way to run a personal,
 * faster version of a skill a project tracks, and it needs no change to the project at all. What
 * it does not come with is any way to notice the tracked original moving underneath you: the
 * shadow is silent by design, so a stale personal copy looks exactly like a current one until it
 * recommends something the project now refuses. That happened here once, to a `fix-commit`
 * override that went on teaching a rewrite workflow the repo had banned.
 *
 * So the content lives in this repo -- tracked, diffable, reviewable -- and `~/.claude/skills/
 * <name>` is a SYMLINK to it. Claude Code documents that it follows such a link and loads the
 * skill once even when several point at one target.
 *
 * **The two-hangars problem is real here and cannot be named away.** Everything else a hangar
 * writes under `~/.claude` carries the hangar id in its filename -- the statusline script, the
 * themes -- precisely so a second hangar cannot clobber it. A skill cannot: the directory name IS
 * what makes it shadow, so `<id>-shorten-comment` would shadow nothing and simply be a different
 * skill. What a symlink buys instead is that the collision becomes INSPECTABLE -- the target says
 * which hangar owns it -- so `sync` refuses a link pointing somewhere else and says where, rather
 * than one hangar silently overwriting the other's copy.
 */

/** How a personal copy is allowed to differ from the project skill it shadows. */
export type Divergence = 'intentional' | 'none' | 'standalone';

export type SkillEntry = {
  readonly name: string;
  readonly divergence: Divergence;
  /** Path of the project skill this shadows, relative to a clone root. Absent when standalone. */
  readonly mirrors?: string | undefined;
  /**
   * The blob the override was derived from, for `intentional` entries.
   *
   * Comparing CONTENT is the wrong question for a copy that is meant to differ -- it differs by
   * design, and would be red forever. The question worth asking is whether the ORIGINAL has moved
   * since the override was taken off it, which is what this records.
   */
  readonly basedOn?: string | undefined;
  /**
   * The branch the override was taken off, when the counterpart is not on the default branch YET.
   *
   * Without it, "absent from the default branch" has two readings a `rev-parse` cannot separate:
   * the original was removed, or it has not landed. Declaring the branch says which, so a skill
   * adopted ahead of its merge waits quietly while a skill deleted upstream still goes red. It
   * also records where the `basedOn` blob is reachable from, which is nowhere else until then.
   * Vestigial once the branch merges -- the comparison resumes on its own -- and removable.
   */
  readonly adoptedFrom?: string | undefined;
  readonly reason?: string | undefined;
};

export type SkillsManifest = { readonly skills: readonly SkillEntry[] };

export const skillsDir = (hangar: Hangar): string => join(hangar.root, 'personal-skills');

export const manifestPath = (hangar: Hangar): string => join(skillsDir(hangar), 'manifest.yaml');

/** Where the shadow goes. Machine-global and unnamespaceable -- see the note above. */
export const linkPath = (name: string): string => join(claudeDir, 'skills', name);

export const sourcePath = (hangar: Hangar, name: string): string => join(skillsDir(hangar), name);

/**
 * The manifest is PARSED, not cast, and that is not ceremony.
 *
 * YAML types scalars by their shape, so a 40-character blob that happens to be all digits comes
 * back as a NUMBER -- and the first thing done with `basedOn` is `.slice`, which a number has no
 * business answering. Measured: it threw a raw Node stack trace out of `skills list`, which is
 * the "wrong answer that typechecks" failure this CLI is built against, reached through a file a
 * person edits by hand. `z.string()` refuses the unquoted form and names the field.
 */
const entrySchema = z
  .object({
    name: z.string().min(1),
    divergence: z.enum(['intentional', 'none', 'standalone']),
    mirrors: z.string().min(1).optional(),
    basedOn: z.string().min(1).optional(),
    adoptedFrom: z.string().min(1).optional(),
    reason: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.divergence !== 'standalone' && entry.mirrors === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `\`${entry.name}\` is \`${entry.divergence}\` but declares no \`mirrors:\` path to compare against`,
      });
    }
    if (entry.divergence === 'standalone' && entry.adoptedFrom !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `\`${entry.name}\` is \`standalone\` but names an \`adoptedFrom:\` branch, and nothing standalone is ever compared against one`,
      });
    }
    if (entry.divergence === 'intentional' && entry.basedOn === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `\`${entry.name}\` diverges on purpose but records no \`basedOn:\` blob, so nothing can tell you when the original moves`,
      });
    }
  });

const manifestSchema = z.object({ skills: z.array(entrySchema).default([]) });

export const readManifest = (hangar: Hangar): SkillsManifest => {
  const path = manifestPath(hangar);
  if (!existsSync(path)) return { skills: [] };
  const result = manifestSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!result.success) {
    throw new CliError(
      `${tildify(path)} is not a valid skills manifest`,
      result.error.issues
        .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n'),
    );
  }
  return result.data;
};

/**
 * The clone the tracked originals are read from.
 *
 * The LOWEST-INDEXED one, not "any clone": which clones exist is derived from the filesystem and
 * the order it answers in is not a promise, so an unqualified pick would make a drift report that
 * changes between runs for reasons nobody can see. The clone is a read source only -- nothing is
 * ever written there, and the branch it happens to have checked out is never consulted.
 */
export const readSourceClone = (hangar: Hangar): string | undefined =>
  discoverClones(hangar)
    .slice()
    .sort((a, b) => a.index - b.index)[0]?.path;

export type DriftState =
  | { readonly kind: 'ok'; readonly detail: string }
  | { readonly kind: 'drifted'; readonly detail: string }
  | { readonly kind: 'pending'; readonly detail: string }
  | { readonly kind: 'standalone'; readonly detail: string }
  | { readonly kind: 'not-compared'; readonly detail: string };

/** Everything the verdict depends on, so the verdict itself can be decided without a clone. */
export type DriftFacts = {
  /**
   * The hangar's default branch. Optional in the schema by design -- it is autofilled by the
   * first command that ACTS on it, and a report must not be the thing that writes it -- so a
   * hangar can genuinely be asked this before anything has answered it.
   */
  readonly branch: string | undefined;
  /** Whether there was a clone to read the originals from at all. */
  readonly repoFound: boolean;
  /** Whether that clone has the default branch. A shallow or unfetched one may not. */
  readonly hasBranch: boolean;
  /** The blob at `<branch>:<mirrors>`, or undefined when nothing is there. */
  readonly original: string | undefined;
  /** The hash of the copy kept here. Only `none` entries compare against it. */
  readonly ours: string | undefined;
};

/**
 * The verdict, given the facts -- pure, so every state can be asserted without a clone, a branch
 * or a working tree, which is the only way the ones that need a REMOVED original get covered.
 */
export const classifyDrift = (entry: SkillEntry, facts: DriftFacts): DriftState => {
  if (entry.divergence === 'standalone') {
    return { kind: 'standalone', detail: entry.reason ?? 'no tracked counterpart' };
  }
  if (entry.mirrors === undefined) {
    return { kind: 'not-compared', detail: 'declares no `mirrors:` path' };
  }
  if (!facts.repoFound) {
    return { kind: 'not-compared', detail: 'no clone to read the original from' };
  }
  if (facts.branch === undefined) {
    return { kind: 'not-compared', detail: 'no `forge.defaultBranch` to read the original from' };
  }

  if (facts.original === undefined) {
    if (!facts.hasBranch) {
      return { kind: 'not-compared', detail: `${facts.branch} is not in that clone` };
    }
    /*
     * Nothing at that path on the default branch, and `adoptedFrom` is what says which of the two
     * meanings applies.
     *
     * Declared: the skill was adopted before its branch merged, so absence is the EXPECTED state
     * and waiting is not a finding. Going red through the wait would buy nothing -- the moment
     * the blob appears, the `basedOn` comparison below resumes by itself and reports a skill that
     * changed on the way in. So the redness detects nothing the merge would not; it only nags,
     * and a `doctor` row that reads as a chore for weeks is the row people learn to skip.
     *
     * Undeclared: the original really is gone, which is a finding -- the copy here now shadows
     * nothing and is following prose the project has dropped.
     */
    return entry.adoptedFrom === undefined
      ? { kind: 'drifted', detail: `the original is gone from ${facts.branch}` }
      : {
          kind: 'pending',
          detail: `not on ${facts.branch} yet -- adopted from ${entry.adoptedFrom}`,
        };
  }

  if (entry.divergence === 'intentional') {
    if (entry.basedOn === undefined) {
      return { kind: 'not-compared', detail: 'records no `basedOn:` to compare against' };
    }
    return facts.original === entry.basedOn
      ? { kind: 'ok', detail: `diverges on purpose from ${facts.original.slice(0, 9)}` }
      : {
          kind: 'drifted',
          detail: `the original moved: ${entry.basedOn.slice(0, 9)} -> ${facts.original.slice(0, 9)}`,
        };
  }

  return facts.ours === facts.original
    ? { kind: 'ok', detail: 'byte-identical to the original' }
    : { kind: 'drifted', detail: 'should match the original and does not' };
};

/**
 * Whether a personal copy still stands in the right relationship to the project skill it shadows.
 *
 * Read from the DEFAULT BRANCH rather than whatever is checked out. A clone is a working tree
 * somebody else is using; reading its current branch would make this answer depend on which
 * ticket that developer happens to be on, which is the underspecified-`string` failure this CLI
 * is built against.
 */
export const driftFor = (
  hangar: Hangar,
  entry: SkillEntry,
  repo: string | undefined,
): DriftState => {
  const branch = hangar.config.forge.defaultBranch;
  const nothing = { branch, hasBranch: false, original: undefined, ours: undefined };

  if (repo === undefined || entry.mirrors === undefined) {
    return classifyDrift(entry, { ...nothing, repoFound: repo !== undefined });
  }

  const original = gitTry(repo, ['rev-parse', `${branch}:${entry.mirrors}`]);
  // Only asked when there is nothing at the path: a blob that resolved proves the branch exists.
  const hasBranch =
    original !== undefined ||
    gitTry(repo, ['rev-parse', '--verify', `${branch}^{commit}`]) !== undefined;
  const ours =
    entry.divergence === 'none'
      ? gitTry(hangar.root, ['hash-object', sourcePath(hangar, entry.name)])
      : undefined;

  return classifyDrift(entry, { branch, repoFound: true, hasBranch, original, ours });
};

/** What a link at `~/.claude/skills/<name>` currently is. */
export type LinkState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ours' }
  | { readonly kind: 'foreign'; readonly target: string }
  | { readonly kind: 'not-a-link' };

export const linkState = (hangar: Hangar, name: string): LinkState => {
  const path = linkPath(name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: 'absent' };
  }
  if (!stat.isSymbolicLink()) return { kind: 'not-a-link' };
  const target = readlinkSync(path);
  return target === sourcePath(hangar, name) ? { kind: 'ours' } : { kind: 'foreign', target };
};

export type SkillsOptions = { dryRun?: boolean | undefined; adopt?: boolean | undefined };

/**
 * Whether a real directory at the link path holds exactly what this hangar would link to.
 *
 * `--adopt` exists because the safe default -- refuse to touch a real directory -- leaves the
 * command unable to ever do its job on a machine that already has the hand-copied skills, which
 * is every machine this is being introduced on. The precondition is what makes it safe rather
 * than merely convenient: it replaces a directory only when replacing it LOSES NOTHING, so the
 * failure mode is a refusal, never a silently discarded edit somebody made in `~/.claude`.
 */
export const adoptable = (hangar: Hangar, name: string): boolean => {
  const source = sourcePath(hangar, name);
  const live = linkPath(name);
  if (!existsSync(source) || !existsSync(live)) return false;
  const files = readdirSync(source).sort();
  if (JSON.stringify(files) !== JSON.stringify(readdirSync(live).sort())) return false;
  return files.every((file) => {
    try {
      return readFileSync(join(source, file)).equals(readFileSync(join(live, file)));
    } catch {
      return false;
    }
  });
};

export const skillsList = (hangar: Hangar): void => {
  const manifest = readManifest(hangar);
  const repo = readSourceClone(hangar);

  if (manifest.skills.length === 0) {
    note(`No personal skills declared in ${tildify(manifestPath(hangar))}.`);
    return;
  }

  heading('Personal skills');
  const rows = manifest.skills.map((entry) => {
    const drift = driftFor(hangar, entry, repo);
    const link = linkState(hangar, entry.name);
    const linkText =
      link.kind === 'ours'
        ? 'linked'
        : link.kind === 'absent'
          ? 'not linked'
          : link.kind === 'foreign'
            ? `OTHER: ${tildify(link.target)}`
            : 'real directory';
    return [entry.name, linkText, drift.kind, drift.detail];
  });
  table([['SKILL', 'LINK', 'DRIFT', 'DETAIL'], ...rows]);

  if (repo === undefined) {
    blank();
    note('No clone to read the tracked originals from, so nothing was compared.');
  }
};

export const skillsSync = (hangar: Hangar, opts: SkillsOptions = {}): void => {
  const manifest = readManifest(hangar);
  if (manifest.skills.length === 0) {
    note(`No personal skills declared in ${tildify(manifestPath(hangar))}.`);
    return;
  }

  heading(opts.dryRun === true ? 'Would link personal skills' : 'Linking personal skills');
  mkdirSync(join(claudeDir, 'skills'), { recursive: true });

  for (const entry of manifest.skills) {
    const source = sourcePath(hangar, entry.name);
    const path = linkPath(entry.name);

    if (!existsSync(source)) {
      warn(`${entry.name}: ${tildify(source)} does not exist — declared but not written`);
      continue;
    }

    const state = linkState(hangar, entry.name);

    if (state.kind === 'ours') {
      note(`${entry.name}: already linked`);
      continue;
    }

    /*
     * The two-hangars refusal, and the reason this is a refusal rather than an overwrite. A
     * skill name cannot carry a hangar id without ceasing to shadow, so two hangars genuinely
     * want this one path. Replacing what the other one put there would be the silent clobber the
     * symlink exists to make visible; naming it is the whole benefit.
     */
    if (state.kind === 'foreign') {
      warn(
        `${entry.name}: left alone — it points at ${tildify(state.target)}, which is not this hangar`,
      );
      continue;
    }
    if (state.kind === 'not-a-link') {
      if (opts.adopt !== true) {
        warn(
          `${entry.name}: left alone — ${tildify(path)} is a real directory. ` +
            `Re-run with --adopt to replace it, which is refused unless it matches byte for byte`,
        );
        continue;
      }
      if (!adoptable(hangar, entry.name)) {
        warn(
          `${entry.name}: NOT adopted — ${tildify(path)} differs from this hangar's copy, so ` +
            `replacing it would discard something. Reconcile them first`,
        );
        continue;
      }
      step(`${entry.name} -> ${tildify(source)} (adopted, content identical)`);
      if (opts.dryRun !== true) {
        rmSync(path, { recursive: true, force: true });
        symlinkSync(source, path);
      }
      continue;
    }

    step(`${entry.name} -> ${tildify(source)}`);
    if (opts.dryRun !== true) {
      rmSync(path, { force: true });
      symlinkSync(source, path);
    }
  }

  if (opts.dryRun !== true) {
    blank();
    ok('Linked. A new Claude Code session picks these up; a running one does not.');
  }
};

/** One `doctor` row per declared skill, so a drifted override is reported where things are checked. */
export const skillDriftRows = (
  hangar: Hangar,
): readonly { name: string; ok: boolean; detail: string }[] => {
  const manifest = existsSync(manifestPath(hangar)) ? readManifest(hangar) : { skills: [] };
  const repo = readSourceClone(hangar);
  return manifest.skills.map((entry) => {
    const drift = driftFor(hangar, entry, repo);
    const link = linkState(hangar, entry.name);

    /*
     * The question this row asks is "is the skill actually in effect the one this hangar
     * tracks", NOT "is it a symlink".
     *
     * That distinction is the difference between a useful check and one nobody reads. A real
     * directory holding byte-identical content is not a problem -- the right prose is loading,
     * and `sync --adopt` is an optional tidy-up. Going red on it would leave every row red
     * forever for anyone who simply prefers real directories, which is exactly the check this
     * codebase refuses to add. A directory whose content DIFFERS is a genuine finding: the
     * skill being followed is not the one under review here.
     */
    const linkProblem =
      link.kind === 'foreign' || (link.kind === 'not-a-link' && !adoptable(hangar, entry.name));
    return {
      name: `personal skill ${entry.name}`,
      // `drifted` is the only failing state. `not-compared`, `standalone` and `pending` are all
      // normal: a shallow clone, a skill with no counterpart, and one adopted before its branch
      // merged. None of them means anything is wrong, and a row red in normal operation is read
      // as broken -- this one was, on the day it was added.
      ok: drift.kind !== 'drifted' && !linkProblem,
      detail: linkProblem
        ? link.kind === 'foreign'
          ? `linked to ${tildify(link.target)}, which is not this hangar`
          : `${tildify(linkPath(entry.name))} is a real directory whose content differs from ${skillsSourceHint(hangar)}/${entry.name}`
        : drift.detail,
    };
  });
};

/** Printed by `add-clone` and the like: where the sources are, relative to the hangar root. */
export const skillsSourceHint = (hangar: Hangar): string =>
  relative(hangar.root, skillsDir(hangar));
