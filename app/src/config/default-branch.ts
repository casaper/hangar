import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isMap, isScalar, parse as parseYaml, parseDocument, type Document } from 'yaml';

import { CliError, run } from '../exec.ts';
import { discoverClones } from '../fleet.ts';
import { defaultBranchFromGit, setRemoteHeadAuto } from '../git.ts';
import { fleetRoot, tildify } from '../paths.ts';
import { note, step, warn } from '../ui.ts';
import { CONFIG_FILENAME, loadConfigFile } from './load.ts';
import { hangarConfigSchema } from './schema.ts';

/**
 * `forge.defaultBranch` -- the one place the hangar's default branch is answered from.
 *
 * Every clone in a hangar is a clone of ONE repo, so its default branch is a property of the
 * hangar and not of a clone. It used to be re-derived per clone per command, from
 * `origin/HEAD`, which is a local symref: a `--single-branch` clone has none, an older git
 * never fills one in, and the old fallback was the literal `master` -- wrong for every repo
 * that uses `main`, and wrong SILENTLY, which is the failure mode this fleet is built against.
 *
 * So it is a config field, and it is required IN EFFECT rather than in the schema: absent, the
 * first command that needs it detects it and WRITES IT BACK, and no later command asks git
 * again. The schema keeps it optional on purpose -- a hard requirement would make
 * `config validate` and `doctor` fail on the very config they exist to diagnose, before the
 * autofill could run.
 *
 * Two entry points, because two kinds of caller have incompatible needs:
 *
 * - `requireDefaultBranch({ persist })` is for commands that ACT on the answer. It throws when
 *   nothing can tell it, because checking out or rebasing onto a guessed branch name is the
 *   expensive thing to undo. `persist` is not optional: every call site states whether it may
 *   write, so a dry run or a report command cannot mutate the hangar's config as a side effect
 *   of being asked a question -- `-n` output is this CLI's regression record.
 * - `tryDefaultBranch()` never throws, never writes and never touches the network. It is for
 *   the report paths (`status`) and for `inferTicket`, whose whole contract is that "no answer"
 *   is a normal answer.
 *
 * The persisted value can go stale -- a repo that renames `master` to `main` moves it, and
 * nothing tells the hangar. That is a deliberate trade: one line to edit, against a network
 * round trip per command forever. `hangar doctor` compares the config against each clone's own
 * `origin/HEAD` (no network) and warns when they disagree.
 */

/**
 * One resolution per hangar root per process, keyed by root.
 *
 * A MAP rather than one variable, even though `fleetRoot` is currently the only key there can
 * be: two hangars resolved in one process must stay disjoint, and that is the invariant the
 * whole namespacing exercise exists to satisfy. When clone discovery starts taking a root, so
 * does this. Only successful resolutions are cached -- a failure is worth retrying.
 */
const resolved = new Map<string, string>();

/** `git ls-remote --symref <url> HEAD`, the answer straight from origin with no clone needed. */
const askOrigin = (originUrl: string): string | undefined => {
  const res = run('git', ['ls-remote', '--symref', originUrl, 'HEAD'], {
    // No credential prompt: this runs inside other commands, and a hung git waiting for a
    // password on a tty it may not have is worse than not knowing.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: 20_000,
  });
  if (!res.ok) return undefined;
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(res.stdout)?.[1];
};

type Detection = { readonly branch: string; readonly how: string };

/**
 * Ask git, cheapest question first: a clone's local `origin/HEAD`, then origin itself.
 *
 * The local refs come first because they cost nothing and are right in every hangar whose
 * clones were made by `git clone`. `remote set-head --auto` and `ls-remote` are network calls,
 * and the second needs no clone at all -- which is the case a fresh hangar is in, before
 * `add-clone` has run once.
 *
 * Clones disagreeing is possible (one made before the repo renamed its default branch), so it
 * is reported rather than silently resolved by whichever clone sorts first.
 */
