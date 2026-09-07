import assert from 'node:assert/strict';
import { relative, resolve } from 'node:path';
import { test } from 'node:test';

import {
  assetRefsIn,
  pickWinner,
  storeLinkTarget,
  ticketNameOf,
  type TicketGroup,
  type TicketRecord,
} from '../src/jira-records.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * What a cached filename is, and what a cached name must point at.
 *
 * **The two things a layout change breaks, and neither is visible to a capture.** `dev/golden`
 * records the artifacts this CLI writes; it records nothing about `tmp/`, so a predicate that
 * stops recognising a ticket record makes the store pass silently do nothing and every gate stay
 * green. That is not hypothetical -- it is exactly what happened when the tracker skill moved the
 * trunk key out of the filename, and the pass was dark for as long as it took somebody to notice
 * the command had stopped printing a heading.
 *
 * So the properties here are the ones no other check can hold:
 *
 * - every name in BOTH live layouts classifies, and a neighbour is never read as an own record --
 *   the distinction the winner rule is built on;
 * - a name that is not a record classifies as nothing, including the conflict copies this CLI
 *   writes itself;
 * - a ticket's own record beats a neighbour ACROSS layouts, which is the rule the store exists to
 *   make structural rather than remembered;
 * - the store link target is the relative form that survives a clone's symlinked trunk directory,
 *   which is the one computation whose obvious spelling is wrong.
 */

const hangar = syntheticHangar();

const record = (over: Partial<TicketRecord> = {}): TicketRecord => ({
  path: '/wt/tmp/ABC-1/ticket.md',
  rel: 'ABC-1/ticket.md',
  key: 'ABC-1',
  statedKey: 'ABC-1',
  isRelationCopy: false,
  relatedTo: undefined,
  at: 1_000,
  source: 'fetched',
  mtime: 1_000,
  linksToStore: false,
  assetRefs: new Set<string>(),
  content: '---\nid: ABC-1\n---\n',
  ...over,
});

test('every name the store layout writes classifies, and the key can come from the directory', () => {
  // `ticket.md` carries no key at all: the directory is the only thing that says which ticket
  // this is, which is the whole reason this function takes two arguments.
  assert.deepEqual(ticketNameOf('ABC-1349', 'ticket.md'), {
    key: 'ABC-1349',
    ownRecord: true,
    layout: 'store',
  });

  for (const kind of ['parent', 'subtask', 'sibling', 'relation']) {
    assert.deepEqual(
      ticketNameOf('ABC-1349', `ticket_${kind}_ABC-1343.md`),
      { key: 'ABC-1343', ownRecord: false, layout: 'store' },
      `${kind} did not classify`,
    );
  }
});

test('every name the flat layout writes classifies, and the last key is what the file contains', () => {
  assert.deepEqual(ticketNameOf('ABC-1349', 'ticket_ABC-1349.md'), {
    key: 'ABC-1349',
    ownRecord: true,
    layout: 'flat',
  });

  // The keys before the last one only say how it was reached.
  for (const slug of ['relates_to', 'is_blocked_by', 'parent', 'clones']) {
    assert.deepEqual(
      ticketNameOf('ABC-1349', `ticket_ABC-1349_${slug}_ABC-1343.md`),
      { key: 'ABC-1343', ownRecord: false, layout: 'flat' },
      `${slug} did not classify`,
    );
  }
});

test('a neighbour is never read as an own record, in either layout', () => {
  const names = [
    'ticket_relation_ABC-1343.md',
    'ticket_parent_ABC-1343.md',
    'ticket_ABC-1349_relates_to_ABC-1343.md',
  ];
  for (const name of names) {
    const parsed = ticketNameOf('ABC-1349', name);
    assert.ok(parsed !== undefined, `${name} did not classify at all`);
    // If this ever answers true, `pickWinner`'s pool becomes every copy and a ticket's own
    // record starts losing to a fresher sideways one -- the exact regression the store was
    // built to make unreachable.
    assert.equal(parsed.ownRecord, false, `${name} was read as an own record`);
    assert.equal(parsed.key, 'ABC-1343', `${name} named the wrong ticket`);
  }
});

