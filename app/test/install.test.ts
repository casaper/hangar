import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { cloneAt, type Clone } from '../src/fleet.ts';
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
