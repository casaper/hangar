import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  wantsWorkspaceFiles,
  workspaceCloneValues,
  workspaceContent,
  workspacePaths,
} from '../src/clone-config.ts';
import { render, templatize, vscodeArtifacts } from '../src/editor/vscode.ts';
import { cloneAt } from '../src/fleet.ts';
import { first, fixtureConfigText, fixtureVscodeConfigText, syntheticHangar } from './fixture.ts';

/**
 * The `*.code-workspace` artifact, asserted to be gated on `editor.kinds`.
 *
 * This is the "input that is WRONG" half of the seed suite: the workspace file used to be
 * written by `add-clone`, checked by `doctor` and recreated by `--fix` on EVERY hangar,
 * including one whose config lists only editors that have no such thing. A golden capture could
 * not have shown it, because until the gate landed the capture recorded it as correct -- the
 * gated baseline carried three rendered workspace files for a `kinds: [zed]` fixture.
 *
 * The two fixtures disagree here, which is what makes both directions assertable from committed
 * files rather than from a config invented in-test: `fixture.config.yaml` is `kinds: [zed]` and
 * `fixture-vscode.config.yaml` is `kinds: [vscode, jetbrains]`.
 */

const vscodeHangar = (): ReturnType<typeof syntheticHangar> =>
  syntheticHangar({ configText: fixtureVscodeConfigText() });

test('a hangar with no VS Code-family editor wants no workspace file', () => {
  const hangar = syntheticHangar();

  // The guard on the guard: if the fixture is ever re-aimed at VS Code, this fails here loudly
  // rather than passing while proving nothing.
  assert.ok(
    !hangar.config.editor.kinds.includes('vscode'),
    'the plain fixture lists no VS Code kind',
  );
  assert.ok(
    hangar.config.editor.kinds.length > 0,
    'it does configure an editor — just not that one',
  );

  assert.equal(wantsWorkspaceFiles(hangar), false);
});

test('a hangar that lists one does, even beside a kind that does not', () => {
  const hangar = vscodeHangar();

  assert.ok(hangar.config.editor.kinds.includes('vscode'), 'the vscode fixture lists it');
  assert.ok(
    hangar.config.editor.kinds.includes('jetbrains'),
    'and a second kind that reads no workspace file',
  );

  assert.equal(wantsWorkspaceFiles(hangar), true);
});

test('the builder stays pure — it answers for a hangar that wants none', () => {
  /*
   * The gate is at the three callers, never in `workspacePaths`, and this is what says so.
   * Gating the builder instead would have made `editor/vscode.ts` -- which is only constructed
   * when a VS Code kind IS configured -- ask a question it has already answered, and would have
   * left `hangar ide vscode sync` unable to name the file it syncs.
   */
  const clone = cloneAt(syntheticHangar(), 1);

  assert.equal(wantsWorkspaceFiles(clone.hangar), false);
  assert.equal(workspacePaths(clone).length, 1, 'still renders every configured workspaceDir');
});

test('the schema default is a kind that wants one, which is what makes the fallback safe', () => {
  /*
   * `editor/index.ts` resolves `kinds` to the schema default when the config will not parse, so
   * a hangar with a typo in an unrelated line reports `['vscode']`. That fallback is only the
   * recoverable answer while the default is a kind that WANTS the workspace file: if the default
   * ever moved to a kind that does not, the same typo would start deleting an artifact from
   * every clone instead of leaving it alone.
   *
   * Asserted through the parser rather than by reading `DEFAULT_EDITOR_KIND`, so it is the same
   * route `editor/index.ts` takes to the fallback.
   */
  const text = fixtureConfigText().replace('  kinds: [zed]\n', '');
  // A replace that silently fails to match would leave `[zed]` in place and send you debugging
  // the wrong assertion.
  assert.ok(!text.includes('kinds:'), 'the kinds line was removed from the fixture');
  const hangar = syntheticHangar({ configText: text });

  assert.equal(wantsWorkspaceFiles(hangar), true);
});

/**
 * The per-clone half of the workspace file, through a sync.
 *
 * `ide vscode sync` takes the newest copy of a file and writes it into every clone, so anything
 * per-clone in it has to survive the round trip as a TOKEN. This is the assertion that it does:
 * without it a single sync hands every clone the source clone's name and hue, which is the one
 * thing the fleet's colours exist to prevent -- and it would look like a success, because syncing
 * is exactly what the command reports having done.
 */
test('a synced workspace file arrives carrying the RECEIVING clone name and hue', () => {
  const hangar = syntheticHangar({ configText: fixtureVscodeConfigText() });
  const [one, two] = [cloneAt(hangar, 1), cloneAt(hangar, 3)];
  const artifact = first(
    vscodeArtifacts(hangar.config.editor.rootPathKeys).filter((a) => a.id === '*.code-workspace'),
    'the workspace artifact',
  );

  const source = workspaceContent(one);
  const { template } = templatize(artifact, source, one);
  const arrived = render(template, two);

  assert.equal(arrived, workspaceContent(two), 'a sync must rebuild, not copy');
  for (const [key, value] of Object.entries(workspaceCloneValues(two))) {
    assert.ok(arrived.includes(`"${key}": "${value}"`), `${key} did not arrive as clone 3's`);
  }
  // And the source clone's own values are gone -- the half that a copy would have left behind.
  assert.ok(!arrived.includes(one.name), `the receiving clone is called ${one.name}`);
  assert.ok(!arrived.includes(one.colour.main), "it is wearing clone 1's hue");
});

test('round-tripping a clone through itself changes nothing', () => {
  const hangar = syntheticHangar({ configText: fixtureVscodeConfigText() });
  const clone = cloneAt(hangar, 2);
  const artifact = first(
    vscodeArtifacts(hangar.config.editor.rootPathKeys).filter((a) => a.id === '*.code-workspace'),
    'the workspace artifact',
  );
  const source = workspaceContent(clone);
  // Idempotence is what makes `ide vscode sync` safe to run twice, and what makes its
  // "in sync" report mean anything at all.
  assert.equal(render(templatize(artifact, source, clone).template, clone), source);
});

test('a PADDED folder label keeps its padding through a sync', () => {
  // `{index2}` is the padded index, and rendering the token back as a bare `clone.index` turns
  // `vsfix clone 0003` into `vsfix clone 3` -- a label rewritten by a command that reports a
  // successful sync. Latent in a hangar whose label uses `{index}`, which is why the second
  // fixture declares the other form.
  const hangar = syntheticHangar({ configText: fixtureVscodeConfigText() });
  assert.match(hangar.config.editor.workspaceFolderLabel, /\{index2\}/, 'the fixture must pad');
  const clone = cloneAt(hangar, 3);
  const artifact = first(
    vscodeArtifacts(hangar.config.editor.rootPathKeys).filter((a) => a.id === '*.code-workspace'),
    'the workspace artifact',
  );
  const arrived = render(templatize(artifact, workspaceContent(clone), clone).template, clone);
  assert.match(arrived, /"name": "vsfix clone 0003"/);
});
