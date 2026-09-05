import assert from 'node:assert/strict';
import { test } from 'node:test';

import { wantsWorkspaceFiles, workspacePaths } from '../src/clone-config.ts';
import { cloneAt } from '../src/fleet.ts';
import { fixtureConfigText, fixtureVscodeConfigText, syntheticHangar } from './fixture.ts';

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
