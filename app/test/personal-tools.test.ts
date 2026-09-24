import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { defaultSettings, personalToolAllows } from '../src/clone-config.ts';
import { cloneAt } from '../src/fleet.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * The two standalone helpers in `bin/`, which no builder renders and no capture holds.
 *
 * `gated/` pins what the CLI WRITES. These two are written by hand and shipped as files, so
 * nothing in the golden net would move if one of them started naming a company, a ticket or a
 * branch -- and both carry prose aimed at an agent, which is exactly the text that tends to. The
 * assertions below are the only thing standing between that prose and the tracked tree.
 */
const binDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin');

const script = (name: string): string => readFileSync(join(binDir, name), 'utf8');

/**
 * Literals belonging to the repository this hangar happens to manage.
 *
 * The same list `generic-text.test.ts` guards the builders with, and for the same reason: a
 * hangar manages any repo, so a helper that names this one is wrong in every other. The BARE
 * ticket prefix rather than a whole key, deliberately -- it forbids every ticket rather than one,
 * and a bulk find-and-replace over the tree would rewrite a whole key and leave a guard that
 * guards nothing while every check stays green.
 */
const THIS_REPOS_OWN = ['dvb', 'DN-', 'clone_0', 'angular/', 'bitbucket', 'jira'] as const;

for (const name of ['hangar-waypoint', 'hangar-commit-gate']) {
  test(`${name} names no repository, ticket or organisation`, () => {
    const text = script(name).toLowerCase();
    for (const literal of THIS_REPOS_OWN) {
      assert.ok(!text.includes(literal.toLowerCase()), `${name} names "${literal}"`);
    }
  });
}

test('the waypoint ref namespace is the hangar’s, not this fleet’s', () => {
  /*
   * The one literal the port had to change. Upstream this was `refs/dvb-waypoints/<branch>`,
   * which names the repo it was built in -- harmless there and wrong in a tool that ships.
   */
  const text = script('hangar-waypoint');
  assert.match(text, /refs\/hangar-waypoints/);
  assert.ok(!text.includes('dvb-waypoints'));
});

test('the commit gate suspends committing without naming another repo’s rule numbering', () => {
  /*
   * The version this was ported from opened its banner by suspending three of its repo's
   * NUMBERED workflow rules. That text is wrong in every other repo and breaks the moment the
   * project renumbers, so the generated half says only that the gate is on and what the two
   * permitted next actions are. Project-specific prose belongs in the skill that drives this.
   */
  const text = script('hangar-commit-gate');
  assert.ok(!/Critical Workflow Rule/i.test(text));
  assert.ok(!/Git Workflow Rule/i.test(text));
  // What it must still carry: the field a deny's text actually reaches the agent by.
  assert.match(text, /permissionDecisionReason/);
});

test('the gate guards its own release, because a permission rule cannot', () => {
  /*
   * `Bash(hangar-commit-gate status:*)` in `allow` with no entry for `release` reads like a
   * boundary and is not one. A permission rule matches the START of the command string, so
   * `hangar-commit-gate status && hangar-commit-gate release` begins with the approved prefix.
   * Measured against the real hook before this guard existed: that line, a bare `release`, and
   * `rm .../.hangar/commit-gate/<clone>.json` were ALL allowed.
   *
   * Same finding, same shape and same answer as `hangar-exec-guard`: the rule stays because it
   * refuses more clearly, but the half that holds is the hook, which sees the whole line.
   */
  const text = script('hangar-commit-gate');
  assert.match(text, /GATE_RELEASE/);
  assert.match(text, /GATE_STATE/);

  // The patterns themselves, applied the way the hook applies them.
  const release = /hangar-commit-gate\s+(?:--\S+\s+)*(?:release|unlock)\b/;
  // The state guard is a plain substring in the hook too — matched on the DIRECTORY name rather
  // than a resolved path, so a relative spelling, a glob or a `$HOME` form is caught as well.
  const state = '.hangar/commit-gate';
  for (const line of [
    'hangar-commit-gate status && hangar-commit-gate release',
    'hangar-commit-gate release',
    'hangar-commit-gate unlock',
  ]) {
    assert.ok(release.test(line), `a release escape is not caught: ${line}`);
  }
  for (const line of [
    'rm -rf .hangar/commit-gate',
    'echo x > $HOME/h/.hangar/commit-gate/c.json',
  ]) {
    assert.ok(line.includes(state), `a state-file escape is not caught: ${line}`);
  }
  // Reading is not escaping, and ordinary work must stay untouched on the hot path.
  for (const line of ['hangar-commit-gate status', 'git status', 'npm test']) {
    assert.ok(!release.test(line) && !line.includes(state), `wrongly caught: ${line}`);
  }
});

