import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  execPlanLines,
  execSummaryLines,
  scriptFor,
  shellFor,
  splitExecArgv,
  type ExecResult,
} from '../src/commands/exec.ts';
import { cloneAt } from '../src/fleet.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * `hangar exec`'s pure builders.
 *
 * **No golden capture can reach any of this.** The command's output is six interactive shells
 * and whatever they printed; what it gets right or wrong is an argv split and a script it hands
 * to another program, and every failure here is of the shape "typechecks, runs, does something
 * quietly wrong":
 *
 * - a clone ref and a snippet word are the same token to commander, so a bad split runs the
 *   wrong thing in the wrong places;
 * - a snippet beginning with a flag OF OURS being eaten as one;
 * - the direnv preamble going missing, which does not fail -- it silently runs the snippet
 *   against the hangar's environment instead of the clone's, which is the trap `install.ts`
 *   already records biting once.
 */

// ---------------------------------------------------------------------------------------------
// splitExecArgv
// ---------------------------------------------------------------------------------------------

test('the split is at the first `--`, and refs never come from after it', () => {
  // Exactly the argv commander mangles: it merges all of this into one variadic list, where
  // "1", "3" and "git" are indistinguishable. That is why this function exists at all.
  const { refs, snippet } = splitExecArgv(['1', '3', '--', 'git', 'status', '-sb']);
  assert.deepEqual(refs, ['1', '3']);
  assert.equal(snippet, 'git status -sb');
});

test('a snippet whose first word is a flag of OURS is still the snippet', () => {
  // `--all` and `--help` after `--` must never be read as options, or `-- --help` would print
  // hangar's own help instead of running the snippet.
  for (const flag of ['--all', '--help', '-n', '--serial']) {
    const { refs, snippet } = splitExecArgv(['--', flag]);
    assert.deepEqual(refs, [], `${flag} leaked into the refs`);
    assert.equal(snippet, flag);
  }
});

test('our own flags before the `--` are not mistaken for clone refs', () => {
  const { refs, snippet } = splitExecArgv(['--all', '--serial', '--', 'pnpm', 'outdated']);
  assert.deepEqual(refs, []);
  assert.equal(snippet, 'pnpm outdated');
});

test('flags belonging to the snippet survive verbatim', () => {
  const { snippet } = splitExecArgv(['2', '--', 'git', 'log', '--oneline', '-5']);
  assert.equal(snippet, 'git log --oneline -5');
});

test('no `--` at all yields no snippet, so the command can refuse rather than run something', () => {
  const { refs, snippet } = splitExecArgv(['1', '2']);
  assert.equal(snippet, '');
  assert.deepEqual(refs, []);
});

test('a lone `--` yields an empty snippet, not a crash', () => {
  const { refs, snippet } = splitExecArgv(['--all', '--']);
  assert.equal(snippet, '');
  assert.deepEqual(refs, []);
});

test('a snippet quoted as ONE argument survives byte for byte', () => {
  // The documented escape from the lossy join: the outer shell splits argv before hangar sees
  // it, so this is the only way to keep spacing and operators exactly as written.
  const tricky = 'grep "two  words" . && echo \'done\'';
  assert.equal(splitExecArgv(['--all', '--', tricky]).snippet, tricky);
});

test('only the FIRST `--` splits, so a snippet may contain its own', () => {
  const { refs, snippet } = splitExecArgv(['1', '--', 'git', 'log', '--', 'path/to/file']);
  assert.deepEqual(refs, ['1']);
  assert.equal(snippet, 'git log -- path/to/file');
});

// ---------------------------------------------------------------------------------------------
// scriptFor / shellFor
// ---------------------------------------------------------------------------------------------

test('the direnv preamble precedes the snippet, and is dropped by --no-direnv', () => {
  const withIt = scriptFor('echo hi', 'zsh', true);
  assert.match(withIt, /^eval "\$\(direnv export zsh 2>\/dev\/null\)"\n/);
  assert.ok(withIt.endsWith('echo hi'));
  assert.equal(scriptFor('echo hi', 'zsh', false), 'echo hi');
});

test('the preamble names the shell direnv is exporting for', () => {
  assert.match(scriptFor('x', 'bash', true), /direnv export bash/);
});

test('a snippet opening with a comment cannot swallow the line before it', () => {
  // A `;` join would have made the whole preamble part of the comment, silently losing the
  // clone's environment. A newline is what keeps the two statements separate.
  const script = scriptFor('# a comment\necho hi', 'zsh', true);
  assert.ok(script.split('\n')[0]?.startsWith('eval '));
});

test('the shell comes from $SHELL, and falls back rather than assuming zsh', () => {
  assert.deepEqual(shellFor({ SHELL: '/opt/homebrew/bin/fish' }), {
    path: '/opt/homebrew/bin/fish',
    name: 'fish',
  });
  assert.equal(shellFor({}).path, '/bin/sh');
});

// ---------------------------------------------------------------------------------------------
// The reports
// ---------------------------------------------------------------------------------------------

const clonesFor = (indexes: readonly number[]) => {
  const hangar = syntheticHangar();
  return indexes.map((i) => cloneAt(hangar, i));
};

test('the plan names every selected clone, its path, and the snippet', () => {
  const clones = clonesFor([1, 2, 3]);
  const text = execPlanLines(clones, 'git status -sb', 'zsh', true, []).join('\n');
  for (const clone of clones) {
    assert.ok(text.includes(clone.name), `${clone.name} is missing from the plan`);
    assert.ok(text.includes(clone.path), `${clone.path} is missing from the plan`);
  }
  assert.ok(text.includes('git status -sb'));
  assert.ok(text.includes('3 clones'));
});

