import type { HangarConfig } from './schema.ts';

/**
 * `hangar.config.example.yaml` against the live `hangar.config.yaml`.
 *
 * The example is the ONLY committed record of how a hangar is configured -- the live file is
 * gitignored, because it names one machine's paths and token variables -- so the pair is held
 * together by an invariant that `hangar-internals/reference/config.md` has stated all along:
 * **`hangar config show` on each must differ only in the free-text `_` note.** A drifting
 * example is a lost config.
 *
 * Stated, and until now never run. The two had drifted by exactly one line --
 * `forge.defaultBranch`, `master` live and `main` in the example -- which is the worst possible
 * line for it to be: a colleague adopting this fleet by copying the example (the fastest and
 * most correct way to join a hangar for a repo somebody has already configured) got a config
 * naming a branch the repo does not have, and `checkout-default`, `open`'s fast-forward and
 * `sync`'s no-forge fallback all aimed at it.
 *
 * Compared as PARSED configs rather than as file text, which is what makes it a real check
 * rather than a formatting one: both sides have every default applied, so a key written out
 * explicitly on one side and left to its default on the other is correctly reported as
 * agreement. That is the whole point of the invariant being phrased in terms of `config show`.
 */

/** The free-text note. Excluded by the invariant itself -- it is prose, and differs on purpose. */
const NOTE_KEY = '_';

export type ConfigDrift = {
  /** Dotted path, e.g. `forge.defaultBranch` or `ports.roles[1].base`. */
  readonly path: string;
  readonly live: string;
  readonly example: string;
};

const render = (v: unknown): string =>
  v === undefined ? '(absent)' : typeof v === 'string' ? v : JSON.stringify(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every leaf that differs, deepest-path-first within each branch.
 *
 * Arrays are compared whole rather than element-wise past a length mismatch: two `ports.roles`
 * lists of different lengths have no meaningful per-index correspondence, and reporting
 * `roles[2] absent` three times says less than reporting the list.
 */
const diffValue = (path: string, live: unknown, example: unknown): ConfigDrift[] => {
  if (isRecord(live) && isRecord(example)) {
    const keys = [...new Set([...Object.keys(live), ...Object.keys(example)])].sort();
    return keys.flatMap((k) => diffValue(path === '' ? k : `${path}.${k}`, live[k], example[k]));
  }
  if (Array.isArray(live) && Array.isArray(example) && live.length === example.length) {
    return live.flatMap((item, i) => diffValue(`${path}[${String(i)}]`, item, example[i]));
  }
  return render(live) === render(example)
    ? []
    : [{ path, live: render(live), example: render(example) }];
};

export const configDrift = (live: HangarConfig, example: HangarConfig): readonly ConfigDrift[] => {
  const strip = (c: HangarConfig): Record<string, unknown> => {
    const { [NOTE_KEY]: _note, ...rest } = c as unknown as Record<string, unknown>;
    return rest;
  };
  return diffValue('', strip(live), strip(example));
};

/**
 * Whether the example is this hangar's own record, or just the shipped template.
 *
 * The gate, and without it this check would be red in every hangar but the one it was written
 * in -- which is the failure mode `hangar-internals` names three times over: a check that is red
 * in normal operation is a check nobody reads. A peer who copies the example inherits its `id`
 * and so keeps the check live through exactly the window where it is useful; the moment they
 * run `hangar setup` and name their own hangar, the example becomes a template again and the
 * check goes quiet on its own, with no flag to remember.
 */
export const exampleIsOwnRecord = (live: HangarConfig, example: HangarConfig): boolean =>
  live.id === example.id;
