import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CliError } from './exec.ts';
import type { Hangar } from './hangar.ts';
import { tildify } from './user-paths.ts';

/**
 * Clones held on the ports they already have, while the port layout moves under the fleet.
 *
 * A layout change in `ports` would otherwise move EVERY clone at once -- and a clone's port is
 * where its running dev server is, what its live session was told at startup and what its
 * health-check allow rule names. So a layout change is rolled out one clone at a time: pin them
 * all first (`hangar ports pin --all`), change the config, then release each clone with
 * `hangar ports unpin N` and `hangar doctor N --fix` when it is idle.
 *
 * A pin is a literal SNAPSHOT keyed by env var, never "the old formula": the arithmetic it
 * outlives is exactly what is being changed, so a pin that recomputed from it would move with
 * it. A role missing from a pin takes the current formula, which is what a role added after the
 * snapshot wants.
 *
 * Unlike the colour file, a file that will not parse is an ERROR and never "no pins": the
 * fallback here is the new layout, so a silent one would move every pinned clone's derived
 * ports -- and `servers kill` would aim at ports nothing of that clone is listening on.
 */
const DOC_KEY = '_';

const DOC =
  'Written by `hangar ports pin` and `hangar ports unpin`. Keys are clone indices; values map ' +
  'each port env var to the port that clone keeps. A clone that is not listed takes the formula.';

/** envKey -> port, for one clone. */
export type PortPin = ReadonlyMap<string, number>;

type Pins = ReadonlyMap<number, PortPin>;

/** Parsed pins per hangar ROOT -- one process can render two hangars. */
const cache = new Map<string, Pins>();

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;

const parse = (path: string, text: string): Pins => {
  const bad = (why: string): CliError =>
    new CliError(`${tildify(path)}: ${why} — fix or remove it; it pins clones to their ports`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw bad('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('not an object');
  const pins = new Map<number, PortPin>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === DOC_KEY) continue;
    const index = Number.parseInt(key, 10);
    if (!Number.isInteger(index) || index < 1 || String(index) !== key)
      throw bad(`"${key}" is not a clone index`);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw bad(`clone ${key} is not an object of env var -> port`);
    const pin = new Map<string, number>();
    for (const [envKey, port] of Object.entries(value as Record<string, unknown>)) {
      if (!isPort(port)) throw bad(`clone ${key} ${envKey} is not a port`);
      pin.set(envKey, port);
    }
    pins.set(index, pin);
  }
  return pins;
};

/** Every pin on disk. Cached: `discoverClones()` is called many times per command. */
export const portPins = (hangar: Hangar): Pins => {
  const hit = cache.get(hangar.root);
  if (hit !== undefined) return hit;
  const path = hangar.paths.portPinsFile;
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CliError(`${tildify(path)}: cannot be read (${String(error)})`);
    }
  }
  const parsed = text === undefined ? new Map<number, PortPin>() : parse(path, text);
  cache.set(hangar.root, parsed);
  return parsed;
};

export const portPinFor = (hangar: Hangar, index: number): PortPin | undefined =>
  portPins(hangar).get(index);

const write = (hangar: Hangar, pins: Pins): void => {
  cache.set(hangar.root, pins);
  const path = hangar.paths.portPinsFile;
  if (pins.size === 0) {
    // Nothing pinned: no file, so a hangar that finished its rollout holds no bookkeeping.
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
    return;
  }
  const body: Record<string, unknown> = { [DOC_KEY]: DOC };
  for (const index of [...pins.keys()].sort((a, b) => a - b)) {
    const pin = pins.get(index);
    if (pin !== undefined) body[String(index)] = Object.fromEntries(pin);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
};

export const setPortPin = (hangar: Hangar, index: number, pin: PortPin): void => {
  const next = new Map(portPins(hangar));
  next.set(index, pin);
  write(hangar, next);
};

/**
 * Release an index to the formula. Also called by `remove-clone` and `add-clone`: a gap an
 * index leaves is reused by `nextFreeIndex()`, and a pin left behind would hand a brand-new
 * clone the ports of the one that used to live there.
 */
export const clearPortPin = (hangar: Hangar, index: number): boolean => {
  const current = portPins(hangar);
  if (!current.has(index)) return false;
  const next = new Map(current);
  next.delete(index);
  write(hangar, next);
  return true;
};