const detect = (originUrl: string): Detection | undefined => {
  const clones = discoverClones();

  const seen = new Map<string, string[]>();
  for (const clone of clones) {
    const branch = defaultBranchFromGit(clone.path);
    if (branch !== undefined) seen.set(branch, [...(seen.get(branch) ?? []), clone.name]);
  }
  const first = [...seen.keys()][0];
  if (first !== undefined) {
    if (seen.size > 1) {
      warn(
        `the clones disagree about the default branch: ${[...seen]
          .map(([branch, names]) => `${branch} (${names.join(', ')})`)
          .join(', ')} — taking ${first}`,
      );
    }
    return { branch: first, how: `origin/HEAD in ${(seen.get(first) ?? []).join(', ')}` };
  }

  const anyClone = clones[0];
  if (anyClone !== undefined) {
    step('origin/HEAD is unset in every clone — asking origin (git remote set-head origin --auto)');
    const asked = setRemoteHeadAuto(anyClone.path);
    if (asked !== undefined)
      return { branch: asked, how: `git remote set-head in ${anyClone.name}` };
  }

  step(`asking origin directly (git ls-remote --symref ${originUrl} HEAD)`);
  const remote = askOrigin(originUrl);
  return remote === undefined ? undefined : { branch: remote, how: 'git ls-remote --symref' };
};

/**
 * Lines `after` has that it did not get from `before`, or `undefined` when `before` is not a
 * prefix-preserving subsequence of it -- i.e. when something was removed, reordered or rewrapped.
 *
 * This is the guard on the write below, and it earns its keep: `hangar.config.yaml` is
 * hand-maintained, four hundred lines of comments in this hangar, and the only record of one
 * machine's ports and paths. An edit to it that also reflowed a block scalar and turned
 * `[DN]` into `[ DN ]` would be an unreviewable diff nobody asked for -- so the new text is
 * PROVED to be the old text plus a known handful of lines, and anything else is refused.
 */
const addedLines = (before: string, after: string): string[] | undefined => {
  const old = before.split('\n');
  const added: string[] = [];
  let i = 0;
  for (const line of after.split('\n')) {
    if (i < old.length && line === old[i]) i += 1;
    else added.push(line);
  }
  return i === old.length ? added : undefined;
};

/**
 * Where to put the new line, and with what indentation, as an offset into the file's text.
 *
 * A TEXT insertion and not `doc.setIn` plus `doc.toString()`, because re-serialising this
 * document rewrites it: with the `yaml` library's own defaults it reflows every block scalar,
 * respaces every flow collection and moves the comments inside a sequence onto the wrong item.
 * `parseDocument` is used only to LOCATE the `forge:` line and read the block's indentation off
 * its first entry -- reliable in a way that a regex over YAML would not be.
 *
 * Immediately after the `forge:` line, not before the first entry: a comment block above an
 * entry documents THAT entry, and splitting the two would be a worse edit than the one being
 * made. Returns `undefined` for anything this cannot do safely -- a flow mapping
 * (`forge: {originUrl: ...}`), a tab-indented block -- and the caller then explains itself
 * instead of writing.
 */
const insertionPoint = (
  text: string,
  doc: Document,
): { readonly offset: number; readonly indent: string } | undefined => {
  const forge = doc.get('forge', true);
  if (!isMap(forge)) return undefined;

  const entry = forge.items[0]?.key;
  if (!isScalar(entry) || entry.range == null) return undefined;
  const entryLineStart = text.lastIndexOf('\n', entry.range[0] - 1) + 1;
  const indent = text.slice(entryLineStart, entry.range[0]);
  if (!/^ +$/.test(indent)) return undefined;

  const key = doc.contents;
  if (!isMap(key)) return undefined;
  const forgeKey = key.items.find((item) => isScalar(item.key) && item.key.value === 'forge')?.key;
  if (!isScalar(forgeKey) || forgeKey.range == null) return undefined;
  const newline = text.indexOf('\n', forgeKey.range[0]);
  if (newline === -1) return undefined;

  return { offset: newline + 1, indent };
};

const NOTE = 'Detected by Hangar and written here so no later command has to ask git again.';
const NOTE2 = 'Edit it if the repo ever moves its default branch; `hangar doctor` checks it.';

/**
 * Write `forge.defaultBranch` into the config, or explain why it did not.
 *
 * Never fatal: the caller already HAS the value, so a failure here costs one re-detection and
 * nothing else. Atomic (temp file plus `rename`), because four clone sessions and their
 * `SessionEnd` hooks share this one file and a half-written config is a hangar that refuses to
 * run. And checked twice before the rename -- the text must differ from the old text by exactly
 * the lines being added, and the result must still parse as a valid config naming this branch.
 */
