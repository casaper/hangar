import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultSettings } from '../src/clone-config.ts';
import { cloneAt } from '../src/fleet.ts';
import { findingsIn, leakPatterns, scrubLines, type Finding } from '../src/commands/scrub.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * `hangar scrub`, which reports the fleet in text a clone session wrote for somebody else.
 *
 * Everything here is a property rather than a snapshot: what the report LOOKS like is golden's
 * business, and what matters about this command is which lines it picks and which it leaves
 * alone. Every case below was measured against this fleet's own `tmp/` before it was written
 * down -- the first calibration run reported 61,538 findings in 919 files, and each assertion in
 * the two "must stay quiet" tests is one of the shapes that got it back down to a report a person
 * can read.
 */

const fleet = () => {
  const hangar = syntheticHangar();
  return { hangar, clones: [1, 2, 3].map((index) => cloneAt(hangar, index)) };
};

const hits = (line: string): Finding[] => {
  const { hangar, clones } = fleet();
  return findingsIn(line, leakPatterns(hangar, clones), 'a.md');
};

const kinds = (line: string): string[] =>
  hits(line)
    .map((f) => f.kind)
    .sort();

test('every pattern is derived from the hangar, never this repo', () => {
  /*
   * The whole reason `leakPatterns` takes a hangar. A literal `clone_` or `4300` in the source
   * would be one fleet's answer shipped as everybody's -- and it would still pass a test written
   * against the fleet it came from, which is why this asserts against a hangar whose prefix and
   * ports agree with neither this repo nor the schema defaults.
   */
  const { hangar, clones } = fleet();
  const patterns = leakPatterns(hangar, clones);
  const source = patterns.map((p) => p.pattern.source).join('\n');
  for (const foreign of ['clone_', '4300', '4200', 'dvb']) {
    assert.ok(!source.includes(foreign), `the patterns hardcode "${foreign}"`);
  }
  assert.ok(source.includes('wt-'), 'the configured clone prefix never reached a pattern');
});

test('a clone directory, a fleet path and the CLI are each named', () => {
  assert.deepEqual(kinds('see wt-002 for the fix'), ['clone name']);
  assert.deepEqual(kinds('run `hangar list` first'), ['hangar']);
  // The prefix is matched case-insensitively, since prose capitalises at a sentence start.
  assert.deepEqual(kinds('WT-003 has it too'), ['clone name']);
});

test('a port is a leak only when the FLEET derived it, and only in a port context', () => {
  /*
   * Two independent narrowings, and both were forced by a real false positive rather than
   * imagined. `base` is the project's own documented default and is correct in any document.
   * And four digits are also a forum topic id: measured, a link ending `/lang-sql/4300` was
   * reported as a leaked dev-server port while `localhost:4700` two files away was a real one.
   * Nothing about the number separates them, so the words around it have to.
   */
  const { hangar } = fleet();
  const bases = hangar.config.ports.roles.map((role) => role.base);
  const firstBase = bases[0] ?? 0;
  for (const base of bases) {
    assert.deepEqual(kinds(`the app serves on port ${String(base)}`), [], `base ${String(base)}`);
  }

  // Clone 2 of a fixture whose offset is 37: base + 37 + (2 - 1) * 100.
  const derived = String(firstBase + 37 + 100);
  assert.deepEqual(kinds(`open http://localhost:${derived}/`), ['fleet port']);
  assert.deepEqual(kinds(`the dev server port is ${derived}`), ['fleet port']);
  // Same number, no port context anywhere on the line: a topic id, an identifier, a year.
  assert.deepEqual(kinds(`see https://forum.example/t/some-thread/${derived}`), []);
});

test('fleet vocabulary is caught and ordinary English is not', () => {
  for (const line of [
    "loads this clone's own node_modules",
    'cd <clone>',
    'every clone gets one',
    'no sibling clone touches it',
    'the fleet runs on macOS',
  ]) {
    assert.deepEqual(kinds(line), ['fleet phrase'], `missed: ${line}`);
  }

  /*
   * The two words left out on purpose, each measured against this fleet's real store. `clone` is
   * an ordinary word in any repository and `sibling` is ordinary prose in any codebase -- it
   * matched "the sibling tools" and "sibling element" and never once matched a real leak. A
   * check that fires on these is a check nobody leaves switched on.
   */
  for (const line of [
    'clone the repo and run the install',
    'the sibling element is focused first',
    'it clones the object before mutating it',
    'a sibling branch already fixes this',
  ]) {
    assert.deepEqual(kinds(line), [], `false positive: ${line}`);
  }
});

test('one finding per line per kind, so a repeated word is not a list', () => {
  const found = hits('wt-001 and wt-002 and wt-003 all differ');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.line, 1);
});

test('a line can carry more than one kind, and says which', () => {
  const { hangar } = fleet();
  const derived = String((hangar.config.ports.roles[0]?.base ?? 0) + 37 + 100);
  assert.deepEqual(kinds(`this clone serves on port ${derived}`), ['fleet phrase', 'fleet port']);
  for (const finding of hits(`this clone serves on port ${derived}`)) {
    assert.ok(finding.why.length > 0, 'a finding with no reason is a finding nobody acts on');
  }
});

test('no findings means no report at all, which is what keeps the hook silent', () => {
  // The `SessionEnd` hook runs in every clone at the end of every session. An empty report is
  // the difference between a backstop and a thing people turn off.
  assert.deepEqual(scrubLines([], 120), []);
  assert.ok(scrubLines(hits('cd <clone>'), 1).length > 0);
});

test('past a screenful the report collapses to files and counts', () => {
  /*
   * A report nobody scrolls to the end of has the value of no report, and this one runs
   * unattended from a hook where nothing scrolls at all. The first live run found 454 lines
   * across 89 files -- all real, all written before the rule existed.
   */
  const many: Finding[] = Array.from({ length: 60 }, (_, i) => ({
    file: `tmp/f${String(i % 3)}.md`,
    line: i,
    kind: 'fleet phrase' as const,
    match: 'this clone',
    text: 'x',
    why: 'y',
  }));
  const lines = scrubLines(many, 100).join('\n');
  assert.match(lines, /Too many to list/);
  assert.ok(!lines.includes('this clone'), 'the collapsed report still printed every match');

  const few = scrubLines(many.slice(0, 3), 100).join('\n');
  assert.ok(!few.includes('Too many to list'));
  assert.match(few, /this clone/);
});

test('the scrub hook is wired into a clone exactly once', () => {
  const hangar = syntheticHangar();
  const settings = defaultSettings(cloneAt(hangar, 1));
  const ends = (settings.hooks?.['SessionEnd'] ?? []).flatMap((m) => m.hooks.map((h) => h.command));
  const ours = ends.filter((c) => / scrub\b/.test(c));
  assert.equal(ours.length, 1, 'exactly one scrub hook per clone');
  // Bounded, or it reports the same backlog at the end of every session for ever.
  assert.match(ours[0] ?? '', /--recent/);
  assert.match(ours[0] ?? '', /--quiet/);
});
