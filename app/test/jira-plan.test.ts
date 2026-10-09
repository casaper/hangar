import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  judgeClone,
  lastActivityMs,
  pickFreeClone,
  planPromptFor,
  STALE_AFTER_MS,
  ticketKeyProblem,
  weekdayMsBetween,
  type CloneFacts,
} from '../src/commands/jira-plan.ts';
import { claudeWithPrompt } from '../src/commands/open.ts';
import { cloneAt } from '../src/fleet.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * `hangar jira-plan`, through its pure judge.
 *
 * Which clone is free is the decision that can end somebody's session or strand their work, and
 * none of it is visible to a golden capture -- it reads live git, tmux and process state. So the
 * rules are a pure function of facts, and this file pins them: the refusals that win over every
 * reason to be free, the order free clones are taken in, and the weekend-blind clock.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// 2026-10-09 is a Friday; local time, as the rule is.
const at = (day: number, hour = 0, minute = 0): number =>
  new Date(2026, 9, day, hour, minute).getTime();

test('the clock cuts out Saturday 00:00 to Sunday 24:00 and nothing else', () => {
  assert.equal(weekdayMsBetween(at(9, 17), at(14, 17)), 3 * DAY, 'Fri 17:00 to Wed 17:00');
  assert.equal(weekdayMsBetween(at(10), at(11, 23, 59)), 0, 'the weekend itself');
  // No office hours: a weekday night counts in full.
  assert.equal(weekdayMsBetween(at(12, 9), at(15, 9)), 3 * DAY, 'Mon 09:00 to Thu 09:00');
  assert.equal(
    weekdayMsBetween(at(10, 12), at(12, 6)),
    6 * HOUR,
    'a Saturday touch counts from Monday',
  );
  assert.equal(weekdayMsBetween(at(14), at(9)), 0, 'a backwards span is empty');
});

test('a reflog entry hangar wrote is not a touch; a person’s, or a transcript, is', () => {
  const reflog = [
    { atMs: at(14), subject: 'hangar (finish): returning to refs/heads/x' },
    { atMs: at(13), subject: 'hangar: Fast-forward' },
    { atMs: at(12), subject: 'hangar' },
    { atMs: at(5), subject: 'commit: the last real one' },
  ];
  assert.equal(lastActivityMs(reflog, undefined), at(5));
  assert.equal(lastActivityMs(reflog, at(8)), at(8));
  assert.equal(lastActivityMs([], undefined), undefined);
  // A subject that merely BEGINS with the word is somebody's own.
  assert.equal(lastActivityMs([{ atMs: at(7), subject: 'hangarside: x' }], undefined), at(7));
});

const hangar = syntheticHangar();
const NOW = at(14, 12);

const facts = (over: Partial<CloneFacts> = {}): CloneFacts => ({
  clone: cloneAt(hangar, 1),
  branch: 'main',
  defaultBranch: 'main',
  dirty: 0,
  untracked: 0,
  pending: undefined,
  unpushed: 0,
  prState: undefined,
  lastActivityMs: NOW - HOUR,
  liveClaude: 0,
  claudeReachable: false,
  claudeWindowBusy: false,
  armed: undefined,
  isHere: false,
  ...over,
});

const onBranch = { branch: 'feature/ABC-1_x' };

test('every refusal wins over every reason to be free', () => {
  const refusals: Partial<CloneFacts>[] = [
    { isHere: true },
    { pending: 'rebase' },
    { dirty: 1 },
    // The planning skill asks before branching off a tree with ANY line in `git status --short`.
    { untracked: 1 },
    { unpushed: 2 },
    { liveClaude: 1, claudeReachable: false },
    { armed: { ticket: 'ABC-9', atMs: NOW - HOUR } },
  ];
  for (const refusal of refusals) {
    for (const reasonToBeFree of [
      {},
      { ...onBranch, prState: 'merged' as const },
      { ...onBranch, lastActivityMs: NOW - 30 * DAY },
    ]) {
      const verdict = judgeClone(facts({ ...reasonToBeFree, ...refusal }), NOW);
      assert.equal(verdict.free, false, `${JSON.stringify(refusal)} was taken anyway`);
    }
  }
});

