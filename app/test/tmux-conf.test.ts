import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TMUX_SETTINGS, tmuxConfArtifact } from '../src/generate/tmux-conf.ts';
import { namesNoMachinePath, syntheticHangar } from './fixture.ts';

/**
 * The tmux config this hangar's own server starts under.
 *
 * Properties, not bytes -- `dev/golden/gated/*` pins the bytes of both fixtures' renders, and a
 * second copy of the expected text here would be one more thing to hand-update on every prose
 * edit. What is asserted instead is what a capture structurally cannot say: that all four of the
 * settings Claude Code documents are PRESENT (a dropped one is silent -- Shift+Enter simply stops
 * inserting a newline, in a terminal nobody suspects), and that nothing per-clone leaked into a
 * file the whole hangar shares.
 */

test('every Claude Code setting is rendered with its own flags and value', () => {
  const { content } = tmuxConfArtifact(syntheticHangar());
  for (const setting of TMUX_SETTINGS) {
    assert.match(
      content,
      new RegExp(`^set ${setting.set}\\s+${setting.name}\\s`, 'm'),
      `${setting.name} must be set with ${setting.set} -- the flags ARE the scope`,
    );
    assert.ok(content.includes(setting.value), `${setting.name} must carry ${setting.value}`);
  }
});

test('all four settings tmux needs for Claude Code are named, by name', () => {
  const { content } = tmuxConfArtifact(syntheticHangar());
  // Literal names on purpose. `TMUX_SETTINGS` is the table both the conf and `doctor` read, so a
  // test that only walks it would pass a table somebody had deleted an entry from.
  for (const name of ['extended-keys', 'terminal-features', 'allow-passthrough', 'mouse']) {
    assert.ok(content.includes(name), `${name} is one of the four; a missing one fails silently`);
  }
});

test('terminal-features is the appended one, so it is compared as a substring', () => {
  const appended = TMUX_SETTINGS.filter((s) => s.set.includes('a'));
  assert.deepEqual(
    appended.map((s) => s.name),
    ['terminal-features'],
  );
  // The pairing is the assertion, not the string: `-a` appends, so the live value is a superset
  // and an equality check would report a correctly configured server as wrong.
  for (const setting of appended) assert.equal(setting.match, 'contains');
  for (const setting of TMUX_SETTINGS.filter((s) => !s.set.includes('a'))) {
    assert.equal(setting.match, 'exact');
  }
});

test('the conf is hangar-level: it names no clone and no colour', () => {
  const hangar = syntheticHangar();
  const { content } = tmuxConfArtifact(hangar);
  // The hue is a SESSION option set by `open`, and the window options are the shell hook's. A
  // clone name or a `#rrggbb` in here would mean per-clone data in a file the whole hangar
  // shares -- whichever clone was opened last would colour every other clone's status bar.
  assert.doesNotMatch(content, /#[0-9a-fA-F]{6}/, 'no literal hue belongs in a shared conf');
  assert.doesNotMatch(content, /wt-00[0-9]/, 'no clone directory belongs in a shared conf');
  assert.ok(content.includes(`@hangar_id ${hangar.id}`), 'the hangar id is the one identity here');
});

test('the conf lands at the hangar root and names no machine path', () => {
  const hangar = syntheticHangar();
  const artifact = tmuxConfArtifact(hangar);
  assert.equal(artifact.path, `${hangar.root}/clone-tmux.conf`);
  assert.ok(namesNoMachinePath(artifact.content));
});

test('each hangar writes its own conf, at its own root', () => {
  const a = tmuxConfArtifact(syntheticHangar({ root: '/wt-a' }));
  const b = tmuxConfArtifact(syntheticHangar({ root: '/wt-b' }));
  // Two hangars with two roots write two files. The SOCKET is derived from the id rather than
  // the root, which is deliberate -- two checkouts of one hangar id are one fleet and share a
  // server -- so what has to differ here is the destination, and `dev.ts` captures it.
  assert.notEqual(a.path, b.path);
  assert.ok(a.content.startsWith('# GENERATED'), 'the generated header comes first, as a warning');
});