test('restore is pre-approved whole, and the gate only to be read', () => {
  /*
   * The asymmetry is the security property, so it is asserted rather than left to review. A
   * `Bash(hangar-commit-gate:*)` here would let an agent release the gate it is being held by,
   * which is the one thing the gate exists to prevent.
   */
  const allows = personalToolAllows();
  assert.ok(allows.includes('Bash(hangar-waypoint:*)'));
  assert.ok(allows.includes('Bash(hangar-commit-gate status:*)'));
  assert.ok(
    !allows.some((entry) => entry.includes('hangar-commit-gate:')),
    'the gate must not be allowed whole — lock/release/unlock have to ask',
  );
});

test('the whole-tree spellings the upstream guard let through are refused', () => {
  /*
   * `restore`'s no-paths guard does not bound the blast radius on its own. Measured against a
   * real repo: `.` is rejected by `missingFrom`, so it LOOKS as though a root revert is already
   * impossible -- but `./` and the empty string both resolve to the root tree, exit 0, sail past
   * the check and hand `git restore` the entire working tree. With `Bash(hangar-waypoint:*)`
   * pre-approved that happens with no prompt.
   */
  const text = script('hangar-waypoint');
  assert.match(text, /REPO_ROOT_PATHS/);
  for (const spelling of ["''", "'.'", "'./'", "'/'"]) {
    assert.ok(text.includes(spelling), `the root-path guard does not cover ${spelling}`);
  }
  // And the guard must run BEFORE anything is written, or a refusal still burns a waypoint slot.
  const guardAt = text.indexOf('revertsWholeTree(path, root)');
  const writeAt = text.indexOf("git(['rev-parse', entry(index)]");
  assert.ok(guardAt !== -1 && writeAt !== -1);
  assert.ok(guardAt < writeAt, 'the whole-tree guard must precede resolving and writing');
});

/**
 * The publish refusal, exercised against the real guard.
 *
 * These cases live in a test FILE rather than a shell probe for a reason worth knowing: the guard
 * runs on every Bash call in this repo too, and it cannot tell a command from data -- so a probe
 * whose own command line spelled these out was denied by the thing it was testing. A file is read
 * by the runner and never appears on a command line, so the literals are safe here.
 */
