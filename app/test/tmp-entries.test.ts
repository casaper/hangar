import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { adoptInto } from '../src/adopt.ts';
import { cloneAt } from '../src/fleet.ts';
import {
  isNeverSharedName,
  isPrivateTmpEntry,
  shareableStoreEntries,
  unsharedTmpEntries,
} from '../src/tmp.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * What the shared `tmp/` may carry between clones, decided once for both directions.
 *
 * `tmp merge` adopts a clone's entries into the store and links the store's entries back into
 * every clone, and the two directions must give one answer: a store side that lets through
 * anything but dotfiles and PID files links Claude Code's own temp roots (`claude-501/`,
 * `cc-socks/`) into every clone -- the one shape that stops Claude Code from starting there.
 * Asserted against wrong input, which no capture can show.
 */

const hangar = syntheticHangar();

test('Claude Code temp roots, dotfiles, PID files and PID directories are never shared', () => {
  for (const name of [
    'claude-501',
    'claude-0',
    'cc-socks',
    '.claude-tmp',
    '.DS_Store',
    'ng_serve.pid',
    `_${cloneAt(hangar, 3).name}`,
  ]) {
    assert.ok(isNeverSharedName(hangar, name), name);
  }
});

test('ordinary cache and scratch stay shared, near-misses of the private names included', () => {
  const names = [
    'ABC-1349',
    'jira-tickets',
    // The repo's drafts of tickets not filed yet: one directory per summary, shared like the rest.
    'new_tickets',
    'author-aliases.md',
    'run1.txt',
    'claude-notes',
    'claude-501.md',
    'cc-socks-old',
    '_notes',
    'pid.txt',
  ];
  assert.deepEqual(shareableStoreEntries(hangar, names), [...names].sort());
});

test('the store side and the clone side refuse the same names', () => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-tmp-entries-'));
  try {
    const local = syntheticHangar({ root });
    const clone = cloneAt(local, 1);
    mkdirSync(join(clone.path, 'tmp', 'servers'), { recursive: true });
    writeFileSync(join(clone.path, 'tmp', 'servers', 'storybook.pid'), '123');
    mkdirSync(join(clone.path, 'tmp', 'ABC-1349'), { recursive: true });

    const names = ['claude-501', 'cc-socks', '.claude-tmp', 'x.pid', 'ABC-1349', 'run1.txt'];
    for (const name of names) {
      assert.equal(
        isPrivateTmpEntry(clone, name),
        !shareableStoreEntries(local, [name]).includes(name),
        name,
      );
    }
    // A directory holding only PID files is the clone's own, whatever it is called -- only the
    // clone side can see inside it, which is why that half is a filesystem check.
    assert.ok(isPrivateTmpEntry(clone, 'servers'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('what deleting a clone would lose: its real, shareable tmp/ entries and nothing else', () => {
  /*
   * `remove-clone --delete` guards on this. `tmp/` is ignored, so the git guards never see it,
   * and a link loses nothing -- its content is in the store. A real entry is the only copy.
   */
  const root = mkdtempSync(join(tmpdir(), 'hangar-tmp-unshared-'));
  try {
    const local = syntheticHangar({ root });
    const clone = cloneAt(local, 2);
    const tmp = join(clone.path, 'tmp');
    mkdirSync(join(tmp, 'ABC-1349'), { recursive: true });
    mkdirSync(join(tmp, 'jira-tickets'));
    mkdirSync(join(tmp, '.claude-tmp'));
    mkdirSync(join(local.root, 'tmp', 'ABC-1191'), { recursive: true });
    symlinkSync(join(local.root, 'tmp', 'ABC-1191'), join(tmp, 'ABC-1191'));
    writeFileSync(join(tmp, 'run1.txt'), 'x');
    writeFileSync(join(tmp, 'ng_serve.pid'), '1');
    writeFileSync(join(tmp, '.DS_Store'), '');

    assert.deepEqual(unsharedTmpEntries(clone), ['ABC-1349', 'jira-tickets', 'run1.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Jira hook's links in a real ticket directory are the store's own, not a stranger's", () => {
  /*
   * A real `tmp/<KEY>/` in a clone holds the hook's RELATIVE links into `jira-tickets/`. Judged
   * by the ticket's own destination they look foreign, so every `tmp merge` would warn "left
   * alone" about each one -- and in `--quiet` a single warn prints the whole narration, at every
   * session end in that clone.
   */
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adopt-links-')));
  try {
    const store = join(root, 'store');
    const clone = join(root, 'clone', 'tmp');
    mkdirSync(join(store, 'jira-tickets'), { recursive: true });
    writeFileSync(join(store, 'jira-tickets', 'ABC-7.md'), 'record\n');
    writeFileSync(join(store, 'jira-tickets', 'ABC-8.md'), 'other\n');
    mkdirSync(join(store, 'ABC-7'));
    symlinkSync('../jira-tickets/ABC-7.md', join(store, 'ABC-7', 'ticket.md'));
    mkdirSync(join(clone, 'ABC-7'), { recursive: true });
    symlinkSync(join(store, 'jira-tickets'), join(clone, 'jira-tickets'));
    symlinkSync('../jira-tickets/ABC-7.md', join(clone, 'ABC-7', 'ticket.md'));
    symlinkSync('../jira-tickets/ABC-8.md', join(clone, 'ABC-7', 'ticket_relation_ABC-8.md'));

    const actions = adoptInto(join(clone, 'ABC-7'), store, {
      label: 'clone_01',
      dryRun: false,
      storeRoot: store,
    });
    const kinds = actions.map((a) => `${a.kind} ${a.message}`);
    assert.ok(!kinds.some((k) => k.startsWith('skipped')), `warned about: ${kinds.join('; ')}`);
    assert.ok(
      kinds.some((k) => /dropped .*ticket\.md: same link/.test(k)),
      kinds.join('; '),
    );
    // Nothing is left behind in the clone: a directory stripped of its links but left standing
    // would be "in the way" of pass 2b's link, and the clone would lose its ticket records.
    assert.equal(existsSync(join(clone, 'ABC-7')), false, 'the emptied ticket directory stayed');
    // The relation link the store lacked moved in, and still resolves to the same record.
    assert.equal(
      realpathSync(join(store, 'ABC-7', 'ticket_relation_ABC-8.md')),
      join(store, 'jira-tickets', 'ABC-8.md'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
