import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pullRequestLink, ticketLink } from '../src/commands/browse.ts';
import { DETACHED } from '../src/git.ts';
import { cloneAt } from '../src/fleet.ts';
import { issueKeyPattern, tmuxStatusArtifact } from '../src/generate/tmux-status-sh.ts';
import { fixtureConfigText, namesNoMachinePath, syntheticHangar } from './fixture.ts';

/**
 * The three facts on the clone bar: the branch, the ticket key and the pull request.
 *
 * The tmux half cannot be reached from here at all -- what a status line renders needs a server
 * and an attached client, and that is what the live checks in the commit body are for. What IS
 * here is either side of it: the pattern generated INTO the shell, and the links a click opens.
 */

/**
 * The fixture config with its `tracker:` block swapped for another.
 *
 * Surgery on the committed fixture rather than a config written out here: the fixture is the one
 * this repo's gated capture renders from, so a hand-built config would be a second idea of what
 * a valid one looks like -- and the schema would be the only thing to notice they had diverged.
 */
const withTracker = (tracker: string): ReturnType<typeof syntheticHangar> => {
  const text = fixtureConfigText();
  const start = text.indexOf('tracker:');
  const end = text.indexOf('\nrepo:', start);
  return syntheticHangar({ configText: `${text.slice(0, start)}${tracker}${text.slice(end)}` });
};

test('the key pattern comes from tracker.keyPrefixes, and is anchored', () => {
  assert.equal(issueKeyPattern(syntheticHangar()), '^(BE)-[0-9]+');
  const two = withTracker(
    'tracker:\n  kind: jira\n  baseUrl: https://j.invalid\n  keyPrefixes: [UI, PLAT]\n',
  );
  assert.equal(issueKeyPattern(two), '^(UI|PLAT)-[0-9]+');
  // Anchored because the shell matches against TOKENS, not the whole branch: without the `^`,
  // a branch called `feature/XABC-99_x` would report `ABC-99`. `jira.ts` gets that from a
  // lookbehind, which `grep -E` has not got.
  assert.ok(issueKeyPattern(two).startsWith('^'));
});

test('a hangar with no tracker, or no prefixes, gets no ticket field rather than a guess', () => {
  assert.equal(issueKeyPattern(withTracker('tracker:\n  kind: none\n')), '');
  // The interesting one: a tracker with no configured prefixes. `jira.ts` can match any
  // key-shaped token because it carries a sixteen-entry denylist of the ones that are not keys
  // (`UTF-8`, `SHA-256`), and reimplementing that list in shell is the duplicate the generated
  // script exists to avoid. Its own comment says why: a confident link to a ticket that does
  // not exist is worse than saying nothing.
  assert.equal(
    issueKeyPattern(withTracker('tracker:\n  kind: jira\n  baseUrl: https://j.invalid\n')),
    '',
  );
});

test('the script is a self-contained sh at the hangar root, naming no machine path', () => {
  const h = syntheticHangar();
  const artifact = tmuxStatusArtifact(h);
  assert.equal(artifact.path, `${h.root}/clone-tmux-status.sh`);
  assert.equal(artifact.mode, 0o755, 'tmux runs it, so it has to be executable');
  assert.ok(artifact.content.startsWith('#!/bin/sh\n'), 'sh, not bash: it runs from tmux');
  assert.ok(namesNoMachinePath(artifact.content));
  // One arm per field the conf asks for. A missing one is silent by construction -- every
  // failure in this script is `exit 0` with nothing printed, so the bar just goes quiet.
  for (const field of ['footer)', 'ticket)', 'pr)']) {
    assert.ok(artifact.content.includes(`\n${field}\n`), `no case arm for ${field}`);
  }
});

test('the build state is carried by SHAPE, so the bar reads in monochrome', () => {
  /*
   * The property that makes colour safe to use on this line at all. `contrast.test.ts` proves
   * each build colour is legible ON the bar and records that pass and fail are 1.18:1 against
   * each OTHER -- the red/green pair, which is no difference at all to a deuteranope. So the
   * glyphs have to differ, and every one of them has to survive with the colour stripped out.
   */
  const script = tmuxStatusArtifact(syntheticHangar()).content;
  const glyphs = ['pass', 'fail', 'running'].map((state) => {
    const arm = new RegExp(
      `\\n\\s*${state}\\) out="\\$out #\\[fg=[^\\]]+\\](.)#\\[default\\]"`,
    ).exec(script);
    assert.ok(arm?.[1] !== undefined, `no coloured glyph found for ci state ${state}`);
    return arm[1];
  });
  assert.equal(
    new Set(glyphs).size,
    3,
    `the build glyphs are not all distinct: ${glyphs.join('')}`,
  );
  // And none of them is a space or empty, which would make that set trivially satisfiable.
  for (const glyph of glyphs) assert.match(glyph, /\S/);
});

test('the pull-request link is the branch search until the number is known', () => {
  const ref = { workspace: 'acme', repo: 'storefront_ui' };
  const cold = pullRequestLink(ref, 'fixes/BE-12_x', undefined);
  assert.equal(cold.kind, 'url');
  // Not a consolation prize: Bitbucket's list takes a branch query, so this is a correct link
  // whether or not a PR exists -- which is what makes the bar's bare `PR` label honest, and what
  // makes this function total with no network call in it.
  assert.match(cold.url, /pull-requests\/\?query=fixes%2FBE-12_x/);

  const record = {
    branch: 'fixes/BE-12_x',
    id: 852,
    url: 'https://example.invalid/852',
    fetchedAt: 1,
    state: 'open',
    draft: false,
    ci: 'none',
    review: 'none',
  } as const;
  const known = pullRequestLink(ref, 'fixes/BE-12_x', record);
  assert.deepEqual(known, { kind: 'url', url: 'https://example.invalid/852', what: '#852' });

  /*
   * The negative record -- asked, and this branch has none. Its url IS the search link, so the
   * click still lands somewhere true; what it must never do is announce `#0`, which is the one
   * reading that names a pull request nobody has ever opened.
   */
  const negative = pullRequestLink(ref, 'fixes/BE-12_x', {
    ...record,
    id: 0,
    url: 'https://example.invalid/search',
  });
  assert.equal(negative.kind, 'url');
  assert.notEqual(negative.what, '#0');
  assert.match(negative.url, /query=fixes%2FBE-12_x/);

  // No forge, and a detached HEAD: a reason, never a URL missing its host.
  assert.equal(pullRequestLink(undefined, 'fixes/BE-12_x', undefined).kind, 'none');
  assert.equal(pullRequestLink(ref, DETACHED, undefined).kind, 'none');
});

test('a hangar with no tracker is told so, rather than being handed a keyless link', () => {
  const link = ticketLink(cloneAt(withTracker('tracker:\n  kind: none\n'), 1));
  assert.equal(link.kind, 'none');
  assert.match(link.why, /no tracker/);
});
