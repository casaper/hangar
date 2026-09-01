import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { colourFor, type CloneColour } from './palette.ts';
import { fleetRoot } from './paths.ts';
import { portsFor, type ClonePorts } from './ports.ts';

/**
 * Clone discovery.
 *
 * There is no registry file, and deliberately so. The clone list is whatever `clone_NN`
 * directories exist; the index is parsed out of the name; the colour and the three ports
 * are pure functions of that index. Nothing is positional, so removing clone_02 leaves a
 * gap that costs nothing and never renumbers anyone.
 *
 * Two or more digits, so the fleet does not break at clone_10 the way the old
 * `clone_0[0-9]` globs did.
 */
export const CLONE_DIR_RE = /^clone_(\d{2,})$/;

export type Clone = {
  readonly name: string;
  readonly index: number;
  readonly path: string;
  readonly colour: CloneColour;
  readonly ports: ClonePorts;
};

export const cloneNameFor = (index: number): string => `clone_${String(index).padStart(2, '0')}`;

const makeClone = (index: number): Clone => ({
  name: cloneNameFor(index),
  index,
  path: join(fleetRoot, cloneNameFor(index)),
  colour: colourFor(index),
  ports: portsFor(index),
});

/** Every clone directory present in the fleet root, ordered by index. */
export const discoverClones = (): Clone[] => {
  const indices: number[] = [];
  for (const entry of readdirSync(fleetRoot, { withFileTypes: true })) {
    // A clone may legitimately be a symlink to a directory, so stat rather than isDirectory().
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const match = CLONE_DIR_RE.exec(entry.name);
    if (!match?.[1]) continue;
    try {
      if (!statSync(join(fleetRoot, entry.name)).isDirectory()) continue;
    } catch {
      continue;
    }
    indices.push(Number.parseInt(match[1], 10));
  }
  return indices.sort((a, b) => a - b).map(makeClone);
};

/**
 * Resolve a user-typed clone reference: `clone_02`, `02`, or `2` all mean the same clone.
 * Returns undefined when no such directory exists -- callers turn that into a CliError
 * listing what the fleet actually has.
 */
export const findClone = (ref: string): Clone | undefined => {
  const clones = discoverClones();
  const direct = clones.find((c) => c.name === ref);
  if (direct) return direct;
  const asNumber = Number.parseInt(ref.replace(/^clone_?/, ''), 10);
  if (Number.isNaN(asNumber)) return undefined;
  return clones.find((c) => c.index === asNumber);
};

/** Lowest index not currently taken -- reuses a gap left by `remove-clone`. */
export const nextFreeIndex = (): number => {
  const taken = new Set(discoverClones().map((c) => c.index));
  let index = 1;
  while (taken.has(index)) index += 1;
  return index;
};

/** A clone the CLI created but has not yet finished wiring up still needs a Clone shape. */
export const cloneAt = (index: number): Clone => makeClone(index);
