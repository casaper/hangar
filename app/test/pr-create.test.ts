import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { bareUuid } from '../src/bitbucket.ts';
import {
  bodyDecision,
  prCloneChoice,
  prCreateBlock,
  readBackDisagreements,
} from '../src/commands/pr.ts';
import {
  descriptionNameRe,
  descriptionState,
  descriptionsIn,
  isConflictCopy,
  pickDescription,
  splitDescription,
  KEYLESS_NAME_RE,
} from '../src/pr-description.ts';

/**
 * Opening and rewriting a pull request, and the decisions behind them.
 *
 * **Every assertion here is about a case the golden capture structurally cannot reach.** These
 * two commands talk to a network and write to a forge, so nothing about them is captured -- and
 * the interesting halves are the refusals: a branch that is not pushed, a description written
 * before the last commit, a clone naming another clone, and an API answer that disagrees with the
 * request. Each one is a pure function precisely so it can be asserted without a token.
 */

test('a forge write acts on the clone you are standing in, and refuses to reach into another', () => {
  // In a clone, the argument is optional and may only agree.
  assert.deepEqual(prCloneChoice(3, undefined), { kind: 'ok', index: 3 });
  assert.deepEqual(prCloneChoice(3, 3), { kind: 'ok', index: 3 });
  /*
   * The case this exists for. A pull request opened for the branch next door is visible to the
   * whole team before anybody notices, and the fleet's rule is already that a session works in
   * the clone it is in -- so this is a refusal, not an override.
   */
  assert.deepEqual(prCloneChoice(3, 4), { kind: 'elsewhere', here: 3, asked: 4 });
  // At the hangar root there is nothing to infer from, so the argument becomes required.
  assert.deepEqual(prCloneChoice(undefined, undefined), { kind: 'which' });
  assert.deepEqual(prCloneChoice(undefined, 4), { kind: 'ok', index: 4 });
});

test('create is blocked by the forge, the branch and origin, in that order', () => {
  const base = {
    bitbucket: true,
    branch: 'features/ABC-1323_x',
    defaultBranch: 'master',
    onOrigin: true,
    ahead: 0,
  };
  assert.equal(prCreateBlock(base), undefined, 'a pushed feature branch has nothing in its way');

  assert.deepEqual(prCreateBlock({ ...base, bitbucket: false }), { kind: 'no-forge' });
  assert.deepEqual(prCreateBlock({ ...base, branch: '(detached HEAD)' }), { kind: 'detached' });
  assert.deepEqual(prCreateBlock({ ...base, branch: 'master' }), {
    kind: 'default-branch',
    branch: 'master',
  });
  assert.deepEqual(prCreateBlock({ ...base, onOrigin: false }), {
    kind: 'not-on-origin',
    branch: base.branch,
  });
  /*
   * The one that would otherwise succeed and be wrong: origin HAS the branch, so the pull request
   * opens and reads as complete -- while missing exactly the commits the description describes.
   */
  assert.deepEqual(prCreateBlock({ ...base, ahead: 3 }), {
    kind: 'unpushed',
    branch: base.branch,
    ahead: 3,
  });

  // A hangar whose default branch has never been resolved must not have every branch treated as
  // the default one; the check is skipped rather than guessed at.
  assert.equal(prCreateBlock({ ...base, defaultBranch: undefined }), undefined);
  // Order matters: no forge outranks everything, because none of the rest can be asked about.
  assert.deepEqual(prCreateBlock({ ...base, bitbucket: false, onOrigin: false }), {
    kind: 'no-forge',
  });
});

test('the first `# ` heading is the title and the rest is the body', () => {
  const split = splitDescription(
    '# ABC-1323: Close the tab\n\nWhy it exists.\n\n## What changed\n',
  );
  assert.equal(split.title, 'ABC-1323: Close the tab');
  assert.equal(split.body, 'Why it exists.\n\n## What changed');

  // A leading blank line, and prose before the heading, both still find it.
  assert.equal(splitDescription('\n\n#   Spaced out\nbody').title, 'Spaced out');
  assert.equal(splitDescription('preamble\n# Real title\nbody').title, 'Real title');
  // A second heading is body, not a second title.
  assert.equal(splitDescription('# One\n# Two').body, '# Two');
  /*
   * No heading is an EMPTY title rather than an invented one, and the caller refuses on it. A
   * title guessed from the first sentence is the one field of a pull request nobody can avoid
   * reading, so it is the last place to put a guess.
   */
  assert.equal(splitDescription('no heading at all').title, '');
  assert.equal(splitDescription('no heading at all').body, 'no heading at all');
  // `#tag` and `#` alone are not headings.
  assert.equal(splitDescription('#nothashtag\nbody').title, '');
  assert.equal(splitDescription('#\nbody').title, '');
});

