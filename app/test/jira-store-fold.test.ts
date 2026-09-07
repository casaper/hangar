import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { foldCloneStore } from '../src/commands/tmp.ts';
import { cloneAt } from '../src/fleet.ts';
import { captureOutput, releaseCapture } from '../src/ui.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * Folding a clone's OWN record store into the fleet's.
 *
 * **Every branch here writes into the canonical store, and none of it is reachable from a
 * capture.** A clone normally REACHES the store rather than holding one, so this runs only where
 * that link could not be made -- a checkout that belonged to no fleet yet, or a filesystem that
 * refused one -- which means it is exercised by no dry run, no golden capture and no live fleet
 * until the day it matters. It was written for a bug that had never fired: left to `adoptInto`,
 * a difference between two records becomes `<KEY>.from-clone_NN.md` INSIDE the store, under a
 * name no pass reads as a record, so nothing would ever find it again.
 *
 * A real temporary tree rather than a synthetic root, because the whole function is filesystem
 * decisions -- which of two records is fresher, whether the directory came out empty.
 */

const RECORD = (key: string, fetched: string): string =>
  `---\nid: ${key}\nfetched_at: ${fetched}\n---\n\n# ${key}\n`;

const OLD = '2026-09-01T10:00:00+0200';
const NEW = '2026-09-05T10:00:00+0200';

type Tree = {
  hangar: ReturnType<typeof syntheticHangar>;
  clone: ReturnType<typeof cloneAt>;
  store: string;
  mine: string;
};

const build = (): Tree => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-fold-'));
  const hangar = syntheticHangar({ root });
  const clone = cloneAt(hangar, 1);
  const store = hangar.paths.jiraTickets;
  const mine = join(clone.path, 'tmp', 'jira-tickets');
  mkdirSync(store, { recursive: true });
  mkdirSync(mine, { recursive: true });

  // The fleet already holds these.
  writeFileSync(join(store, 'ABC-2.md'), RECORD('ABC-2', OLD));
  writeFileSync(join(store, 'ABC-3.md'), RECORD('ABC-3', NEW));
  writeFileSync(join(store, 'ABC-4.md'), RECORD('ABC-4', NEW));
  writeFileSync(join(store, 'ABC-5_asset_shot.png'), 'the fleet download');

  // What the clone accumulated while it could not reach the store.
  writeFileSync(join(mine, 'ABC-1.md'), RECORD('ABC-1', OLD));
  writeFileSync(join(mine, 'ABC-2.md'), RECORD('ABC-2', NEW));
  writeFileSync(join(mine, 'ABC-3.md'), RECORD('ABC-3', OLD));
  writeFileSync(join(mine, 'ABC-4.md'), RECORD('ABC-4', NEW));
  writeFileSync(join(mine, 'ABC-5_asset_shot.png'), 'a different download');
  return { hangar, clone, store, mine };
};

const quietly = <T>(run: () => T): T => {
  captureOutput();
  try {
    return run();
  } finally {
    releaseCapture(false);
  }
};

test('a clone’s private store folds in, freshest record wins, and no conflict file is invented', () => {
  const { hangar, clone, store, mine } = build();
  // False, because the differing asset below is left for a human: the answer is "this clone's
  // entry is ready to be a link", and while anything is still there it is not.
  assert.equal(
    quietly(() => foldCloneStore(hangar, clone, false)),
    false,
  );

  // New to the fleet: moved.
  assert.equal(readFileSync(join(store, 'ABC-1.md'), 'utf8'), RECORD('ABC-1', OLD));
  // The clone's is fresher: it wins outright. There is no trunk to prefer between two store
  // records -- they are two renderings of the same ticket's own record.
  assert.equal(readFileSync(join(store, 'ABC-2.md'), 'utf8'), RECORD('ABC-2', NEW));
  // The fleet's is fresher: the clone's is dropped, and the fleet's is left untouched.
  assert.equal(readFileSync(join(store, 'ABC-3.md'), 'utf8'), RECORD('ABC-3', NEW));
  // Identical: dropped.
  assert.equal(readFileSync(join(store, 'ABC-4.md'), 'utf8'), RECORD('ABC-4', NEW));

  for (const gone of ['ABC-1.md', 'ABC-2.md', 'ABC-3.md', 'ABC-4.md'])
    assert.ok(!existsSync(join(mine, gone)), `${gone} was left in the clone`);

  // THE property this function exists for: nothing in the store is anything but a record or an
  // asset. A `.from-clone` file here would be invisible to every later pass.
  for (const name of readdirSync(store))
    assert.match(name, /^ABC-\d+(\.md|_asset_.*)$/, `${name} is not a record or an asset`);
});

test('a differing ASSET is left in place rather than resolved, and the directory stays', () => {
  const { hangar, clone, store, mine } = build();
  quietly(() => foldCloneStore(hangar, clone, false));

  // A differing download under one name is a bad download, not a newer rendering, so neither
  // copy is preferred -- the same rule the freshest-wins collapse applies to assets.
  assert.equal(readFileSync(join(store, 'ABC-5_asset_shot.png'), 'utf8'), 'the fleet download');
  assert.ok(existsSync(join(mine, 'ABC-5_asset_shot.png')));
  // And so the directory cannot be removed, which is reported rather than forced.
  assert.ok(existsSync(mine));

  // Resolve it by hand and a second run finishes the job -- the command's "run it again" shape.
  rmSync(join(mine, 'ABC-5_asset_shot.png'));
  assert.equal(
    quietly(() => foldCloneStore(hangar, clone, false)),
    true,
    'with nothing left to decide the entry is ready to be a link',
  );
  // An ALREADY EMPTY directory has to go too, not just one this run emptied -- it is the state
  // the previous run left behind, and leaving it would make the link pass report a real
  // directory in the way of a link it is about to make, on every run for ever.
  assert.ok(!existsSync(mine), 'an emptied private store should be gone, so it can be linked');
});

test('a dry run decides everything and writes nothing', () => {
  const { hangar, clone, store, mine } = build();
  // Nothing this pass would not decide, so the preview can promise the link.
  rmSync(join(mine, 'ABC-5_asset_shot.png'));
  assert.equal(
    quietly(() => foldCloneStore(hangar, clone, true)),
    true,
  );
  assert.ok(!existsSync(join(store, 'ABC-1.md')), 'a dry run moved a record');
  assert.equal(readFileSync(join(store, 'ABC-2.md'), 'utf8'), RECORD('ABC-2', OLD));
  assert.ok(existsSync(join(mine, 'ABC-1.md')), 'a dry run removed a record');
  assert.ok(existsSync(mine));
});

test('a clone that REACHES the store is left entirely alone', () => {
  const { hangar, clone, store, mine } = build();
  rmSync(mine, { recursive: true });
  symlinkSync(store, mine);

  // The normal case, and the one pass 2a already handles: a link is not a private store, and
  // walking it would offer the store's own records back to the store.
  assert.equal(
    quietly(() => foldCloneStore(hangar, clone, false)),
    false,
  );
  assert.equal(readFileSync(join(store, 'ABC-2.md'), 'utf8'), RECORD('ABC-2', OLD));
});
