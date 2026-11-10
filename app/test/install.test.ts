import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { cloneAt, type Clone } from '../src/fleet.ts';
import { nodeVersionFileEscapes } from '../src/config/schema.ts';
import { installChecks, lockfileMismatchLine, plannedSteps, runInstall } from '../src/install.ts';
import { capturedProblems, captureOutput, releaseCapture } from '../src/ui.ts';
import { first, fixtureVscodeConfigText, syntheticHangar } from './fixture.ts';

/**
 * A repo switching package managers, seen from one clone.
 *
 * The second fixture declares `manager: pnpm` in `web/` -- the step these checks exist for --
 * and these are the states a fleet passes through after the repo switches from npm: a branch
 * still on npm's lockfile, the switch commit carrying both, and a `node_modules` npm built that
 * pnpm installed over. The planner touches the filesystem, so each case is a real directory
 * under a temp root, never this hangar.
 */
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const cloneWith = (files: readonly string[]): Clone => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-install-'));
  roots.push(root);
  const clone = cloneAt(syntheticHangar({ root, configText: fixtureVscodeConfigText() }), 1);
  const app = join(clone.path, 'web');
  mkdirSync(app, { recursive: true });
  for (const file of files) {
    mkdirSync(join(app, file, '..'), { recursive: true });
    writeFileSync(join(app, file), '');
  }
  return clone;
};

const pnpmStep = (clone: Clone) => first(plannedSteps(clone), 'install step');
const pnpmCheck = (clone: Clone) => first(installChecks(clone), 'install check');

test('a pnpm step over a checkout holding only npm’s lockfile is a mismatch', () => {
  const mismatch = pnpmStep(cloneWith(['package-lock.json'])).lockfileMismatch;
  assert.deepEqual(mismatch, {
    declared: 'pnpm',
    found: 'npm',
    foundLockfile: 'package-lock.json',
  });
});

test('both lockfiles, or none, is not a mismatch', () => {
  assert.equal(
    pnpmStep(cloneWith(['package-lock.json', 'pnpm-lock.yaml'])).lockfileMismatch,
    undefined,
  );
  assert.equal(pnpmStep(cloneWith([])).lockfileMismatch, undefined);
});

test('the refusal names both lockfiles, both managers and the clone', () => {
  const clone = cloneWith(['package-lock.json']);
  const mismatch = pnpmStep(clone).lockfileMismatch;
  assert.ok(mismatch !== undefined);
  const line = lockfileMismatchLine('web', mismatch, clone.name);
  for (const part of ['package-lock.json', 'pnpm-lock.yaml', 'npm', 'pnpm', clone.name]) {
    assert.ok(line.includes(part), `expected ${part} in: ${line}`);
  }
});

test('doctor is red on a mismatch even when node_modules is there', () => {
  const check = pnpmCheck(cloneWith(['package-lock.json', 'node_modules/.modules.yaml']));
  assert.equal(check.ok, false);
  assert.ok(check.detail.includes('package-lock.json'));
});

test('npm’s node_modules does not count as a pnpm install', () => {
  const check = pnpmCheck(cloneWith(['pnpm-lock.yaml', 'node_modules/.package-lock.json']));
  assert.equal(check.ok, false);
  assert.equal(check.unverifiable, false);
});

test('pnpm installed over npm’s tree is red as a mixed install', () => {
  const check = pnpmCheck(
    cloneWith(['pnpm-lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.package-lock.json']),
  );
  assert.equal(check.ok, false);
  assert.ok(check.detail.includes('mixed'));
});

test('a clean pnpm install is green', () => {
  const check = pnpmCheck(cloneWith(['pnpm-lock.yaml', 'node_modules/.modules.yaml']));
  assert.equal(check.ok, true);
});

test('a dry run refuses the mismatch instead of planning the step', () => {
  captureOutput();
  runInstall(cloneWith(['package-lock.json']), { dryRun: true });
  const refused = capturedProblems();
  releaseCapture(false);
  assert.equal(refused, 1);

  captureOutput();
  runInstall(cloneWith(['pnpm-lock.yaml']), { dryRun: true });
  const clean = capturedProblems();
  releaseCapture(false);
  assert.equal(clean, 0);
});

test('nodeVersionFile may climb out of its step dir, never out of the clone', () => {
  assert.equal(nodeVersionFileEscapes('tools', '../web/.nvmrc'), false);
  assert.equal(nodeVersionFileEscapes('a/b', '../../.nvmrc'), false);
  assert.equal(nodeVersionFileEscapes('tools', '.nvmrc'), false);
  assert.equal(nodeVersionFileEscapes(undefined, 'web/.nvmrc'), false);
  assert.equal(nodeVersionFileEscapes('tools', '../../.nvmrc'), true);
  assert.equal(nodeVersionFileEscapes('tools', '..'), false);
  assert.equal(nodeVersionFileEscapes('tools', '../..'), true);
  // `dir` absent is judged from the clone root, so any climb is refused there.
  assert.equal(nodeVersionFileEscapes(undefined, '../.nvmrc'), true);
  assert.equal(nodeVersionFileEscapes('.', '../.nvmrc'), true);
});

/**
 * An optional package that only some branches carry: green where the branch lacks it, red where
 * it is there and was never installed, and its Node pin read from beside the app.
 */
const cloneWithTools = (files: readonly string[]): Clone => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-install-'));
  roots.push(root);
  const configText = fixtureVscodeConfigText().replace(
    '  # Omitted by the other fixture,',
    [
      '    - dir: tools',
      '      manager: pnpm',
      '      nodeVersionFile: ../web/.nvmrc',
      '      optional: true',
      '      why: the tools package only some branches carry',
      '  # Omitted by the other fixture,',
    ].join('\n'),
  );
  const clone = cloneAt(syntheticHangar({ root, configText }), 1);
  mkdirSync(join(clone.path, 'web'), { recursive: true });
  writeFileSync(join(clone.path, 'web', '.nvmrc'), '24.1.0\n');
  for (const file of files) {
    mkdirSync(join(clone.path, file, '..'), { recursive: true });
    writeFileSync(join(clone.path, file), '');
  }
  return clone;
};

const toolsCheck = (clone: Clone) => {
  const check = installChecks(clone).find((c) => c.name === 'install tools');
  assert.ok(check !== undefined, 'no tools install check');
  return check;
};

test('an optional step on a branch without its dir is green', () => {
  const check = toolsCheck(cloneWithTools([]));
  assert.equal(check.ok, true);
  assert.ok(check.detail.includes('does not exist'));
});

test('an optional step whose dir is there but not installed is red and names the command', () => {
  const clone = cloneWithTools(['tools/pnpm-lock.yaml']);
  const check = toolsCheck(clone);
  assert.equal(check.ok, false);
  assert.ok(check.detail.includes(`hangar install ${clone.name}`));
  assert.equal(
    toolsCheck(cloneWithTools(['tools/pnpm-lock.yaml', 'tools/node_modules/.modules.yaml'])).ok,
    true,
  );
});

test('a climbing nodeVersionFile is read from beside the app', () => {
  const planned = plannedSteps(cloneWithTools(['tools/pnpm-lock.yaml'])).find(
    (p) => p.relDir === 'tools',
  );
  assert.equal(planned?.nodeVersion, '24.1.0');
});
