import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Hangar } from './hangar.ts';
import { tildify } from './user-paths.ts';

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

/**
 * Parsed assignments per hangar ROOT, not one per process.
 *
 * `discoverClones` reads every clone's colour and is called many times per command, so the
 * cache earns its place -- but it is keyed on the root now, because one process can render two
 * hangars and a single slot would hand the second one the first hangar's overrides.
 */
const cache = new Map<string, Assignments>();

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

const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Which file actually holds this hangar's assignments: the current one, or the legacy root path.
 *
 * Exported so `doctor` can report and migrate the legacy case without a second search. The
 * fallback is PERMANENT rather than a migration window: `colour-assignments.json` was tracked
 * at the hangar root, so a `git pull` into a checkout from before the move puts it back, and a
 * reader that had stopped looking there would silently revert four clones to the index formula
 * -- which is the failure this file's own header warns about.
 */
export const colourAssignmentsSource = (
  hangar: Hangar,
): { readonly path: string; readonly legacy: boolean; readonly text: string } | undefined => {
  const current = readIfPresent(hangar.paths.colourAssignmentsFile);
  if (current !== undefined) {
    return { path: hangar.paths.colourAssignmentsFile, legacy: false, text: current };
  }
  const legacy = readIfPresent(hangar.paths.legacyColourAssignmentsFile);
  if (legacy !== undefined) {
    return { path: hangar.paths.legacyColourAssignmentsFile, legacy: true, text: legacy };
  }
  return undefined;
};

/** Every assignment on disk. Cached: `discoverClones()` is called many times per command. */
export const colourAssignments = (hangar: Hangar): Assignments => {
  const hit = cache.get(hangar.root);
  if (hit !== undefined) return hit;
  const parsed = parse(colourAssignmentsSource(hangar)?.text ?? '');
  cache.set(hangar.root, parsed);
  return parsed;
};

export const colourAssignmentFor = (hangar: Hangar, index: number): string | undefined =>
  colourAssignments(hangar).get(index);

const write = (hangar: Hangar, assignments: Assignments): void => {
  cache.set(hangar.root, assignments);
  if (assignments.size === 0) {
    // No assignments left: remove the file rather than leave an empty object behind, so the
    // fleet root goes back to holding no colour bookkeeping at all.
    try {
      unlinkSync(hangar.paths.colourAssignmentsFile);
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
  // Always the CURRENT path, never the legacy one -- a write is what completes the move, and
  // writing back to a tracked root-level file is the merge conflict this is escaping.
  mkdirSync(dirname(hangar.paths.colourAssignmentsFile), { recursive: true });
  writeFileSync(hangar.paths.colourAssignmentsFile, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
};

/**
 * Move a legacy root-level file to its current path, keeping the content byte for byte.
 *
 * Copy-then-delete rather than a rename of the parsed content: this file is hand-editable and
 * may carry comments in its `_` key or an assignment this version does not understand, and a
 * migration that reserialised it would quietly drop either. Returns the two paths so the caller
 * can say what moved.
 */
export const migrateColourAssignments = (
  hangar: Hangar,
): { readonly from: string; readonly to: string } | undefined => {
  const source = colourAssignmentsSource(hangar);
  if (source?.legacy !== true) return undefined;
  mkdirSync(dirname(hangar.paths.colourAssignmentsFile), { recursive: true });
  writeFileSync(hangar.paths.colourAssignmentsFile, source.text, 'utf8');
  try {
    unlinkSync(hangar.paths.legacyColourAssignmentsFile);
  } catch {
    /* left behind: still tracked, or read-only. The current file wins either way. */
  }
  cache.delete(hangar.root);
  return { from: source.path, to: hangar.paths.colourAssignmentsFile };
};

export const setColourAssignment = (hangar: Hangar, index: number, name: string): void => {
  const next = new Map(colourAssignments(hangar));
  next.set(index, name);
  write(hangar, next);
};

/**
 * Forget an index's assignment -- it goes back to the formula.
 *
 * Called by `colours change` when the chosen hue IS the formula's, and by `remove-clone` and
 * `add-clone`: `nextFreeIndex()` reuses the gap a removal leaves, so an assignment left behind
 * would hand a brand-new clone the colour of the one that used to live at that index.
 */
export const clearColourAssignment = (hangar: Hangar, index: number): boolean => {
  const next = new Map(colourAssignments(hangar));
  if (!next.delete(index)) return false;
  write(hangar, next);
  return true;
};

/**
 * The file to NAME in a message, which is the one actually being read.
 *
 * `doctor` says "<label> assigns X to index 4, which is not a palette colour"; pointing that at
 * the canonical path while reading the legacy one would send someone to edit a file that is not
 * the one taking effect.
 */
export const colourAssignmentsLabel = (hangar: Hangar): string =>
  tildify(colourAssignmentsSource(hangar)?.path ?? hangar.paths.colourAssignmentsFile);