test('a description is stale when it predates the commit it has to describe', () => {
  const file = { path: '/t/pr-ABC-1.md', mtimeMs: 5_000, trusted: true };
  assert.deepEqual(descriptionState(file, 4_000), { kind: 'fresh', file });
  assert.deepEqual(descriptionState(file, 5_000), { kind: 'fresh', file }, 'the same instant');
  assert.deepEqual(descriptionState(file, 6_000), { kind: 'stale', file, tipMs: 6_000 });
  assert.deepEqual(descriptionState(undefined, 6_000), { kind: 'missing' });

  /*
   * The units trap, asserted because it fails in the direction nobody investigates. `git log
   * --format=%ct` is SECONDS and an mtime is MILLISECONDS; a caller that forgot to multiply
   * compares 1_760_000 against 1_760_000_000 and every description on disk reads as fresh
   * for ever -- which looks exactly like the feature working.
   */
  const nowMs = 1_760_000_000_000;
  const writtenBeforeTheCommit = { path: '/t/x.md', mtimeMs: nowMs - 60_000, trusted: true };
  assert.equal(descriptionState(writtenBeforeTheCommit, nowMs).kind, 'stale');
  assert.equal(
    descriptionState(writtenBeforeTheCommit, nowMs / 1000).kind,
    'fresh',
    'seconds compared against milliseconds is the mistake; this pins what it would look like',
  );
});

test('the newest description wins, and a conflict copy is never one', () => {
  const older = { path: '/t/a.md', mtimeMs: 10, trusted: true };
  const newer = { path: '/t/b.md', mtimeMs: 20, trusted: true };
  assert.equal(pickDescription([older, newer])?.path, '/t/b.md');
  assert.equal(pickDescription([newer, older])?.path, '/t/b.md');
  assert.equal(pickDescription([]), undefined);

  // `tmp merge` writes `<name>.from-<clone>.md` for the copy that did NOT win, so picking one up
  // would publish the losing half of a conflict.
  assert.equal(isConflictCopy('pr-description-no-jira-id.from-clone_03.md'), true);
  assert.equal(isConflictCopy('pr_description_ABC-1323.md'), false);
});

test('both filename shapes this fleet has used are matched, and neither is constructed', () => {
  const re = descriptionNameRe('ABC-1323');
  assert.ok(re.test('pr-ABC-1323.md'), 'the flat name');
  assert.ok(re.test('pr_description_ABC-1323.md'), "the name in the ticket's own directory");
  assert.ok(!re.test('pr_description_ABC-9999.md'), 'another ticket');
  assert.ok(!re.test('ticket_ABC-1323.md'), 'not a description at all');
  // The key is interpolated into a RegExp, so a metacharacter in it must not become a pattern.
  assert.ok(!descriptionNameRe('A.C-1').test('pr-ABC-1.md'));

  assert.ok(KEYLESS_NAME_RE.test('pr-description-no-jira-id.md'));
  assert.ok(!KEYLESS_NAME_RE.test('pr-ABC-1323.md'), 'a keyed name is not the keyless fallback');
});

test('the store is searched in two places, and only those two', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-prdesc-'));
  const write = (path: string, at: number): void => {
    writeFileSync(path, '# t\nbody');
    utimesSync(path, new Date(at), new Date(at));
  };
  mkdirSync(join(dir, 'ABC-1323'));
  mkdirSync(join(dir, 'ABC-9999'));
  write(join(dir, 'pr-ABC-1323.md'), 1_000_000);
  write(join(dir, 'ABC-1323', 'pr_description_ABC-1323.md'), 2_000_000);
  write(join(dir, 'ABC-1323', 'ticket.md'), 3_000_000);
  write(join(dir, 'ABC-9999', 'pr_description_ABC-9999.md'), 4_000_000);
  write(join(dir, 'pr-description-no-jira-id.md'), 5_000_000);
  write(join(dir, 'pr-ABC-1323.from-clone_02.md'), 6_000_000);

  const found = descriptionsIn(dir, 'ABC-1323').map((c) => c.path);
  assert.deepEqual(
    [...found].sort(),
    [join(dir, 'ABC-1323', 'pr_description_ABC-1323.md'), join(dir, 'pr-ABC-1323.md')].sort(),
  );
  // Another ticket's directory is not walked, which is also why this is two lookups and not a
  // recursive scan: this fleet's shared store holds a couple of hundred ticket directories.
  assert.ok(!found.some((p) => p.includes('ABC-9999')));
  assert.ok(!found.some((p) => p.endsWith('ticket.md')));
  assert.ok(!found.some((p) => p.includes('.from-')));
  assert.ok(descriptionsIn(dir, 'ABC-1323').every((c) => c.trusted));

  // The keyless fallback finds the flat file and marks it UNTRUSTED: the name belongs to no
  // branch in particular and every clone writes into this store.
  const keyless = descriptionsIn(dir, undefined);
  assert.deepEqual(
    keyless.map((c) => c.path),
    [join(dir, 'pr-description-no-jira-id.md')],
  );
  assert.equal(keyless[0]?.trusted, false);

  assert.deepEqual(descriptionsIn(join(dir, 'nope'), 'ABC-1323'), [], 'a missing store is empty');
});