const persistDefaultBranch = (root: string, branch: string, how: string): void => {
  const configPath = join(root, CONFIG_FILENAME);
  const byHand = (why: string): void => {
    warn(`left ${tildify(configPath)} alone — ${why}`);
    note(`Add \`defaultBranch: ${branch}\` under \`forge:\` yourself to make it permanent.`);
  };

  try {
    const before = readFileSync(configPath, 'utf8');
    const where = insertionPoint(before, parseDocument(before));
    if (where === undefined) {
      byHand('the `forge:` block is not a plain indented mapping, so there is no line to add');
      return;
    }

    const lines = [
      `${where.indent}# ${NOTE}`,
      `${where.indent}# ${NOTE2}`,
      `${where.indent}defaultBranch: ${branch}`,
    ];
    const after = `${before.slice(0, where.offset)}${lines.join('\n')}\n${before.slice(where.offset)}`;

    const added = addedLines(before, after);
    if (added?.join('\n') !== lines.join('\n')) {
      byHand('the edit would have changed more than the one line');
      return;
    }
    const reparsed = hangarConfigSchema.safeParse(parseYaml(after));
    if (!reparsed.success || reparsed.data.forge.defaultBranch !== branch) {
      byHand('the result would not have parsed back as a valid config');
      return;
    }

    const tmp = `${configPath}.hangar-${String(process.pid)}`;
    writeFileSync(tmp, after, { mode: 0o644 });
    renameSync(tmp, configPath);
    note(`forge.defaultBranch: ${branch} — from ${how}, now recorded in ${CONFIG_FILENAME}`);
  } catch (error) {
    warn(
      `could not record the default branch in ${tildify(configPath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

export type RequireOptions = {
  /**
   * May this call write the detected value back to the config?
   *
   * Required, not optional: `false` is the answer for every dry run and every report-only
   * command, and a default would let the next caller written forget which it is.
   */
  readonly persist: boolean;
};

/** The hangar's default branch, detected and recorded if the config does not name it yet. */
export const requireDefaultBranch = (opts: RequireOptions): string => {
  const root = fleetRoot;
  const cached = resolved.get(root);
  if (cached !== undefined) return cached;

  const config = loadConfigFile(join(root, CONFIG_FILENAME));
  const named = config.forge.defaultBranch;
  if (named !== undefined) {
    resolved.set(root, named);
    return named;
  }

  const found = detect(config.forge.originUrl);
  if (found === undefined) {
    throw new CliError(
      'cannot tell which branch this repo treats as its default',
      `No clone has an \`origin/HEAD\`, and origin would not say. Set it in ${CONFIG_FILENAME}:\n` +
        `         forge:\n           defaultBranch: main`,
    );
  }

  if (opts.persist) persistDefaultBranch(root, found.branch, found.how);
  else
    note(
      `default branch: ${found.branch} (from ${found.how}, not recorded — nothing is written on this path)`,
    );

  resolved.set(root, found.branch);
  return found.branch;
};

/**
 * The default branch if it is already known, without asking anything that can fail.
 *
 * Config first, then any clone's local `origin/HEAD`. No network, no write, no throw -- so it
 * is safe on the paths where "I do not know" is a legitimate answer, and it is the only form
 * anything reachable from the fail-open Jira hook may use.
 */
export const tryDefaultBranch = (): string | undefined => {
  const root = fleetRoot;
  const cached = resolved.get(root);
  if (cached !== undefined) return cached;

  try {
    const named = loadConfigFile(join(root, CONFIG_FILENAME)).forge.defaultBranch;
    if (named !== undefined) {
      resolved.set(root, named);
      return named;
    }
  } catch {
    // No config, or an invalid one. Both are somebody else's error to report.
  }

  // Cached like the config hit: `status --all` asks once per clone through
  // `warnOnDuplicateBranches` and `inferTicket`, and re-walking the clones to shell out to
  // `symbolic-ref` each time would quietly undo the "asked once per hangar" property.
  for (const clone of discoverClones()) {
    const branch = defaultBranchFromGit(clone.path);
    if (branch !== undefined) {
      resolved.set(root, branch);
      return branch;
    }
  }
  return undefined;
};
