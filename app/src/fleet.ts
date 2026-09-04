import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { colourAssignmentFor } from './colour-assignments.ts';
import { CliError } from './exec.ts';
import type { Hangar } from './hangar.ts';
import { colourFor, type CloneColour } from './palette.ts';
import { portsFor, type ClonePorts } from './ports.ts';

/**
 * Clone discovery.
 *
 * There is no registry file, and deliberately so. The clone list is whatever `clone_NN`
 * directories exist; the index is parsed out of the name; the colour and the three ports
 * are pure functions of that index. Nothing is positional, so removing clone_02 leaves a
 * gap that costs nothing and never renumbers anyone.
 *
 * The single exception is a colour a human chose with `hangar colours change`, which is a
 * SPARSE override in `colour-assignments.json` -- a clone that was never re-coloured is not in
 * that file, so none of the above changes.
 *
 * Two or more digits, so the fleet does not break at clone_10 the way the old
 * `clone_0[0-9]` globs did.
 */
export const CLONE_PREFIX = 'clone_';
export const CLONE_PAD = 2;

/**
 * ONE derivation, and everything that spells a clone directory goes through it: this regexp,
 * `cloneNameFor`, the sibling remote names, `status`'s `dir` row and the generated statusline's
 * own pattern. A second regexp written by hand somewhere else is how a hangar ends up with two
 * ideas of what its clones are called, and only one of them being configurable.
 *
 * `clones.prefix` and `clones.pad` are already declared in the schema and are not read yet;
 * F5 replaces these two constants with those, and there is exactly one place to do it.
 */
export const CLONE_DIR_RE = new RegExp(`^${CLONE_PREFIX}(\\d{${String(CLONE_PAD)},})$`);

/** The shell-glob equivalent, for the generated artifacts that match on a name rather than parse it. */
export const cloneGlobPattern = (): string => `${CLONE_PREFIX}[0-9][0-9]*`;

export type Clone = {
  readonly name: string;
  readonly index: number;
  readonly path: string;
  readonly colour: CloneColour;
  readonly ports: ClonePorts;
  /**
   * The hangar this clone belongs to.
   *
   * A back-reference rather than a parameter on every builder, and that is the whole reason the
   * seven byte-compared per-clone artifacts kept their signatures when the hangar stopped being
   * a module constant. `doctor` compares each file against the same builder `add-clone` and
   * `--fix` write; had those signatures moved, the highest-consequence code in this CLI would
   * have moved with them.
   */
  readonly hangar: Hangar;
};

export const cloneNameFor = (index: number): string =>
  `${CLONE_PREFIX}${String(index).padStart(CLONE_PAD, '0')}`;

const makeClone = (hangar: Hangar, index: number): Clone => ({
  name: cloneNameFor(index),
  index,
  path: join(hangar.root, cloneNameFor(index)),
  colour: colourFor(index, colourAssignmentFor(hangar, index)),
  ports: portsFor(hangar, index),
  hangar,
});

/** Every clone directory present in the fleet root, ordered by index. */
export const discoverClones = (hangar: Hangar): Clone[] => {
  const indices: number[] = [];
  for (const entry of readdirSync(hangar.root, { withFileTypes: true })) {
    // A clone may legitimately be a symlink to a directory, so stat rather than isDirectory().
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const match = CLONE_DIR_RE.exec(entry.name);
    if (!match?.[1]) continue;
    try {
      if (!statSync(join(hangar.root, entry.name)).isDirectory()) continue;
    } catch {
      continue;
    }
    indices.push(Number.parseInt(match[1], 10));
  }
  return indices.sort((a, b) => a - b).map((index) => makeClone(hangar, index));
};

/**
 * Resolve a user-typed clone reference: `clone_02`, `02`, or `2` all mean the same clone.
 * Returns undefined when no such directory exists -- callers turn that into a CliError
 * listing what the fleet actually has.
 */
export const findClone = (hangar: Hangar, ref: string): Clone | undefined => {
  const clones = discoverClones(hangar);
  const direct = clones.find((c) => c.name === ref);
  if (direct) return direct;
  const asNumber = Number.parseInt(ref.replace(/^clone_?/, ''), 10);
  if (Number.isNaN(asNumber)) return undefined;
  return clones.find((c) => c.index === asNumber);
};

/**
 * The clone the current working directory is inside, if any.
 *
 * Only for commands that need to know WHICH LIST to show, never for one that acts on a clone:
 * every mutating command takes the clone as an argument, because "wrong clone" is the failure
 * this fleet is most prone to and a cwd is exactly the signal that moves without being noticed.
 */
export const cloneForCwd = (hangar: Hangar, cwd: string = process.cwd()): Clone | undefined => {
  const here = resolve(cwd);
  if (here !== hangar.root && !here.startsWith(`${hangar.root}/`)) return undefined;
  const segment = here.slice(hangar.root.length + 1).split('/')[0];
  if (segment === undefined || !CLONE_DIR_RE.test(segment)) return undefined;
  return findClone(hangar, segment);
};

/** Lowest index not currently taken -- reuses a gap left by `remove-clone`. */
export const nextFreeIndex = (hangar: Hangar): number => {
  const taken = new Set(discoverClones(hangar).map((c) => c.index));
  let index = 1;
  while (taken.has(index)) index += 1;
  return index;
};

/** A clone the CLI created but has not yet finished wiring up still needs a Clone shape. */
export const cloneAt = (hangar: Hangar, index: number): Clone => makeClone(hangar, index);

/**
 * The hint every "which clone?" error carries. Indices, not directory names: the index is what
 * you type, and `findClone` accepts nothing the index does not cover.
 */
export const knownClonesHint = (hangar: Hangar): string =>
  `Known clones: ${
    discoverClones(hangar)
      .map((c) => String(c.index))
      .join(', ') || '(none)'
  }`;

/** `findClone`, but a missing clone is a CliError rather than `undefined`. */
export const requireClone = (hangar: Hangar, ref: string): Clone => {
  const clone = findClone(hangar, ref);
  if (!clone) throw new CliError(`no such clone: ${ref}`, knownClonesHint(hangar));
  return clone;
};
