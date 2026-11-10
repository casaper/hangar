import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The personal `copy-to-clipboard` shadows the managed repo's skill, so a file written for agents
 * reaches the clipboard through THIS script -- and a frontmatter block pasted into a tracker or a
 * pull request is the failure. Required, not spawned: the module exports its pure half and never
 * touches the clipboard when it is not the main module.
 */
const clipPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'personal-skills',
  'copy-to-clipboard',
  'clip.cjs',
);
const { clipboardText } = createRequire(import.meta.url)(clipPath) as {
  clipboardText: (input: string, keepFrontmatter: boolean, keepNewline: boolean) => string;
};

const pasted = (input: string): string => clipboardText(input, false, false);

test('a leading frontmatter block is dropped, LF or CRLF', () => {
  assert.equal(pasted('---\nkind: x\n---\nbody\n'), 'body');
  assert.equal(pasted('---\r\nkind: x\r\n---\r\nbody\r\n'), 'body');
  assert.equal(pasted('---\nkind: x\n---'), '');
});

test('only a block on line 1 with a closing line is frontmatter', () => {
  assert.equal(pasted('no block\n'), 'no block');
  assert.equal(pasted('---\na rule, never closed\n'), '---\na rule, never closed');
  assert.equal(pasted('x\n---\na\n---\nb\n'), 'x\n---\na\n---\nb');
  // A body that opens with blank lines and then a rule: a guide's seam, never a block.
  assert.equal(pasted('\n\n---\nkept\n---\n'), '\n\n---\nkept\n---');
});

test('the body keeps its own leading blank lines; only the closing line break goes', () => {
  assert.equal(pasted('---\nk: v\n---\n\n\nbody'), '\n\nbody');
});

test('--keep-frontmatter and --keep-newline leave the input alone', () => {
  assert.equal(clipboardText('---\na\n---\nb\n', true, true), '---\na\n---\nb\n');
});