test('`ticket.md` is a record only inside a directory named for a ticket', () => {
  // At the top of `tmp/` the containing directory is `tmp`, and a stray `ticket.md` there is
  // somebody's scratch file, not a ticket nobody can name.
  assert.equal(ticketNameOf('tmp', 'ticket.md'), undefined);
  assert.equal(ticketNameOf('jira-tickets', 'ticket.md'), undefined);
  assert.equal(ticketNameOf('', 'ticket.md'), undefined);
});

test('nothing else in the per-ticket cache is a record', () => {
  const notRecords: [string, string][] = [
    ['ABC-1', 'plan_ABC-1.md'],
    ['ABC-1', 'pr_description_ABC-1.md'],
    ['ABC-1', 'jira_draft_ABC-1.md'],
    ['ABC-1', 'ABC-1_asset_shot.png'],
    ['ABC-1', 'ticket_ABC-1_asset_shot.png'],
    ['ABC-1', 'notes.md'],
    ['ABC-1', 'ticket.txt'],
    // The conflict copies this CLI writes itself. One of these landing in the store as a record
    // would make it another ticket's one copy, and nothing would ever find it again.
    ['ABC-1', 'ticket_ABC-1.from-clone_02.md'],
    ['jira-tickets', 'ABC-1.from-clone_02.md'],
    // The store record itself is never a copy to be re-pointed -- it is read separately.
    ['jira-tickets', 'ABC-1.md'],
  ];
  for (const [dir, name] of notRecords) {
    assert.equal(ticketNameOf(dir, name), undefined, `${dir}/${name} classified as a record`);
  }
});

test('a ticket’s own record beats a neighbour regardless of age, across layouts', () => {
  const own = record({ rel: 'ABC-1343/ticket_ABC-1343.md', key: 'ABC-1343', at: 1_000 });
  const neighbour = record({
    rel: 'ABC-1349/ticket_relation_ABC-1343.md',
    key: 'ABC-1343',
    at: 9_999,
    isRelationCopy: true,
  });
  const group: TicketGroup = {
    key: 'ABC-1343',
    stored: undefined,
    copies: [neighbour, own],
    mismatched: [],
  };
  // Freshness only ranks peers. A neighbour carries strictly extra, trunk-specific keys, so
  // letting it win is how a ticket's own record ends up reading as though it hangs off another.
  assert.equal(pickWinner(group)?.rel, own.rel);

  // And with no own record anywhere, the freshest neighbour is the best available answer.
  const older = record({
    rel: 'ABC-1350/ticket_relation_ABC-1343.md',
    at: 5,
    isRelationCopy: true,
  });
  assert.equal(
    pickWinner({ key: 'ABC-1343', stored: undefined, copies: [older, neighbour], mismatched: [] })
      ?.rel,
    neighbour.rel,
  );
});

test('asset references are recognised in both spellings', () => {
  const body = [
    '![](ABC-1191_asset_shot.png)',
    '![](ticket_ABC-1323_relates_to_ABC-1191_asset_other.png)',
    'and a bare word that is not one: ABC-1191 asset',
  ].join('\n');
  assert.deepEqual([...assetRefsIn(body)].sort(), [
    'ABC-1191_asset_shot.png',
    'ticket_ABC-1323_relates_to_ABC-1191_asset_other.png',
  ]);

  // The store spelling is what the cache hook checks resolves beside a destination before it
  // denies a fetch. Matching nothing would let it deny one having linked no attachments at all.
  assert.equal(assetRefsIn('![](ABC-1191_asset_shot.png)').size, 1);
  assert.equal(assetRefsIn('no attachments here').size, 0);
});

test('the store link target is relative to the trunk directory, not to the path used to name it', () => {
  const target = storeLinkTarget(hangar, 'ABC-1349');
  assert.equal(target, '../jira-tickets/ABC-1349.md');

  // The property that matters: a link created in the hangar's own trunk directory reaches the
  // record, and that directory is where it lands however it was addressed -- `<clone>/tmp/ABC-1349`
  // is an absolute symlink to it.
  const store = '/wt/tmp/jira-tickets/ABC-1349.md';
  assert.equal(resolve('/wt/tmp/ABC-1349', target), store);

  // The obvious spelling, and why it is not used: computed from a clone's absolute path it
  // answers something that climbs out past the hangar root once the link is resolved where it
  // actually sits.
  const naive = relative('/wt/clone_01/tmp/ABC-1349', store);
  assert.notEqual(naive, target);
  assert.notEqual(resolve('/wt/tmp/ABC-1349', naive), store);
});
