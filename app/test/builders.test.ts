import assert from 'node:assert/strict';
import { test } from 'node:test';

import { join } from 'node:path';

import {
  claudeLocalMdContent,
  cloneSymlinks,
  defaultSettings,
  envLocalContent,
  envrcPrivateContent,
  excludeBlock,
  healthCheckAllows,
  settingsContentFor,
  workspaceContent,
  workspacePaths,
} from '../src/clone-config.ts';
import { cloneAt } from '../src/fleet.ts';
import { hangarClaudeLocalMdContent } from '../src/hangar-files.ts';
import { namesNoMachinePath, syntheticHangar } from './fixture.ts';

/**
 * The byte-compared builders -- asserted by PROPERTY, never by snapshot.
 *
 * `gated/fixture/` already pins every one of these byte for byte, and a second copy of the
 * expected text here would be a second oracle to hand-update on every prose edit -- exactly the
 * work the golden net exists to absorb. So nothing below compares whole output. What it asserts
 * is the handful of things that are TRUE of the text regardless of how it is worded, and each
 * one is a rule that was broken once:
 *
 * - a value derived from config actually reaches the file (`{index2}` rendered, offset applied);
 * - the identity files name their own subject and nothing about the fleet's shape;
 * - the health-check permission is per role that declares one, and anchored.
 */

const hangar = (): ReturnType<typeof syntheticHangar> => syntheticHangar();

test('envLocalContent carries every role at this clone’s port, under its own env key', () => {
  const text = envLocalContent(cloneAt(hangar(), 3));
  assert.match(text, /^FIXTURE_API_PORT=3237$/m);
  assert.match(text, /^FIXTURE_DB_PORT=5669$/m);
  assert.match(text, /^FIXTURE_SWAGGER_PORT=8317$/m);
  // The root path key is the config's, not a hardcoded name.
  assert.match(text, /^FIXTURE_REPO_ROOT=/m);
});

test('envLocalContent renders the templated per-clone variables', () => {
  /*
   * This is what gives a SQL clone its own database. `{index2}` is padded by `clones.pad`, which
   * the fixture sets to 3 -- so a renderer that ignored the pad, or one that wrote the token
   * through verbatim, both show up here rather than in a running server pointed at the wrong
   * database.
   */
  const text = envLocalContent(cloneAt(hangar(), 3));
  assert.match(text, /^PGDATABASE=warehouse_003$/m);
  assert.match(text, /^COMPOSE_PROJECT_NAME=wt-003$/m);
  assert.match(text, /^PGRST_DB_SCHEMA=api_3$/m);
  assert.ok(!text.includes('{'), 'a token reached the dotenv unrendered');
});

test('claudeLocalMdContent names its own clone and no sibling', () => {
  /*
   * The rule the builder's own header records: an earlier version listed the siblings by name,
   * which made `doctor` red on every surviving clone after each `add-clone` or `remove-clone`
   * until someone re-ran `--fix`. Which clones exist stays underived from any file.
   */
  const text = claudeLocalMdContent(cloneAt(hangar(), 2));
  assert.ok(text.includes('wt-002'));
  for (const sibling of ['wt-001', 'wt-003', 'wt-004']) {
    assert.ok(!text.includes(sibling), `the identity file names ${sibling}`);
  }
  assert.ok(namesNoMachinePath(text));
});

test('hangarClaudeLocalMdContent takes the hangar and nothing else', () => {
  // Same rule one level up, and the reason the ports appear as a FORMULA plus a role table
  // rather than a per-clone grid: a grid here would be a second answer to `hangar ports`.
  const text = hangarClaudeLocalMdContent(hangar());
  assert.match(text, /base \+ 37 \+ \(index - 1\) \* 100/);
  // The PATTERN plus one worked example -- never a roster. `wt-001` appears twice on purpose
  // (`e.g.` and the `git -C` line), and a SECOND index appearing is what a list would look like.
  assert.match(text, /`wt-<NN>`/);
  for (const later of ['wt-002', 'wt-003', 'wt-004']) {
    assert.ok(!text.includes(later), `the hangar identity file lists ${later}`);
  }
  // The database role declares `url: null`, so the table must say so rather than publish a link
  // to nothing. This is the row the fixture got wrong until `ports.test.ts` was written.
  assert.match(text, /\| PostgreSQL \| `FIXTURE_DB_PORT` \| 5432 \| _none_ \|/);
});

