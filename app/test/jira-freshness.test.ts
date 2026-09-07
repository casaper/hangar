import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { freshnessOf } from '../src/dedupe.ts';

/**
 * A cached record's timestamp is found however long its frontmatter is.
 *
 * **The one property here is a size, which is why nothing else could hold it.** Freshness is read
 * out of the leading frontmatter block, and a record's block is a neighbourhood listing -- its
 * length is a function of how many parents, sub-tasks, siblings and relations the ticket has. So
 * "the block fits in the window" is a claim about data this repo does not own, and it stopped
 * being true when the tracker skill started writing the neighbourhood.
 *
 * What made it worth a test rather than a bigger number is the failure MODE. A block that runs
 * past the window has no closing delimiter inside it, the match fails, and freshness silently
 * becomes the file's mtime -- and the cache hook refuses to serve any record whose timestamp came
 * from mtime, since an mtime is not evidence about when Jira was asked. A window one line too
 * small therefore turns the entire ticket cache off, with every gate green and every command
 * reporting success. Real records reached 4.4 KB against a 4 KB window.
 *
 * Written to a real temporary file because the thing under test is a read of one.
 */

const withFrontmatter = (body: string): string =>
  ['---', 'id: ABC-1', 'fetched_at: 2026-09-04T12:41:14+0200', body, '---', '', '# Title', ''].join(
    '\n',
  );

const write = (name: string, content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'hangar-freshness-')), name);
  writeFileSync(path, content, 'utf8');
  return path;
};

test('a fetched_at past any fixed window is still read, not silently downgraded to mtime', () => {
  // A neighbourhood listing far larger than the 4 KB this once truncated at.
  const neighbourhood = [
    'subtasks:',
    ...Array.from({ length: 400 }, (_, i) => `  - id: ABC-${String(i + 100)}\n    type: Sub-task`),
    'relations: []',
  ].join('\n');
  const path = write('ABC-1.md', withFrontmatter(neighbourhood));

  const { at, source } = freshnessOf(path);
  assert.equal(source, 'fetched', 'the timestamp fell back to mtime, which the cache hook refuses');
  assert.equal(at, Date.parse('2026-09-04T12:41:14+02:00'));
});

test('both spellings rank, and a file with no frontmatter falls back honestly', () => {
  // Two generations of the cache are on disk at once and have to rank against each other.
  for (const key of ['fetched', 'fetched_at']) {
    const path = write('ABC-2.md', `---\nid: ABC-2\n${key}: 2026-09-04T12:41:14+0200\n---\n\nx\n`);
    assert.equal(freshnessOf(path).source, 'fetched', `${key} did not rank`);
  }

  // Jira's own timestamp is the fallback, and mtime the last resort -- which must still be
  // REPORTED as mtime rather than passed off as a fetch time.
  const updated = write('ABC-3.md', '---\nid: ABC-3\nupdated_at: 2026-09-04T12:41:14+0200\n---\n');
  assert.equal(freshnessOf(updated).source, 'updated');

  const bare = write('ABC-4.md', '# no frontmatter at all\n');
  assert.equal(freshnessOf(bare).source, 'mtime');

  // The body is never scanned: a `fetched_at:` quoted inside a Jira comment is not this file's.
  const inBody = write(
    'ABC-5.md',
    '# t\n\nsomebody pasted:\n\nfetched_at: 2020-01-01T00:00:00+0000\n',
  );
  assert.equal(freshnessOf(inBody).source, 'mtime');
});