test('the plan says which environment the snippet will actually get', () => {
  const clones = clonesFor([1]);
  assert.match(execPlanLines(clones, 'x', 'zsh', true, []).join('\n'), /direnv/);
  assert.match(execPlanLines(clones, 'x', 'zsh', false, []).join('\n'), /--no-direnv/);
});

test('a busy clone is NAMED by the plan and never removed from it', () => {
  // The difference from `sync`, which skips. A snippet is the user's own typed intent, so the
  // plan informs rather than decides -- but a run into six live agents must not be silent.
  const clones = clonesFor([1, 2]);
  const [first, second] = clones;
  // Derived, never a literal: the fixture config disagrees with the schema defaults on purpose,
  // so its clones are not called `clone_NN` and a hardcoded name would pass for the wrong reason.
  const lines = execPlanLines(clones, 'x', 'zsh', true, [second?.name ?? '']);
  assert.match(lines.join('\n'), new RegExp(`live Claude session in: ${second?.name ?? ''}`));
  assert.ok(lines.some((l) => l.includes(second?.name ?? '')));
  assert.ok(
    lines.some((l) => l.startsWith(`  ${first?.name ?? ''}`)),
    'the clone with nobody in it is still listed as a target',
  );
});

test('the summary is in index order, whatever order the clones finished in', () => {
  // Completion order is a race; a report that reorders itself between runs cannot be diffed.
  const [one, two, three] = clonesFor([1, 2, 3]);
  const done = (ok: boolean, code: number) => ({ ok, code, stdout: '', stderr: '' });
  const results = [
    { clone: three, result: done(true, 0) },
    { clone: one, result: done(false, 3) },
    { clone: two, result: done(true, 0) },
  ] as ExecResult[];
  assert.deepEqual(execSummaryLines(results), [
    `${one?.name ?? ''}  exit 3`,
    `${two?.name ?? ''}  ok`,
    `${three?.name ?? ''}  ok`,
  ]);
});

// ---------------------------------------------------------------------------------------------
// bin/hangar-exec-guard
// ---------------------------------------------------------------------------------------------

/*
 * The guard is tested by RUNNING it, not by re-implementing its matcher here.
 *
 * It is the only thing standing between an agent and every clone in the fleet, and it lives
 * outside `app/` -- so it is not typechecked, not linted, and reached by nothing else in this
 * suite. A second copy of its rules in this file would be a test that passes while the artifact
 * is broken, which is the failure the whole `pnpm golden` convention exists to avoid.
 *
 * Both directions are asserted, and the false-positive half is not padding: a guard that also
 * blocked `docker exec` would be turned off within a day, and then it guards nothing.
 */
const GUARD = fileURLToPath(new URL('../../bin/hangar-exec-guard', import.meta.url));

const guardVerdict = (command: string): 'deny' | 'allow' => {
  const res = spawnSync(GUARD, {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `the guard exited ${String(res.status)}: ${res.stderr}`);
  return res.stdout.includes('"deny"') ? 'deny' : 'allow';
};

test('the guard refuses hangar exec however it is spelled', () => {
  for (const command of [
    'hangar exec --all -- rm -rf .',
    // The case a `Bash(hangar exec:*)` permission rule does NOT match, and the reason the guard
    // is a hook at all: a rule matches the start of the command string.
    'cd /tmp && hangar exec 1 -- ls',
    'echo hi; hangar exec 2 -- ls',
    '/somewhere/bin/hangar exec --all -- ls',
    'bin/hangar exec --serial 1 -- ls',
    // The global option takes a value, which must not be mistaken for the subcommand.
    'hangar --hangar /some/root exec --all -- ls',
    // Straight past the wrapper, at the entry point the wrapper execs.
    'node app/src/cli.ts exec 1 -- ls',
  ]) {
    assert.equal(guardVerdict(command), 'deny', `not refused: ${command}`);
  }
});

test('the guard lets everything else through, `exec` in another tool included', () => {
  for (const command of [
    'docker exec -it web sh',
    'kubectl exec pod -- ls',
    'hangar doctor --all',
    'hangar sync 1',
    // `exec` appears, but as a path rather than a subcommand.
    'cat app/src/commands/exec.ts',
    'git log -- app/src/exec.ts',
    // A hangar command AND an unrelated `exec` in one line: the pairing is what matters.
    'hangar status 1 && docker exec x ls',
  ]) {
    assert.equal(guardVerdict(command), 'allow', `wrongly refused: ${command}`);
  }
});

test('the guard fails OPEN on a payload it cannot read, and ignores other tools', () => {
  /*
   * Deliberately the opposite of the command check. An unparseable payload means Claude Code
   * changed shape, and blocking every Bash call in the fleet over that would be far worse than
   * the thing being guarded -- whereas an unreadable COMMAND inside a well-formed payload is
   * the case where somebody is hiding something.
   */
  for (const input of ['not json', '', '{"tool_name":"Bash","tool_input":{}}']) {
    const res = spawnSync(GUARD, { input, encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '', `it spoke up about: ${input}`);
  }
  const read = spawnSync(GUARD, {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } }),
    encoding: 'utf8',
  });
  assert.equal(read.stdout.trim(), '');
});

test('the refusal says who may run it and what to do instead', () => {
  // A deny an agent cannot act on gets worked around. This one has to name the way forward.
  const res = spawnSync(GUARD, {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'hangar exec --all -- ls' },
    }),
    encoding: 'utf8',
  });
  const reason = (
    JSON.parse(res.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }
  ).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /user/);
  assert.match(reason, /hangar exec/);
});