test('one health-check permission per role that declares one, anchored to its port', () => {
  /*
   * The fixture declares a health check on `api` alone. A permission entry per ROLE would give
   * the db and swagger roles one too, and a broadened pattern would let a clone curl a SIBLING's
   * port -- which reports the wrong server as healthy, silently.
   */
  const clone = cloneAt(hangar(), 2);
  const allows = healthCheckAllows(clone);
  assert.equal(allows.length, 1);
  assert.match(allows[0] ?? '', /http:\/\/localhost:3137\/ready\)$/);
  assert.ok(!allows[0]?.includes('5569'), 'the db role got a health check it never declared');

  const rendered = settingsContentFor(clone, defaultSettings(clone));
  assert.ok(rendered.includes('3137/ready'));
  assert.ok(!rendered.includes('3237'), 'clone 2 was allowed to curl clone 3');
});

test('defaultSettings denies the secrets file and allows only its own clone', () => {
  /*
   * The path `add-clone` takes for clone #1, which used to throw -- the only reason the README
   * once told a stranger to create the first clone by hand. Asserting it parses would pass for
   * `{}`, so what is checked is the two entries that actually do something:
   *
   * - the DENY on the hangar's secrets file. It is the one line keeping a clone session from
   *   reading every credential the fleet has, and it must name the CONFIGURED file rather than
   *   `.env.shared`, which is only the default.
   * - the allow scoped to this hangar's root, so a session cannot read a second hangar's tree.
   */
  const clone = cloneAt(hangar(), 1);
  const settings = defaultSettings(clone);
  const permissions = settings.permissions;
  assert.ok(permissions !== undefined, 'defaultSettings produced no permissions block');
  assert.deepEqual(permissions.deny, ['Read(/wt/.env.fixture-shared)']);
  // Exactly these, and nothing else. A permission list is a security boundary, so "contains" is
  // the wrong assertion: an entry that appeared here without anyone deciding to add it is the
  // failure, and only an exhaustive comparison catches that.
  assert.deepEqual(permissions.allow, [
    'Read(/wt/**)',
    'Bash(curl -s -o /dev/null -w "%{http_code}" --max-time 7 http://localhost:3037/ready)',
  ]);

  const text = settingsContentFor(clone, settings);
  const parsed: unknown = JSON.parse(text);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  assert.ok(namesNoMachinePath(text));
});

test('the git exclude block hides the identity file', () => {
  // Excluded via `.git/info/exclude` rather than the tracked `.gitignore`, so it never commits
  // and never travels to a sibling.
  assert.match(excludeBlock(hangar()), /^\/CLAUDE\.local\.md$/m);
});

test('symlinks render {secretsFile} and each carries its why', () => {
  const links = cloneSymlinks(cloneAt(hangar(), 1));
  assert.equal(links.length, 1);
  const link = links[0];
  assert.ok(link !== undefined);
  assert.equal(link.relPath, 'sql/local.env');
  // The target is the hangar's secrets file by its CONFIGURED name, rendered from the token.
  assert.equal(link.target, '/wt/.env.fixture-shared');
  // `why` is required by the schema because it is the only place a reader learns why the link
  // exists -- `doctor` prints it when the link is missing.
  assert.ok(link.why.length > 0);
});

test('workspace files come from editor.workspaceDirs and workspaceFileName', () => {
  const clone = cloneAt(hangar(), 2);
  const paths = workspacePaths(clone);
  // Two things at once: the fixture declares ONE workspace directory where this hangar declares
  // two (a hardcoded pair would give a length of 2), and `{index2}` pads to `clones.pad` -- 3
  // here -- rather than to the literal 2 its name suggests.
  assert.deepEqual(paths, ['/wt/wt-002/wt-002.fixture-workspace']);
  assert.ok(namesNoMachinePath(workspaceContent(clone)));
});

test('a hangar under $HOME is written as $HOME, not as a literal home path', () => {
  /*
   * The one place a builder reads the environment rather than the threaded hangar
   * (`envSharedShellRef` in `clone-config.ts`), and so the one live subject
   * `namesNoMachinePath` has -- every other test here passes it by construction, because a
   * synthetic root cannot contain a home directory to leak.
   *
   * `$HOME` rather than `/Users/someone` is what lets the generated `.envrc.private` be read by
   * a human without it looking like one machine's file, and it is what the existing clones
   * already carry. A regression here is invisible: both forms work on the machine that wrote
   * them.
   */
  const realHome = process.env['HOME'];
  assert.ok(realHome !== undefined && realHome !== '', 'this test needs $HOME set');
  const underHome = syntheticHangar({ root: join(realHome, 'synthetic-hangar') });
  const text = envrcPrivateContent(underHome);
  assert.match(text, /\$HOME\/synthetic-hangar\/\.env\.fixture-shared/);
  assert.ok(!text.includes(realHome), 'the literal home path reached the generated file');
});
