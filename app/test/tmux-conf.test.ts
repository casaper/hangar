import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  barOptions,
  paneBorderFormat,
  statusClickBinding,
  TMUX_SETTINGS,
  tmuxConfArtifact,
} from '../src/generate/tmux-conf.ts';
import {
  colourFor,
  PALETTE,
  STATUS_BAR_BG,
  STATUS_BAR_DIM,
  STATUS_BAR_FG,
} from '../src/palette.ts';
import { cloneAt } from '../src/fleet.ts';
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

test('the conf is hangar-level: it names no clone and no clone HUE', () => {
  const hangar = syntheticHangar();
  const { content } = tmuxConfArtifact(hangar);
  // The hue is a SESSION option set by `open`, and the window options are the shell hook's. A
  // clone name or a clone's hue in here would mean per-clone data in a file the whole hangar
  // shares -- whichever clone was opened last would colour every other clone's status bar.
  //
  // The palette's own hexes, not `/#[0-9a-fA-F]{6}/`. That regex was what this asserted while
  // the conf carried no colour at all, and it went red the moment the bar was given its own
  // neutral background -- which is hangar-level and belongs here. Naming what is forbidden
  // guards strictly more than forbidding the shape did: it covers the DERIVED values too, and
  // a shimmer or a border leaking in is the likelier mistake than a raw palette entry.
  for (const entry of PALETTE) {
    const colour = colourFor(1, entry.name);
    for (const [what, value] of [
      ['main', colour.main],
      ['shimmer', colour.shimmer],
      ['border', colour.border],
      ['barText', colour.barText],
      ['mainTriple', colour.mainTriple],
    ] as const) {
      assert.ok(!content.includes(value), `${entry.name}'s ${what} (${value}) is per-clone data`);
    }
  }
  assert.doesNotMatch(content, /wt-00[0-9]/, 'no clone directory belongs in a shared conf');
  assert.ok(content.includes(`@hangar_id ${hangar.id}`), 'the hangar id is the one identity here');
});

