import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  envLocalContent,
  execGuardHookCommand,
  hasPlansHook,
  plansHookCommand,
  withExecGuardHook,
  withPlansHook,
} from '../src/clone-config.ts';
import { cloneAt } from '../src/fleet.ts';
import { firstShellWord, shellQuote, singleQuoted, tmuxShellWord } from '../src/shell-quote.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * A hangar root with a space or a quote in it, written into generated text and read back.
 *
 * The golden fixtures cannot show this: their roots need no quoting, which is exactly why every
 * helper leaves such a value untouched -- and why a root that DOES need it can break every hook
 * command, bar job and key binding without a capture moving.
 */

const AWKWARD = "/h/My Code/it's here";

test('a value that needs nothing is left exactly as it was', () => {
  for (const value of ['/h/wt-001', 'clone_01', 'a=b:c.d-e']) {
    assert.equal(shellQuote(value), value);
    assert.equal(tmuxShellWord(value), value);
  }
});

test('each quoting survives the shell it is written for, byte for byte', () => {
  const echo = (word: string): string =>
    spawnSync('sh', ['-c', `printf '%s' ${word}`], { encoding: 'utf8' }).stdout;
  assert.equal(echo(shellQuote(AWKWARD)), AWKWARD);
  assert.equal(echo(singleQuoted(AWKWARD)), AWKWARD);
  // tmux hands a job's text to sh after turning `##` back into `#`.
  const viaTmux = tmuxShellWord('/h/a "b" $c `d` #e').replace(/##/g, '#');
  assert.equal(echo(viaTmux), '/h/a "b" $c `d` #e');
});

test('the first word of a command is read back unquoted', () => {
  assert.equal(firstShellWord('/h/bin/hangar --hangar /h plans'), '/h/bin/hangar');
  assert.equal(firstShellWord(`${shellQuote(AWKWARD)} --x`), AWKWARD);
  assert.equal(firstShellWord('  /a/b'), '/a/b');
});

test('a root with a space still has its hooks recognised, replaced and never duplicated', () => {
  const hangar = syntheticHangar({ root: AWKWARD });
  const command = plansHookCommand(hangar);
  assert.ok(command.startsWith(`'${AWKWARD.replace(/'/g, `'\\''`)}/bin/hangar' --hangar `));

  const once = withPlansHook(hangar, {});
  const twice = withPlansHook(hangar, once);
  assert.equal(hasPlansHook(hangar, twice), true);
  assert.equal((twice.hooks?.['SessionEnd'] ?? []).length, 1, 'a second writer pass duplicated it');

  const guarded = withExecGuardHook(hangar, withExecGuardHook(hangar, {}));
  const guards = (guarded.hooks?.['PreToolUse'] ?? []).flatMap((m) => m.hooks);
  assert.deepEqual(
    guards.map((h) => h.command),
    [execGuardHookCommand(hangar)],
  );
});

test('the dotenv root line carries a quote in the path', () => {
  const clone = cloneAt(syntheticHangar({ root: AWKWARD }), 1);
  const line = envLocalContent(clone)
    .split('\n')
    .find((l) => l.startsWith('FIXTURE_REPO_ROOT='));
  assert.ok(line !== undefined);
  assert.ok(line.includes('"'), `a path with a quote must not be single-quoted: ${line}`);
});
