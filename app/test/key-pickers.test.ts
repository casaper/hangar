import assert from 'node:assert/strict';
import { test } from 'node:test';

import { editRows, planRows, ticketRows, WORKSPACE_ROW } from '../src/commands/key.ts';

/**
 * What the pickers behind `C-b C-e`, `C-b C-t` and `C-b C-p` offer. Properties, not snapshots:
 * the first row is what Enter picks before anything is typed, so it is the one that matters.
 */

test('C-b C-e offers the clone first, then each directory once, then the files', () => {
  const rows = editRows(['README.md', 'src/app/a.ts', 'src/app/b.ts', 'src/main.ts']);
  assert.equal(rows[0], WORKSPACE_ROW, 'Enter with nothing typed opens the clone, as before');
  assert.deepEqual(
    rows.filter((row) => row.endsWith('/')),
    ['src/', 'src/app/'],
  );
  // A directory row ends in `/` and a file row never does: that slash is how `openPicked` tells
  // a folder (file manager) from a file (editor) without asking the disk again.
  assert.deepEqual(
    rows.filter((row) => row !== WORKSPACE_ROW && !row.endsWith('/')),
    ['README.md', 'src/app/a.ts', 'src/app/b.ts', 'src/main.ts'],
  );
});

test('C-b C-t offers the ticket folder first, then its files, all under tmp/<KEY>/', () => {
  const rows = ticketRows('ABC-1323', ['ticket.md', 'attachments/x.png']);
  assert.deepEqual(rows, [
    'tmp/ABC-1323/',
    'tmp/ABC-1323/ticket.md',
    'tmp/ABC-1323/attachments/x.png',
  ]);
});

test('C-b C-p lists the newest session plan first, and the ticket plan last', () => {
  const rows = planRows(
    [
      { path: '.claude/plans/old.md', mtimeMs: 1 },
      { path: '.claude/plans/new.md', mtimeMs: 2 },
    ],
    'tmp/ABC-1323/plan_ABC-1323.md',
  );
  assert.deepEqual(rows, [
    '.claude/plans/new.md',
    '.claude/plans/old.md',
    'tmp/ABC-1323/plan_ABC-1323.md',
  ]);
  assert.deepEqual(planRows([], undefined), [], 'nothing to open is an empty list, not a picker');
});
