import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Argument, Command, Option, type CommandUnknownOpts } from '@commander-js/extra-typings';

import {
  argvFor,
  descriptionFor,
  EXPOSURES,
  findCommand,
  inputSchemaFor,
  NOT_EXPOSED,
  permissionRule,
  unexposedCommands,
  type Exposure,
} from '../src/mcp/tools.ts';

/**
 * The MCP tool surface, and the rule that every tool must have a permission rule of its own.
 *
 * **This is the half a golden capture cannot reach and the half with a security consequence.**
 * Claude Code sessions here start in `auto`, where an MCP tool matching NO rule is not prompted
 * for -- a classifier decides. So a tool added to the table and forgotten in
 * `ops.settings.json` is not a tool that fails safe; it is one that runs. The enumeration is
 * therefore a test rather than a convention.
 *
 * The other direction -- a COMMAND with no tool -- fails differently and is left to a line on
 * stderr when the server starts: a missing tool is visible the moment somebody looks for it,
 * and refusing to serve would take operator mode's whole surface away over an omission made in
 * the other tab.
 *
 * `ops.settings.json` is tracked and byte-identical on every machine, which is what makes
 * reading it here portable. It is reached relative to this file, never to a home directory.
 */

const opsSettings = JSON.parse(
  readFileSync(new URL('../../.claude/modes/ops.settings.json', import.meta.url), 'utf8'),
) as { permissions: { allow?: string[]; ask?: string[]; deny?: string[] } };

const lists = {
  allow: opsSettings.permissions.allow ?? [],
  ask: opsSettings.permissions.ask ?? [],
  deny: opsSettings.permissions.deny ?? [],
};

test('every tool is named by exactly one of operator mode’s three lists', () => {
  for (const exposure of EXPOSURES) {
    const rule = permissionRule(exposure.name);
    const holding = (['allow', 'ask', 'deny'] as const).filter((key) => lists[key].includes(rule));
    assert.deepEqual(
      holding,
      [exposure.acts ? 'ask' : 'allow'],
      // In `auto` a tool with no rule is classifier-approved, so an omission here is a mutating
      // command that runs unasked -- and it looks exactly like a tool that works.
      `${rule} should be in exactly ${exposure.acts ? 'ask' : 'allow'}, and is in [${holding.join(', ')}]`,
    );
  }
});

test('operator mode names no tool that does not exist', () => {
  const known = new Set(EXPOSURES.map((e) => permissionRule(e.name)));
  for (const [key, rules] of Object.entries(lists)) {
    for (const rule of rules) {
      if (!rule.startsWith('mcp__')) continue;
      assert.ok(known.has(rule), `${key} names ${rule}, which is not a tool`);
    }
  }
});

test('no rule tries to match an argument, because those are silently skipped', () => {
  /*
   * Claude Code drops any `mcp__` rule containing parentheses when the settings file loads --
   * with no error at the point of use. A rule written that way would look like a restriction
   * and be none, which is why the separation is expressed as two tools instead.
   */
  for (const rules of Object.values(lists)) {
    for (const rule of rules) {
      if (!rule.startsWith('mcp__')) continue;
      assert.ok(!rule.includes('('), `${rule} would be skipped, not enforced`);
    }
  }
});

test('the table is internally consistent', () => {
  const names = EXPOSURES.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, 'two exposures share a name');
  for (const exposure of EXPOSURES) {
    // A tool name reaches the permission layer as `mcp__hangar__<name>`; anything but word
    // characters there is a rule that matches nothing.
    assert.match(exposure.name, /^[a-z][a-z0-9_]*$/, `${exposure.name} is not a usable tool name`);
    for (const flag of exposure.fixed ?? []) {
      assert.ok(
        exposure.hides?.includes(flag) !== true,
        `${exposure.name} both fixes and hides ${flag}`,
      );
    }
  }
  for (const spelled of NOT_EXPOSED) {
    assert.ok(
      !EXPOSURES.some((e) => e.path.join(' ') === spelled),
      `${spelled} is both exposed and listed as deliberately absent`,
    );
  }
});