test('a missing or stale description is written, refused, or declined — never used', () => {
  const file = { path: '/t/pr-ABC-1.md', mtimeMs: 5_000, trusted: true };
  const fresh = descriptionState(file, 4_000);
  const stale = descriptionState(file, 6_000);
  const missing = descriptionState(undefined, 6_000);
  const configured = { describe: true, prompt: '/pr-description', busy: false };

  assert.deepEqual(bodyDecision(fresh, configured), { kind: 'use', file });
  assert.deepEqual(bodyDecision(stale, configured), { kind: 'regenerate', state: stale });
  assert.deepEqual(bodyDecision(missing, configured), { kind: 'regenerate', state: missing });

  // `--no-describe` and an unconfigured prompt are different refusals, because the advice differs:
  // one says drop the flag, the other says set the config key.
  assert.deepEqual(bodyDecision(stale, { ...configured, describe: false }), {
    kind: 'refuse',
    state: stale,
    reason: 'declined',
  });
  assert.deepEqual(bodyDecision(stale, { ...configured, prompt: undefined }), {
    kind: 'refuse',
    state: stale,
    reason: 'no-prompt',
  });
  /*
   * A clone with a live session already has an agent in it, and two agents in one working
   * directory is this fleet's worst failure. The session that is there is also better placed to
   * write the description -- it has the conversation that produced the branch.
   */
  assert.deepEqual(bodyDecision(stale, { ...configured, busy: true }), {
    kind: 'refuse',
    state: stale,
    reason: 'busy',
  });
  // A FRESH description is used whatever the rest says: there is nothing to write.
  assert.deepEqual(bodyDecision(fresh, { describe: false, prompt: undefined, busy: true }), {
    kind: 'use',
    file,
  });
});

test('what Bitbucket answered is compared with what it was asked', () => {
  const asked = {
    source: 'features/ABC-1323_x',
    destination: 'master',
    title: 'ABC-1323: Close the tab',
    body: 'Why it exists.',
    draft: true,
  };
  const answered = {
    pr: {
      id: 7,
      title: asked.title,
      destination: 'master',
      url: 'https://example.invalid/7',
      state: 'open' as const,
      draft: true,
      headCommit: '',
      review: 'none' as const,
      author: '',
      authorName: '',
    },
    description: asked.body,
    source: asked.source,
    closeSourceBranch: false,
    reviewerUuids: [],
  };
  assert.deepEqual(
    readBackDisagreements(asked, answered),
    [],
    'an honest answer disagrees nowhere',
  );

  /*
   * The field that matters most, and the reason nothing here reports what it SENT. Bitbucket
   * silently accepts and drops what it does not recognise -- the create form's `title=` parameter
   * was documented as working for months on exactly that -- and a pull request that came back
   * ready for review has already notified its reviewers.
   */
  const published = { ...answered, pr: { ...answered.pr, draft: false } };
  assert.deepEqual(readBackDisagreements(asked, published), [
    { field: 'draft', asked: 'draft', answered: 'ready for review' },
  ]);

  const renamed = { ...answered, pr: { ...answered.pr, title: 'Features/abc-1323 x' } };
  assert.equal(readBackDisagreements(asked, renamed)[0]?.field, 'title');
  const retargeted = { ...answered, pr: { ...answered.pr, destination: 'release9' } };
  assert.equal(readBackDisagreements(asked, retargeted)[0]?.field, 'destination');

  // The body is compared TRIMMED: Bitbucket may normalise trailing whitespace in Markdown, and
  // reporting that as a dropped description would be a false alarm on every run.
  const respaced = { ...answered, description: `${asked.body}\n\n` };
  assert.deepEqual(readBackDisagreements(asked, respaced), []);
  const emptied = { ...answered, description: '' };
  assert.equal(readBackDisagreements(asked, emptied)[0]?.field, 'description');
});

test('an account uuid compares the same with braces and without', () => {
  /*
   * Both halves of `pr update`'s ownership check go through this, because Bitbucket brackets
   * uuids in some payloads and not in others. Comparing the raw strings answers "not yours" for
   * your own pull request -- which fails in the SAFE direction, and would therefore never be
   * investigated.
   */
  assert.equal(bareUuid('{9d0c-1}'), '9d0c-1');
  assert.equal(bareUuid('9d0c-1'), '9d0c-1');
  assert.equal(bareUuid('{9d0c-1}'), bareUuid('9d0c-1'));
  assert.equal(bareUuid(''), '');
});
