import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  floorCutoff,
  newerMajor,
  parseVersion,
  pickInLine,
  releasesFrom,
  renderSurvey,
  sameMajor,
  satisfies,
  type Row,
  type Survey,
} from '../dev/deps-survey.ts';

/**
 * `pnpm deps:survey`, through its pure half.
 *
 * Each case is a way a hand-run sweep answered wrongly while looking right: a backport picked by
 * date, a release one minute inside the floor taken, `latest` steering `@types/node` off the
 * runtime major, a peer cap read as no cap. Properties only -- the report's wording is free to
 * change.
 */

const FLOOR = 14 * 1440;
const NOW = new Date('2026-10-29T10:00:00Z');
const CUTOFF = floorCutoff(NOW, FLOOR);
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const v = (text: string) => {
  const parsed = parseVersion(text);
  assert.ok(parsed, text);
  return parsed;
};

test('the floor cutoff is the configured minutes before now', () => {
  assert.equal(CUTOFF.toISOString(), '2026-10-15T10:00:00.000Z');
});

test('a backport published after the current major is never the pick', () => {
  const releases = releasesFrom({
    created: daysAgo(400),
    '10.0.1': daysAgo(60),
    '10.1.0': daysAgo(30),
    '9.39.9': daysAgo(20), // newer by date, older by major
  });
  const pick = pickInLine(releases, '10.0.1', CUTOFF, sameMajor(10));
  assert.equal(pick.take?.version, '10.1.0');
});

test('a release one minute inside the floor waits, and names when it clears', () => {
  const inside = new Date(CUTOFF.getTime() + 60_000).toISOString();
  const releases = releasesFrom({ '18.0.7': daysAgo(30), '18.0.8': daysAgo(15), '18.0.9': inside });
  const pick = pickInLine(releases, '18.0.7', CUTOFF, sameMajor(18));
  assert.equal(pick.take?.version, '18.0.8');
  assert.equal(pick.waits?.version, '18.0.9');
  assert.ok(pick.waits.published > CUTOFF);
});

test('the next release to wait is the lowest one, not the newest', () => {
  const releases = releasesFrom({
    '12.13.0': daysAgo(20),
    '12.14.0': daysAgo(13),
    '12.16.1': daysAgo(2),
  });
  assert.equal(pickInLine(releases, '12.13.0', CUTOFF, sameMajor(12)).waits?.version, '12.14.0');
});

test('prereleases are never picked', () => {
  const releases = releasesFrom({ '6.0.3': daysAgo(60), '6.1.0-rc.1': daysAgo(30) });
  const pick = pickInLine(releases, '6.0.3', CUTOFF, () => true);
  assert.equal(pick.take, null);
  assert.equal(pick.waits, null);
});

test('@types/node stays on the .nvmrc major even when latest is a newer one', () => {
  const releases = releasesFrom({
    '24.19.1': daysAgo(30),
    '24.19.2': daysAgo(20),
    '26.6.5': daysAgo(20),
  });
  const pick = pickInLine(releases, '24.19.1', CUTOFF, sameMajor(24));
  assert.equal(pick.take?.version, '24.19.2');
  assert.equal(newerMajor(releases, '24.19.1', CUTOFF)?.version, '26.6.5');
});

test('a peer range caps the line: <6.1.0 admits 6.0.x and refuses 6.1 and 7', () => {
  const peer = '>=4.8.4 <6.1.0';
  assert.ok(satisfies(v('6.0.9'), peer));
  assert.ok(!satisfies(v('6.1.0'), peer));
  assert.ok(!satisfies(v('7.0.2'), peer));
  const releases = releasesFrom({
    '6.0.3': daysAgo(90),
    '6.1.0': daysAgo(60),
    '7.0.2': daysAgo(30),
  });
  const pick = pickInLine(releases, '6.0.3', CUTOFF, (x) => satisfies(x, peer));
  assert.equal(pick.take, null);
});

test('a peer range that admits the next major reads as admitting it', () => {
  assert.ok(satisfies(v('7.0.2'), '>=4.8.4 <7.1.0'));
  assert.ok(satisfies(v('7.0.2'), '^6.0.0 || ^7.0.0'));
  assert.ok(satisfies(v('7.0.2'), '>= 5 < 8'));
});

test('a writer caret pins its major', () => {
  assert.ok(satisfies(v('8.4.0'), '^8.0.0'));
  assert.ok(!satisfies(v('9.0.0'), '^8.0.0'));
  assert.ok(satisfies(v('9.0.0'), '^8.0.0 || ^9.0.0'));
});

const row = (over: Partial<Row>): Row => ({
  name: 'pkg',
  dev: false,
  range: '1.0.0',
  installed: '1.0.0',
  pick: { take: null, waits: null },
  major: null,
  ...over,
});

const survey = (over: Partial<Survey>): Survey => ({
  now: NOW,
  floorMinutes: FLOOR,
  rows: [],
  audit: [],
  ...over,
});

test('an unreadable audit is reported as unreadable, never as clean', () => {
  const text = renderSurvey(survey({ auditError: 'ERR_PNPM_AUDIT_BAD_RESPONSE' }));
  assert.match(text, /could not be read/);
  assert.doesNotMatch(text, /no advisories/);
});

test('a held package is never offered as TAKE, and an unblocked hold says to ask', () => {
  const held = row({
    name: 'typescript',
    pick: { take: { version: '7.0.2', published: new Date(daysAgo(30)) }, waits: null },
    hold: { unblockedWhen: 'x', unblocked: true, evidence: 'y' },
  });
  const text = renderSurvey(survey({ rows: [held] }));
  assert.doesNotMatch(text, /^TAKE/m);
  assert.match(text, /UNBLOCKED/);
});

test('a caret range is flagged for restoring after pnpm add rewrites it exact', () => {
  const caret = row({
    name: 'dotenv',
    range: '^18.0.7',
    installed: '18.0.7',
    pick: { take: { version: '18.0.8', published: new Date(daysAgo(15)) }, waits: null },
  });
  assert.match(renderSurvey(survey({ rows: [caret] })), /dotenv 18\.0\.7 -> 18\.0\.8 .*caret/);
});