test('a preview and the command it previews are two tools, never one flag', () => {
  /*
   * The property the whole design rests on. MCP cannot match on arguments, so `dry-run` as a
   * boolean would put the preview and the real run under ONE permission -- and pre-approving
   * the safe one would pre-approve the other.
   *
   * The live registry is checked by `serveMcp` when the server starts, because reaching it here
   * would mean importing `cli.ts`, which runs. What is checkable from the table alone is the
   * pairing, and that is where the mistake actually gets made: an acting tool added beside a
   * preview and left offering the flag its twin fixes.
   */
  const previews = EXPOSURES.filter((e) => e.fixed?.includes('--dry-run') === true);
  assert.ok(previews.length > 0);
  for (const preview of previews) {
    assert.equal(preview.acts, false, `${preview.name} is a dry run and should not be an act`);
    const twins = EXPOSURES.filter((e) => e.acts && e.path.join(' ') === preview.path.join(' '));
    for (const twin of twins) {
      assert.ok(
        twin.hides?.includes('--dry-run') === true,
        `${twin.name} must hide --dry-run, or it and ${preview.name} are one permission`,
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The generator, against a registry of its own -- `cli.ts` cannot be imported, because its last
// statement is `program.parseAsync()`.
// ---------------------------------------------------------------------------------------------

const command = (): CommandUnknownOpts => {
  const leaf = new Command('sync')
    .description('Bring a clone up to date')
    .addArgument(new Argument('[clone]', 'clone name'))
    .addArgument(new Argument('[extras...]', 'more clones'))
    .option('-a, --all', 'every clone')
    .option('-n, --dry-run', 'change nothing')
    .addOption(new Option('--strategy <how>', 'how').choices(['rebase', 'merge']))
    .option('-q, --quiet', 'say nothing')
    .addOption(new Option('--remote <url>', 'secret').hideHelp());
  return leaf;
};

const plain: Exposure = { name: 'sync', path: ['sync'], hides: ['--dry-run'], acts: true };
const preview: Exposure = {
  name: 'sync_preview',
  path: ['sync'],
  fixed: ['--dry-run'],
  acts: false,
  lede: 'Dry run.',
};

test('the schema is read off the registry, so a flag is declared in one place', () => {
  const schema = inputSchemaFor(command(), plain);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['all', 'clone', 'extras', 'strategy']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required, undefined, 'an optional argument must not be required');
  assert.deepEqual(schema.properties['strategy']?.['enum'], ['rebase', 'merge']);
  assert.equal(schema.properties['all']?.['type'], 'boolean');
  assert.equal(schema.properties['extras']?.['type'], 'array');
});

test('a hidden option, a quiet flag and a fixed flag are never offered', () => {
  const offered = Object.keys(inputSchemaFor(command(), preview).properties);
  // `--remote` is hidden from `--help` and so from here; `--quiet` exists for hooks and the
  // status bar; `--dry-run` is what this exposure IS, so offering it would let a caller unset it.
  for (const absent of ['remote', 'quiet', 'dry-run']) {
    assert.ok(!offered.includes(absent), `${absent} should not be a parameter`);
  }
});

test('arguments come back as argv in declared order, with the fixed flags always applied', () => {
  assert.deepEqual(argvFor(command(), preview, { clone: '2' }), ['sync', '2', '--dry-run']);
  assert.deepEqual(argvFor(command(), plain, { clone: '2', all: true, strategy: 'rebase' }), [
    'sync',
    '2',
    '--all',
    '--strategy',
    'rebase',
  ]);
  // Variadic arguments keep their order and stay positional.
  assert.deepEqual(argvFor(command(), plain, { clone: '1', extras: ['2', '3'] }), [
    'sync',
    '1',
    '2',
    '3',
  ]);
  // A false boolean is absent rather than `--all false`, which commander would read as a clone.
  assert.deepEqual(argvFor(command(), plain, { all: false }), ['sync']);
});

test('a parameter nobody declared is refused, never dropped', () => {
  /*
   * Dropping it would run a command that is not the one the caller asked for -- `sync` without
   * the `--all` they misspelled, reported as a success.
   */
  assert.throws(() => argvFor(command(), plain, { al: true }), /has no parameter/);
  assert.throws(() => argvFor(command(), plain, { 'dry-run': true }), /has no parameter/);
  // An object where a value belongs would reach argv as `[object Object]`.
  assert.throws(() => argvFor(command(), plain, { clone: { n: 1 } }), /must be a single value/);
});

test('a required argument that is missing is refused before anything is spawned', () => {
  const required = new Command('change').addArgument(new Argument('<clone>', 'clone'));
  const exposure: Exposure = { name: 'colours_change', path: ['colours', 'change'], acts: true };
  assert.throws(() => argvFor(required, exposure, {}), /needs `clone`/);
});

test('the lede precedes the command’s own description rather than replacing it', () => {
  const text = descriptionFor(command(), preview);
  assert.ok(text.startsWith('Dry run.'));
  assert.ok(text.includes('Bring a clone up to date'), 'the registry’s own text was lost');
  assert.equal(descriptionFor(command(), plain), 'Bring a clone up to date');
});

test('a path is walked by name or by alias, and an unknown one is undefined', () => {
  const root = new Command('hangar');
  const group = root.command('colours').alias('colors');
  group.command('list');
  assert.equal(findCommand(root, ['colours', 'list'])?.name(), 'list');
  assert.equal(findCommand(root, ['colors', 'list'])?.name(), 'list', 'an alias must resolve');
  assert.equal(findCommand(root, ['colours', 'nope']), undefined);
  assert.equal(findCommand(root, ['nope', 'list']), undefined);
});

test('a command with neither a tool nor a place on the absent list is reported', () => {
  const root = new Command('hangar');
  root.command('list');
  root.command('invented');
  const missing = unexposedCommands(root);
  assert.ok(missing.includes('invented'));
  assert.ok(!missing.includes('list'), 'list is exposed and should not be reported');
});