const guardSays = (command: string): boolean => {
  const out = execFileSync('node', [join(binDir, 'hangar-exec-guard')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  return out.trim() !== '';
};

test('publishing is refused in every spelling, and nothing else is', () => {
  for (const command of [
    'git push',
    'git push --force origin main',
    'git push --force-with-lease',
    // The spelling a permission rule cannot hold: a rule matches the START of the string.
    'cd /elsewhere && git -C /x push',
    'git send-pack origin',
    'gh pr create --fill',
    'gh pr merge 42',
    '/usr/bin/git push',
  ]) {
    assert.ok(guardSays(command), `publishing was ALLOWED: ${command}`);
  }

  // False positives matter as much: a guard that blocks ordinary work gets switched off.
  for (const command of [
    'git status',
    'git log --grep=push',
    'git commit -m "prepare to push"',
    'cat src/push.ts',
    'npm run push-docs',
    'git fetch origin',
    'gh pr view 42',
    'docker exec -it c sh',
  ]) {
    assert.ok(!guardSays(command), `ordinary work was denied: ${command}`);
  }
});

test('the rewrite tool refuses published history and never publishes', () => {
  /*
   * `hangar-rewrite` exists because a blanket "never rewrite" rule is a proxy for the thing that
   * actually matters -- never rewrite what other people already have. It enforces the real rule
   * instead of the proxy, so the proxy's protection is kept rather than traded away.
   *
   * These assert the properties are IN the script; the refusals themselves were exercised
   * against a live repo (a published HEAD, and three remote-reaching argument forms).
   */
  const text = script('hangar-rewrite');
  assert.match(
    text,
    /branch.*--remotes.*--contains|--remotes/,
    'it must ask git what is published',
  );
  assert.match(text, /refusePublished/);
  assert.match(text, /REMOTE_REACHING|REMOTE_WORDS/);
  // Every rewrite is undoable, which is what makes the capability safe to have at all.
  assert.match(text, /hangar-waypoint/);
  /*
   * It must build no publishing invocation of its own. Asserted on the CALL shape rather than on
   * the words: the script necessarily contains `push` and `send-pack` inside the pattern that
   * REFUSES them, and a naive substring check fails on its own guard -- which it did, first try.
   */
  for (const call of ["run(['push'", "['push',", '"push"', "'push']"]) {
    assert.ok(!text.includes(call), `the rewrite tool builds a publish: ${call}`);
  }
});

test('the rewrite tool rebases only an unpublished range, and never leaves one stopped', () => {
  /*
   * A repo that forbids `git rebase` forbids `--abort` and `--continue` with it, so a session left
   * mid-rebase has no way out through git. The verb aborts on conflict and exits 2 for "merge
   * instead". Checking HEAD alone would let one local commit on top of pushed ones through, so the
   * whole range is checked. Both were exercised against a scratch upstream and clone.
   */
  const text = script('hangar-rewrite');
  const verb = /const rebase = [\s\S]*?\n};\n/.exec(text)?.[0] ?? '';
  assert.ok(verb !== '', 'the rebase verb must exist');
  assert.match(verb, /refusePublishedRange\(/);
  assert.match(verb, /waypoint\(/);
  assert.match(verb, /'rebase', '--abort'/);
  assert.match(verb, /process\.exit\(2\)/);
  assert.match(text, /--not', '--remotes'/);
  // `autosquash` replays a range too, so it owes both properties for the same reasons.
  const squash = /const autosquash = [\s\S]*?\n};\n/.exec(text)?.[0] ?? '';
  assert.match(squash, /refusePublishedRange\(/);
  assert.match(squash, /'rebase', '--abort'/);
});

test('the rewrite tool is deliberately NOT pre-approved', () => {
  // "Only if I ask for it" is enforced by absence: with no allow entry, every call prompts.
  assert.ok(
    !personalToolAllows().some((entry) => entry.includes('hangar-rewrite')),
    'rewriting history must ask every time',
  );
});

test('both hooks are wired into a clone, and the gate on both events', () => {
  const hangar = syntheticHangar();
  const settings = defaultSettings(cloneAt(hangar, 1));
  const commands = (event: string): string[] =>
    (settings.hooks?.[event] ?? []).flatMap((matcher) => matcher.hooks.map((h) => h.command));

  // Absolute, because a hook's PATH is whatever the session started with.
  assert.ok(commands('PreToolUse').some((c) => c.endsWith('/bin/hangar-commit-gate')));
  assert.ok(commands('SessionStart').some((c) => c.endsWith('/bin/hangar-commit-gate')));
  // Half a gate is the worst of the three states: a deny in a session never told why.
  assert.equal(
    commands('PreToolUse').filter((c) => c.endsWith('hangar-commit-gate')).length,
    1,
    'exactly one gate hook per event',
  );
});
