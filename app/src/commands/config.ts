import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { configJsonSchemaText } from '../config/json-schema.ts';
import {
  CONFIG_FILENAME,
  EXAMPLE_CONFIG_FILENAME,
  jsonSchemaFileName,
  loadConfigFile,
  loadHangarConfig,
} from '../config/load.ts';
import { configDrift, exampleIsOwnRecord } from '../config/drift.ts';
import type { HangarConfig } from '../config/schema.ts';
import { CliError } from '../exec.ts';

import { tildify } from '../user-paths.ts';
import { heading, note, ok, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

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
  const { configPath, config, root } = loadHangarConfig({
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
  reportExampleDrift(root, config);
};

/**
 * The committed example against the live file, when the example is this hangar's own record.
 *
 * Lives in `config validate` rather than in `doctor` for one reason: `doctor` is the net for
 * things that live outside git, and this is the opposite -- a file that IS in git having
 * drifted from the one that is not. It is also the command whose whole contract is "every
 * problem at once", and a lost config is a problem.
 *
 * Never fatal, and deliberately: the example being stale does not stop anything working today.
 * It is what stops the config being recoverable tomorrow.
 */
const reportExampleDrift = (root: string, live: HangarConfig): void => {
  const examplePath = join(root, EXAMPLE_CONFIG_FILENAME);
  if (!existsSync(examplePath)) return;

  let example: HangarConfig;
  try {
    example = loadConfigFile(examplePath);
  } catch {
    // A committed example that will not parse is worth saying, but it is not this check's
    // finding -- `config validate --hangar <copy>` is how you diagnose that one.
    warn(`${tildify(examplePath)} does not parse — it cannot be a record of anything`);
    return;
  }

  if (!exampleIsOwnRecord(live, example)) {
    note(
      `${EXAMPLE_CONFIG_FILENAME} declares id "${example.id}", not "${live.id}" — treated as the ` +
        'shipped template, so it is not compared.',
    );
    return;
  }

  const drift = configDrift(live, example);
  if (drift.length === 0) {
    ok(`${EXAMPLE_CONFIG_FILENAME} matches this config`);
    return;
  }
  warn(
    `${EXAMPLE_CONFIG_FILENAME} has drifted from this config in ${String(drift.length)} place(s)`,
  );
  for (const d of drift) note(`  ${d.path}: live ${d.live} — example ${d.example}`);
  note(
    'The example is the only COMMITTED record of this hangar, and the file a colleague copies ' +
      'to join the fleet. Bring it back in step.',
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
export const configSchema = (hangar: Hangar, opts: SchemaOptions): void => {
  const target = opts.out ?? join(hangar.root, jsonSchemaFileName);
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
  if (!existsSync(join(hangar.root, CONFIG_FILENAME))) {
    warn(`no ${CONFIG_FILENAME} beside it yet — run \`hangar setup\``);
  }
};
