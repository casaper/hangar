import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { colourAssignmentsFile, tildify } from './paths.ts';

/**
 * Explicit clone -> colour assignments: the one exception to "everything per-clone is a pure
 * function of the index".
 *
 * `hangar colours change 4 red` has to persist SOMETHING, because the index formula in
 * `palette.ts` is otherwise the only answer and it cannot be argued with. This is deliberately
 * a sparse override rather than a full roster: a clone that was never re-coloured is not in
 * the file at all, so `add-clone` and `remove-clone` still need no bookkeeping and the fleet
 * still has no registry.
 *
 * Keyed by INDEX as a string, because the index is what everything per-clone derives from and
 * it is what survives a rename. The file is JSON so it can be hand-edited; a key that is not a
 * clone index, or a value that is not a palette name, is IGNORED here (the formula wins) and
 * reported by `hangar doctor` -- silently reverting to the formula while looking edited is
 * exactly the failure this fleet keeps running into.
 */
const DOC_KEY = '_';

const DOC =
  'Written by `hangar colours change <clone> <colour>`. Keys are clone indices; values are ' +
  'palette names from app/src/palette.ts. A clone that is not listed takes PALETTE[(N-1) % length].';

type Assignments = Map<number, string>;

let cache: Assignments | undefined;

const parse = (text: string): Assignments => {
  const map: Assignments = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return map;
  }
  if (typeof raw !== 'object' || raw === null) return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === DOC_KEY || typeof value !== 'string') continue;
    const index = Number.parseInt(key, 10);
    if (!Number.isInteger(index) || index < 1 || String(index) !== key.replace(/^0+(?=\d)/, ''))
      continue;
    map.set(index, value);
  }
  return map;
};

/** Every assignment on disk. Cached: `discoverClones()` is called many times per command. */
export const colourAssignments = (): Assignments => {
  if (cache === undefined) {
    let text: string;
    try {
      text = readFileSync(colourAssignmentsFile, 'utf8');
    } catch {
      text = '';
    }
    cache = parse(text);
  }
  return cache;
};

export const colourAssignmentFor = (index: number): string | undefined =>
  colourAssignments().get(index);

const write = (assignments: Assignments): void => {
  cache = assignments;
  if (assignments.size === 0) {
    // No assignments left: remove the file rather than leave an empty object behind, so the
    // fleet root goes back to holding no colour bookkeeping at all.
    try {
      unlinkSync(colourAssignmentsFile);
    } catch {
      /* already gone */
    }
    return;
  }
  const body: Record<string, string> = { [DOC_KEY]: DOC };
  for (const index of [...assignments.keys()].sort((a, b) => a - b)) {
    const name = assignments.get(index);
    if (name !== undefined) body[String(index)] = name;
  }
  writeFileSync(colourAssignmentsFile, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
};

export const setColourAssignment = (index: number, name: string): void => {
  const next = new Map(colourAssignments());
  next.set(index, name);
  write(next);
};

/**
 * Forget an index's assignment -- it goes back to the formula.
 *
 * Called by `colours change` when the chosen hue IS the formula's, and by `remove-clone` and
 * `add-clone`: `nextFreeIndex()` reuses the gap a removal leaves, so an assignment left behind
 * would hand a brand-new clone the colour of the one that used to live at that index.
 */
export const clearColourAssignment = (index: number): boolean => {
  const next = new Map(colourAssignments());
  if (!next.delete(index)) return false;
  write(next);
  return true;
};

export const colourAssignmentsLabel = (): string => tildify(colourAssignmentsFile);