test('the bar carries its own background, so no clone hue is ever drawn on tmux green', () => {
  const { content } = tmuxConfArtifact(syntheticHangar());
  // The bug this file exists to prevent a return of. With no `status-style` tmux uses its
  // built-in `bg=green,fg=black`, and every clone hue was then text on saturated green -- the
  // whole palette between 1.00:1 and 2.64:1, the `green` clone at exactly 1.00. Nothing else
  // can set this: it is not per-clone, so neither `open` nor the shell hook owns it, and a
  // server started without it is unconfigured in a way tmux reports as success.
  assert.match(
    content,
    new RegExp(`^set -g status-style '.*bg=${STATUS_BAR_BG}`, 'm'),
    'the bar must name its own background',
  );
  assert.ok(content.includes(`fg=${STATUS_BAR_FG}`), 'and its own text colour, not fg=default');
  assert.ok(content.includes(`fg=${STATUS_BAR_DIM}`), 'and the tone a non-current window takes');
  // Both window styles, because the hook and `open` write over these per window and per
  // session, and `set -uw` on the way out restores exactly what is here. A missing base is a
  // window that falls back to tmux's green rather than to the bar.
  for (const option of ['window-status-style', 'window-status-current-style']) {
    assert.match(content, new RegExp(`^set -g ${option} '`, 'm'), `${option} needs a neutral base`);
  }
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

/**
 * The bar table, and what it may not contain.
 *
 * These are the properties a golden capture cannot state. It pins the rendered conf byte for
 * byte, so it would record a server option sitting in a table of session options -- which reads
 * as correct on a fresh server and can never be applied to a running one -- exactly as happily
 * as it records the right thing.
 */
test('every bar option is rendered into the conf, from the one table', () => {
  const hangar = syntheticHangar();
  const { content } = tmuxConfArtifact(hangar);
  for (const option of barOptions(hangar)) {
    assert.match(
      content,
      new RegExp(`^set -g ${option.name} `, 'm'),
      `${option.name} is in the table and not in the conf`,
    );
  }
});

test('no SERVER option is in the bar table, because a live server could never be given one', () => {
  const names = new Set(barOptions(syntheticHangar()).map((o) => o.name));
  // The table's whole purpose is that `colours sync` can write all of it onto a running server.
  // A server option in there is a setting that reaches the conf and nothing else, with nothing
  // to say which happened -- and the repair for one really is `kill-server`, which `doctor`
  // refuses because it ends every live agent in the fleet.
  for (const setting of TMUX_SETTINGS.filter((s) => s.set.includes('s'))) {
    assert.ok(!names.has(setting.name), `${setting.name} is a server option`);
  }
  // Literal, for the same reason the four are named literally above: walking the table alone
  // would pass one somebody had emptied.
  for (const name of ['extended-keys', 'terminal-features']) assert.ok(!names.has(name));
});

test('every clickable region is ours by prefix, and inside tmux 15-byte limit', () => {
  const hangar = syntheticHangar();
  const right = barOptions(hangar).find((o) => o.name === 'status-right');
  const ranges = [...(right?.value ?? '').matchAll(/#\[range=user\|([^\]]+)\]/g)].map((m) => m[1]);
  assert.ok(ranges.length >= 2, 'the ticket and the pull request are both clickable');
  for (const range of ranges) {
    assert.ok(range !== undefined);
    // `X must be at most 15 bytes in length` -- tmux's own documentation, and a longer one is
    // not reported: the range simply does not fire.
    assert.ok(range.length <= 15, `range name too long: ${range}`);
    // The prefix is what the fall-through condition tests, so a range without it would be dead
    // and a range WITH it that the condition does not expect would swallow a tab click.
    assert.ok(range.startsWith('hangar-'), `${range} is not distinguishable from tmux's own`);
  }
  const binding = statusClickBinding(hangar);
  assert.ok(
    binding.some((word) => word.includes('#{m:hangar-*,#{mouse_status_range}}')),
    'the condition must match exactly the prefix the ranges carry',
  );
});

test('a click that is not on one of ours falls through to what tmux does by default', () => {
  const binding = statusClickBinding(syntheticHangar());
  // Measured on 3.7c: the default for this key is `switch-client -t =`, which is click-a-tab-to-
  // switch. A bare rebinding would take that away from every window in the fleet to add a link,
  // so the else branch restates it -- and this is the assertion that it is still there at all.
  assert.equal(binding.at(-1), 'switch-client -t =');
  assert.equal(binding[4], 'if-shell');
});

test('the footer renders for the active pane only', () => {
  const border = barOptions(syntheticHangar()).find((o) => o.name === 'pane-border-format');
  // A split window draws one border line per pane, and every copy would carry the same answer.
  assert.match(border?.value ?? '', /^#\{\?pane_active,/);
  // No BARE comma may appear inside either arm of a `#{?…}`: it splits on the first one, so a
  // two-part style like `bg=x,fg=y` would cut the format in half and the rest is drawn as text.
  assert.equal((border?.value ?? '').split('#{?pane_active,')[1]?.split(',').length, 2);
});

test('the hue footer escapes the comma its two-part style needs', () => {
  const hangar = syntheticHangar();
  const clone = cloneAt(hangar, 1);
  const hued = paneBorderFormat(hangar, clone.colour);
  // The neutral fallback needs one attribute and the hue version needs three, which is the only
  // reason this format has a comma in it at all. `#,` is how tmux is told the comma is content
  // rather than the separator between the conditional's arms -- and getting it wrong does not
  // error, it silently draws the second half of the style as text on the border.
  assert.ok(hued.includes(`#[bg=${clone.colour.main}#,fg=${clone.colour.ink}#,bold]`));
  // The LAST comma is the separator before the empty else arm and is meant to be bare. Every
  // other one is inside the true arm, so a bare one there would end it early.
  const trueArm = (hued.split('#{?pane_active,')[1] ?? '').replace(/,\}$/, '');
  for (let i = trueArm.indexOf(','); i !== -1; i = trueArm.indexOf(',', i + 1)) {
    assert.equal(trueArm[i - 1], '#', `bare comma at ${String(i)} would end the arm: ${trueArm}`);
  }
});

test('the per-session options reach a live server too, or the table is the only half applied', () => {
  const hangar = syntheticHangar();
  const clone = cloneAt(hangar, 1);
  // `barOptions` is written globally by `restyle`; `paneBorderFormat` is written per session by
  // `paintSession`, from the same pass. The split is what lets one clone's hue onto its own
  // footer without painting every session on the socket -- and the risk it carries is that an
  // option moving from the table to the session takes itself out of the live-apply guarantee
  // with nothing to say so. So both halves are asserted here, not just the table.
  const global = barOptions(hangar).find((o) => o.name === 'pane-border-format');
  assert.ok(global !== undefined, 'the neutral fallback belongs in the table');
  assert.ok(!global.value.includes(clone.colour.main), 'a global must carry no clone hue');
  assert.ok(paneBorderFormat(hangar, clone.colour).includes(clone.colour.main));
});

test('both the jobs and the click name their program by absolute path', () => {
  const hangar = syntheticHangar();
  const values = barOptions(hangar).map((o) => o.value);
  // tmux's `#()` jobs and `run-shell` inherit the SERVER's environment, which is whatever shell
  // started it and need not have direnv's PATH -- the same reason `iterm2.ts` names tmux
  // absolutely. A bare `clone-tmux-status.sh` would silently print nothing for ever.
  for (const field of ['footer', 'ticket', 'pr']) {
    assert.ok(
      values.some((v) => v.includes(`#(${hangar.paths.tmuxStatusScript} ${field} `)),
      `the ${field} job must name the generated script by path`,
    );
  }
  assert.ok(
    statusClickBinding(hangar).some((word) => word.includes(`${hangar.paths.bin} browse `)),
    'the click must name bin/hangar by path',
  );
});
