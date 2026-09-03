import { z } from 'zod';

import { hangarConfigSchema } from './schema.ts';

/**
 * The JSON Schema editors validate `hangar.config.yaml` against.
 *
 * A PURE builder, so the generated file can be diffed against a fresh render -- which is how
 * `hangar config schema --check` proves the committed copy is not stale. It is generated
 * from the zod schema rather than maintained beside it: two hand-written definitions of one
 * shape drift, and the one that drifts is always the one nothing executes.
 *
 * `io: 'input'` matters. It describes what a human may WRITE (defaults optional, so a nearly
 * empty file validates) rather than what the loader hands back (every default filled in, so
 * almost everything required). Getting this backwards makes the editor demand every field.
 *
 * Cross-field rules -- duplicate role ids, bases congruent mod step, the tracker's
 * conditional baseUrl -- cannot be expressed here and are NOT lost: the loader still enforces
 * them. The schema is a typing aid; the loader is the authority.
 */
export const configJsonSchema = (): Record<string, unknown> => {
  const generated = z.toJSONSchema(hangarConfigSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    /*
     * Deliberately NO `$id`. An `$id` sets the base URI for resolving `$ref`s, and this
     * schema is fully self-contained -- no `$ref`, no `$defs` -- so it has no such job. A
     * remote `$id` would only invite a resolver to fetch a URL that need not exist: the
     * schema is consumed as a LOCAL FILE beside the config it validates, in every hangar,
     * with no network and no published repo required.
     */
    title: 'Hangar configuration',
    description:
      'Configuration for one hangar: a directory holding a fleet of clones of one repo. ' +
      'Generated from the zod schema in src/config/schema.ts -- do not hand-edit. ' +
      'Cross-field rules (duplicate port roles, bases congruent mod step, tracker.baseUrl ' +
      'when tracker.kind is set) are enforced by the loader, not expressible here.',
    ...generated,
  };
};

/** Serialised exactly as it is written to disk, so a diff is a real diff. */
export const configJsonSchemaText = (): string =>
  `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
