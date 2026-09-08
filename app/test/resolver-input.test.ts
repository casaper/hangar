import assert from 'node:assert/strict';
import { test } from 'node:test';

import { userMessageLine } from '../src/resolve-conflicts.ts';

/**
 * The line protocol the resolver's stdin speaks.
 *
 * This is a contract with another program rather than text for a human, which is what makes it
 * worth asserting: a field of the wrong shape is a message the session ignores in silence, and
 * the only other way to find that out is a live `claude -p` in a conflicted clone. A golden
 * capture cannot reach it either -- nothing is generated, and what would show is a resolution
 * that quietly did not hear the operator.
 */

const parse = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

test('the envelope carries the fields the session reads', () => {
  const event = parse(userMessageLine('keep master’s version of that test'));
  assert.equal(event['type'], 'user');
  assert.equal(event['parent_tool_use_id'], null);
  assert.deepEqual(event['message'], {
    role: 'user',
    content: 'keep master’s version of that test',
  });
});

test('one message is one line, whatever was typed into it', () => {
  // The stream is newline-delimited, so a raw newline in the payload would arrive as two
  // fragments, neither of them valid JSON. Quotes and braces are the same class of hazard.
  const line = userMessageLine('take "theirs" here\nand {ours} in the spec\ttab too');
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false);
  assert.equal(
    (parse(line)['message'] as Record<string, unknown>)['content'],
    'take "theirs" here\nand {ours} in the spec\ttab too',
  );
});

test('an empty instruction is still a well-formed message', () => {
  // Nothing here filters: the caller drops blank lines, and this stays total so that a change
  // to that filter cannot produce a line the session refuses to parse.
  assert.deepEqual(parse(userMessageLine(''))['message'], { role: 'user', content: '' });
});
