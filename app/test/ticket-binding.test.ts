import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { issueRow } from '../src/commands/status.ts';
import { cloneAt } from '../src/fleet.ts';
import { issueKeyFor, tmuxStatusArtifact } from '../src/generate/tmux-status-sh.ts';
import { bindingMeaning, inferTicket, KEY_IN_TEXT_RE, NO_TICKET } from '../src/jira.ts';
import { fixtureConfigText, syntheticHangar } from './fixture.ts';

/**
 * A branch's ticket binding, `git config branch.<branch>.<tracker.branchConfigKey>`.
 *
 * Properties, not bytes: the binding outranks the branch name, `none` is an answer rather than a
 * silence, a key outside the configured prefixes is not one, and the bar, `list` and `status`
 * agree on all three. The fixture binds through `ticket` with prefix `BE`.
 */

const unbound = (): ReturnType<typeof syntheticHangar> =>
  syntheticHangar({ configText: fixtureConfigText().replace(/\n {2}branchConfigKey: .*/, '') });

const withRepo = (body: (repo: string, git: (...args: string[]) => void) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-binding-'));
  try {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    };
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.email=t@e.invalid',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    body(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('a binding is a key, none, or nothing -- a typo is nothing, not a ticket', () => {
  assert.equal(bindingMeaning('BE-7'), 'BE-7');
  assert.equal(bindingMeaning(' BE-7\n'), 'BE-7');
  assert.equal(bindingMeaning(NO_TICKET), NO_TICKET);
  assert.equal(bindingMeaning('be-7'), undefined);
  assert.equal(bindingMeaning('soon'), undefined);
  assert.equal(bindingMeaning(undefined), undefined);
});

test('the binding outranks the branch name, and none outranks both', () => {
  const hangar = syntheticHangar();
  withRepo((repo, git) => {
    const clone = { ...cloneAt(hangar, 1), path: repo };
    git('checkout', '-q', '-b', 'feature/BE-1_x');
    assert.deepEqual(inferTicket(clone), { key: 'BE-1', source: 'branch' });
    git('config', 'branch.feature/BE-1_x.ticket', 'BE-2');
    assert.deepEqual(inferTicket(clone), { key: 'BE-2', source: 'binding' });
    git('config', 'branch.feature/BE-1_x.ticket', NO_TICKET);
    assert.equal(inferTicket(clone), NO_TICKET);
  });
});

test('a binding is not read when the hangar names no variable for it', () => {
  withRepo((repo, git) => {
    git('checkout', '-q', '-b', 'feature/BE-1_x');
    git('config', 'branch.feature/BE-1_x.ticket', 'BE-2');
    const clone = { ...cloneAt(unbound(), 1), path: repo };
    assert.deepEqual(inferTicket(clone), { key: 'BE-1', source: 'branch' });
  });
});

test('a key under a prefix the tracker does not own is no ticket', () => {
  withRepo((repo, git) => {
    git('checkout', '-q', '-b', 'feature/XY-9_x');
    // Rooted at a real, empty directory: the commit fallback looks for the default branch there.
    const hangar = syntheticHangar({ root: mkdtempSync(join(tmpdir(), 'hangar-root-')) });
    try {
      assert.equal(inferTicket({ ...cloneAt(hangar, 1), path: repo }), undefined);
    } finally {
      rmSync(hangar.root, { recursive: true, force: true });
    }
  });
});

test('the bar and list take the same order as inferTicket', () => {
  const hangar = syntheticHangar();
  assert.equal(issueKeyFor(hangar, 'feature/BE-1_x', 'BE-2'), 'BE-2');
  assert.equal(issueKeyFor(hangar, 'feature/BE-1_x', NO_TICKET), '');
  assert.equal(issueKeyFor(hangar, 'feature/BE-1_x', undefined), 'BE-1');
  assert.equal(issueKeyFor(hangar, 'no-key-here', 'BE-2'), 'BE-2');
  assert.equal(issueKeyFor(unbound(), 'feature/BE-1_x', 'BE-2'), 'BE-1');
});

test('status says a branch bound to none is none on purpose, and where a bound key came from', () => {
  const clone = cloneAt(syntheticHangar(), 1);
  assert.match(issueRow(clone, NO_TICKET), /on purpose/);
  assert.doesNotMatch(issueRow(clone, NO_TICKET), /none inferred/);
  assert.match(issueRow(clone, { key: 'BE-7', source: 'binding' }), /binding/);
});

test("the bar's own ticket field reads the binding the way issueKeyFor does", () => {
  // Two implementations of one rule are only safe while something runs both.
  const root = mkdtempSync(join(tmpdir(), 'hangar-bar-'));
  try {
    const hangar = syntheticHangar({ root });
    const clone = cloneAt(hangar, 1);
    mkdirSync(clone.path, { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', clone.path, ...args], { encoding: 'utf8' });
    };
    git('init', '-q', '-b', 'feature/BE-1_x');
    const script = join(root, 'status.sh');
    writeFileSync(script, tmuxStatusArtifact(hangar).content, { mode: 0o755 });
    const field = (): string =>
      execFileSync('sh', [script, 'ticket', clone.name, clone.path], { encoding: 'utf8' }).trim();
    for (const bound of ['BE-2', NO_TICKET, 'not-a-key', undefined]) {
      if (bound === undefined) git('config', '--unset-all', 'branch.feature/BE-1_x.ticket');
      else git('config', 'branch.feature/BE-1_x.ticket', bound);
      assert.equal(field(), issueKeyFor(hangar, 'feature/BE-1_x', bindingMeaning(bound)), bound);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const gateSource = join(import.meta.dirname, '..', '..', 'bin', 'hangar-commit-gate');

test('the commit gate spells the key pattern the way jira.ts does', () => {
  // The gate is CommonJS and reads no config, so it cannot import the pattern; it mirrors it.
  assert.ok(readFileSync(gateSource, 'utf8').includes(`/${KEY_IN_TEXT_RE.source}/`));
});

test('a session starting under an ARMED gate is told its ticket', () => {
  /*
   * Run from a copy under a temp root: the gate finds its state directory from its own location,
   * so the live script would write into this hangar's `.hangar/`.
   */
  const root = mkdtempSync(join(tmpdir(), 'hangar-gate-'));
  try {
    mkdirSync(join(root, 'bin'));
    const gate = join(root, 'bin', 'hangar-commit-gate');
    copyFileSync(gateSource, gate);
    const clone = join(root, 'c');
    execFileSync('git', ['init', '-q', '-b', 'main', clone]);
    execFileSync(
      'git',
      ['-C', clone, '-c', 'user.email=t@e.invalid', '-c', 'user.name=t'].concat([
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      ]),
    );
    const start = (): string =>
      execFileSync('node', [gate], {
        cwd: clone,
        input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: clone }),
        encoding: 'utf8',
      });
    assert.equal(start(), '', 'an unarmed gate said something at session start');
    execFileSync('node', [gate, 'arm', '--ticket', 'ABC-12'], { cwd: clone });
    const said = JSON.parse(start()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(said.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(said.hookSpecificOutput.additionalContext, /ARMED for ABC-12/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