test('the three ways to be free, and the one way to be busy', () => {
  const kind = (over: Partial<CloneFacts>): string => {
    const v = judgeClone(facts(over), NOW);
    return v.free ? v.kind : 'busy';
  };
  assert.equal(kind({}), 'default-branch');
  assert.equal(kind({ ...onBranch, prState: 'merged' }), 'merged');
  assert.equal(kind({ ...onBranch, lastActivityMs: NOW - 5 * DAY }), 'stale');
  assert.equal(kind({ ...onBranch, lastActivityMs: undefined }), 'stale');
  assert.equal(kind({ ...onBranch, prState: 'open' }), 'busy');
  // Wed 12:00 back to Fri 12:00 is five calendar days but three weekdays: exactly stale.
  assert.equal(kind({ ...onBranch, lastActivityMs: at(9, 12) }), 'stale');
  assert.equal(kind({ ...onBranch, lastActivityMs: at(9, 13) }), 'busy');
});

test('a gate armed long enough ago counts as abandoned', () => {
  const stale = NOW - 10 * DAY;
  assert.ok(weekdayMsBetween(stale, NOW) >= STALE_AFTER_MS);
  assert.equal(judgeClone(facts({ armed: { ticket: 'ABC-9', atMs: stale } }), NOW).free, true);
});

test('an idle Claude Code window is taken before any session is ended', () => {
  const verdicts = [
    judgeClone(
      facts({
        clone: cloneAt(hangar, 1),
        claudeWindowBusy: true,
        liveClaude: 1,
        claudeReachable: true,
      }),
      NOW,
    ),
    judgeClone(facts({ clone: cloneAt(hangar, 2), ...onBranch, lastActivityMs: undefined }), NOW),
  ];
  // Clone 1 is on the default branch, the better kind -- but taking it ends a session.
  assert.equal(pickFreeClone(verdicts)?.clone.index, 2);
});

test('among equals: default branch, then merged, then stale, then the lowest index', () => {
  const verdicts = [
    judgeClone(facts({ clone: cloneAt(hangar, 1), ...onBranch, lastActivityMs: undefined }), NOW),
    judgeClone(facts({ clone: cloneAt(hangar, 2), ...onBranch, prState: 'merged' }), NOW),
    judgeClone(facts({ clone: cloneAt(hangar, 4) }), NOW),
    judgeClone(facts({ clone: cloneAt(hangar, 3) }), NOW),
  ];
  assert.equal(pickFreeClone(verdicts)?.clone.index, 3);
  assert.equal(pickFreeClone(verdicts.slice(0, 2))?.clone.index, 2);
});

test('nothing free is no pick, and every clone still has a reason', () => {
  const verdicts = [1, 2].map((i) =>
    judgeClone(facts({ clone: cloneAt(hangar, i), dirty: 3 }), NOW),
  );
  assert.equal(pickFreeClone(verdicts), undefined);
  for (const v of verdicts) assert.ok(v.reason.length > 0);
});

test('the key is checked against keyPrefixes, and only its shape without them', () => {
  assert.equal(ticketKeyProblem('ABC-12', ['ABC']), undefined);
  assert.notEqual(ticketKeyProblem('XYZ-12', ['ABC']), undefined);
  assert.equal(ticketKeyProblem('XYZ-12', undefined), undefined);
  for (const bad of ['abc-12', 'ABC12', 'ABC-', 'ABC-1; rm -rf ~', ''])
    assert.notEqual(ticketKeyProblem(bad, undefined), undefined, `${bad} was accepted`);
});

test('the prompt reaches the shell as ONE argument, key in place', () => {
  const prompt = planPromptFor('/plan-ticket {key} please', 'ABC-7');
  assert.equal(prompt, '/plan-ticket ABC-7 please');
  assert.equal(claudeWithPrompt('claude', prompt), "claude '/plan-ticket ABC-7 please'");
  assert.equal(claudeWithPrompt('claude', "it's"), `claude 'it'\\''s'`);
});
