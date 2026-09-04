import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { configJsonSchemaText } from '../config/json-schema.ts';
import { CONFIG_FILENAME, jsonSchemaFileName, loadHangarConfig } from '../config/load.ts';
import { CliError } from '../exec.ts';
import { fleetRoot } from '../paths.ts';
import { tildify } from '../user-paths.ts';
import { heading, note, ok, warn } from '../ui.ts';

/**
 * Print the config as the CLI actually sees it -- every default applied.
 *
 * A default you cannot see is a default you will be surprised by, so this is the answer to
 * "why is it doing that" rather than reading the file and guessing what was filled in.
 */
export const configShow = (hangarFlag: string | undefined): void => {
  const { configPath, config, source, root } = loadHangarConfig({
    cwd: process.cwd(),
    flag: hangarFlag,
    env: process.env['HANGAR_ROOT'],
  });
  heading(`${config.displayName ?? config.id} — effective configuration`);
  note(`hangar ${tildify(root)} (found by ${source})`);
  note(`from   ${tildify(configPath)}`);
  process.stdout.write(`\n${stringifyYaml(config, { lineWidth: 100 })}`);
};

/** Validate without doing anything else. Exits non-zero with every problem listed. */
export const configValidate = (hangarFlag: string | undefined): void => {
  const { configPath, config } = loadHangarConfig({
    cwd: process.cwd(),
    flag: hangarFlag,
    env: process.env['HANGAR_ROOT'],
  });
  ok(`${tildify(configPath)} is valid`);
  const roles = config.ports.roles;
  note(
    roles.length === 0
      ? 'this hangar assigns no ports'
      : `${String(roles.length)} port role(s): ${roles.map((r) => r.id).join(', ')}`,
  );
  note(
    `profile ${config.profile}, forge ${config.forge.kind ?? 'inferred'}, tracker ${config.tracker.kind}`,
  );
};

export type SchemaOptions = {
  readonly check?: boolean | undefined;
  readonly out?: string | undefined;
};

/**
 * Write (or verify) the JSON Schema the YAML file points at with `# yaml-language-server`.
 *
 * `--check` is what a pre-commit or CI step runs: the committed schema must match a fresh
 * render of the zod schema, or the editor is validating against yesterday's rules.
 */
export const configSchema = (opts: SchemaOptions): void => {
  const target = opts.out ?? join(fleetRoot, jsonSchemaFileName);
  const rendered = configJsonSchemaText();

  if (opts.check === true) {
    if (!existsSync(target)) {
      throw new CliError(
        `${tildify(target)} does not exist`,
        'Run `hangar config schema` to write it.',
      );
    }
    if (readFileSync(target, 'utf8') === rendered) {
      ok(`${tildify(target)} matches the zod schema`);
      return;
    }
    throw new CliError(
      `${tildify(target)} is out of date`,
      'The zod schema in src/config/schema.ts has changed. Run `hangar config schema` to regenerate.',
    );
  }

  const existed = existsSync(target);
  if (existed && readFileSync(target, 'utf8') === rendered) {
    note(`unchanged  ${tildify(target)}`);
    return;
  }
  writeFileSync(target, rendered);
  ok(`${existed ? 'updated' : 'written'}    ${tildify(target)}`);
  if (!existsSync(join(fleetRoot, CONFIG_FILENAME))) {
    warn(`no ${CONFIG_FILENAME} beside it yet — run \`hangar setup\``);
  }
};
