import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attachHint,
  attachCommand,
  tmuxArgv,
  tmuxSessionName,
  tmuxSocketName,
  tmuxTarget,
  tmuxWindowName,
} from '../src/tmux.ts';
import { cloneAt } from '../src/fleet.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * The names and the argv, which is the whole part of the tmux layer a test can reach.
 *
 * Everything below is a rule tmux enforces silently. A session name that cannot be addressed is
 * accepted at creation and only fails later; `-f` after the subcommand loads no config and says
 * nothing; a target without `=` matches a PREFIX and writes options onto another clone. None of
 * those produce an error to notice, which is exactly why they are asserted here rather than left
 * to a live run to discover.
 */

const hangar = (root = '/wt'): ReturnType<typeof syntheticHangar> => syntheticHangar({ root });

test('the socket carries the hangar id, so two hangars are two servers', () => {
  assert.equal(tmuxSocketName('dvb'), 'hangar-dvb');
  assert.notEqual(tmuxSocketName('a'), tmuxSocketName('b'));
  // The one identity that has to be in the name: the socket is addressable from anywhere on the
  // machine, so it is subject to the fleet's rule about what carries the id.
  assert.ok(tmuxSocketName('zz').includes('zz'));
});

test('a session name is addressable: no dot and no colon, whatever the clone is called', () => {
  const clone = { ...cloneAt(hangar(), 1), name: 'we.ird:name' };
  const name = tmuxSessionName(clone);
  // Both are tmux target separators, so a name containing either is created happily and can
  // never be targeted afterwards. Measured on 3.7c: `new-session -s 'a.b'` succeeds.
  assert.ok(!name.includes('.'), `a dot survived: ${name}`);
  assert.ok(!name.includes(':'), `a colon survived: ${name}`);
  assert.equal(tmuxSessionName({ ...clone, name }), name, 'sanitising must be idempotent');
});

test('a legal clone name is left exactly as it is', () => {
  const clone = cloneAt(hangar(), 1);
  assert.equal(tmuxSessionName(clone), clone.name);
});

test('distinct clones get distinct session names', () => {
  const h = hangar();
  const names = [1, 2, 3].map((i) => tmuxSessionName(cloneAt(h, i)));
  assert.equal(
    new Set(names).size,
    names.length,
    'two clones sharing a session would share windows',
  );
});

test('a session target is exact AND colon-terminated', () => {
  const target = tmuxTarget(cloneAt(hangar(), 1));
  // `=` because a bare name falls through to a PREFIX match, and the colon because `set-option`
  // and `new-window` take a target-pane, where the session part is only recognised before one.
  assert.ok(target.startsWith('='), `a prefix match would reach another clone: ${target}`);
  assert.ok(target.endsWith(':'), `set-option rejects '=name' without the colon: ${target}`);
});

test("a window name is the role alone -- the clone is the badge's job, not every tab's", () => {
  const clone = cloneAt(hangar(), 2);
  const name = tmuxWindowName(clone, 'claude');
  assert.equal(name, 'claude');
  // The decision, not the spelling: the clone is named by the hue badge in `status-left` and by
  // `set-titles-string`, so a third naming here would put it in every tab beside a badge that
  // already says it.
  assert.ok(!name.includes(clone.name), `the bar would say ${clone.name} in every tab`);
});

test('-L and -f both come BEFORE the subcommand', () => {
  const h = hangar();
  const argv = tmuxArgv(h, ['new-session', '-d'], { withConf: true });
  const subcommand = argv.indexOf('new-session');
  assert.ok(subcommand > 0, 'the subcommand must not be first');
  for (const flag of ['-L', '-f']) {
    const at = argv.indexOf(flag);
    assert.ok(at >= 0, `${flag} is missing`);
    assert.ok(at < subcommand, `${flag} after the subcommand is a different flag entirely`);
  }
});

test('the conf rides only where a server can be started', () => {
  const h = hangar();
  // A read cannot start a server, so it must not carry `-f`: `doctor` has to be able to report a
  // conf that is missing, and `tmux -f <missing>` exits 0 without a word.
  assert.ok(!tmuxArgv(h, ['has-session', '-t', 'x']).includes('-f'));
  assert.ok(!tmuxArgv(h, ['list-sessions']).includes('-f'));
  const argv = tmuxArgv(h, ['new-session'], { withConf: true });
  assert.deepEqual(argv.slice(0, 2), ['-f', h.paths.tmuxConf]);
});

test('the socket in the argv is this hangar’s, and the conf is under its root', () => {
  const h = hangar('/wt-one');
  const argv = tmuxArgv(h, ['new-session'], { withConf: true });
  assert.ok(argv.includes(tmuxSocketName(h.id)));
  assert.ok(argv[1]?.startsWith(h.root), 'the conf belongs to the hangar it configures');
});

test('the attach command names tmux by absolute path, and runs no shell', () => {
  const line = attachCommand(hangar(), cloneAt(hangar(), 1));
  // iTerm2 starts this process directly rather than through a shell, so PATH is the
  // application's -- measured: a bare `tmux` was not found, the tab opened empty, and nothing
  // said so. An absolute path also settles the shell-alias question: there is no shell.
  assert.match(line, /^\/usr\/bin\/env /, line);
  assert.ok(!line.startsWith('exec '), 'there is no shell to run a builtin in');
  assert.doesNotMatch(line, /(^|\s)tmux(\s|$)/, `tmux must be an absolute path: ${line}`);
  assert.match(line, /\/tmux\s/, line);
});

test('the attach command unsets $TMUX, or new-session refuses to nest on Linux', () => {
  const line = attachCommand(hangar(), cloneAt(hangar(), 1));
  assert.ok(line.includes('-u TMUX '), line);
  assert.ok(line.includes('-u TMUX_PANE'), line);
});

test('the attach command creates or attaches with one spelling', () => {
  const line = attachCommand(hangar(), cloneAt(hangar(), 1));
  // `-A` so a first open and a reattach are the same string. `open` builds the session first and
  // then waits for the client, so the create branch is only reachable if the server died between
  // the two -- and it is what stops a closed tab from needing a different command.
  assert.ok(line.includes('new-session'), line);
  assert.ok(line.includes('-A'), line);
  const clone = cloneAt(hangar(), 1);
  assert.ok(line.includes(`-s ${tmuxSessionName(clone)}`), line);
  // No quoting at all in the common case, which is what keeps the string safe to hand to an
  // emulator that tokenizes it itself rather than running it through a shell.
  assert.doesNotMatch(line, /'/, line);
});

test('the hint a developer types by hand names the socket, since a bare tmux ls cannot see it', () => {
  const h = hangar();
  const hint = attachHint(h, cloneAt(h, 3));
  assert.ok(hint.includes(`-L ${tmuxSocketName(h.id)}`), hint);
  assert.ok(hint.includes(tmuxTarget(cloneAt(h, 3))), hint);
});

test('neither hangar’s argv names the other', () => {
  const a = hangar('/wt-a');
  const b = syntheticHangar({ root: '/wt-b' });
  const argvA = tmuxArgv(a, ['new-session'], { withConf: true }).join(' ');
  // Same fixture, so the same id and therefore the same socket by design -- what must not cross
  // over is the PATH, which is the half derived from the root.
  assert.ok(!argvA.includes(b.root));
});
