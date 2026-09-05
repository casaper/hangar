import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CliError } from '../src/exec.ts';
import { render, TOKENS, unknownTokens } from '../src/template.ts';

/**
 * The `{token}` renderer -- the piece the golden net can least see.
 *
 * A capture shows what one config rendered to. It cannot show what happens to a template that
 * is WRONG, and that is the whole risk here: several of these values are written into a live
 * clone's dotenv, so `PGDATABASE=warehouse_{indx2}` reaching disk verbatim would point a running
 * server at a database nobody meant. What is asserted here is the REFUSAL, in both of its
 * forms, plus that the token table and the renderer cannot drift apart.
 */

test('renders every known token from the values it is given', () => {
  assert.equal(
    render(
      '{id}-{index2}: {clone} on {port}',
      {
        id: 'wt',
        index2: '03',
        clone: 'wt-003',
        port: '3237',
      },
      'a test template',
    ),
    'wt-03: wt-003 on 3237',
  );
});

test('leaves text with no tokens exactly as it was', () => {
  assert.equal(render('http://localhost/ready', {}, 'a test template'), 'http://localhost/ready');
});

test('an UNKNOWN token throws and names it, rather than rendering it away', () => {
  // The failure this prevents: an empty string is a plausible-looking value, and a dotenv line
  // reading `PGDATABASE=warehouse_` is wrong in a way nothing downstream can detect.
  assert.throws(
    () => render('warehouse_{indx2}', { index2: '03' }, 'repo.cloneEnv.vars.PGDATABASE'),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /\{indx2\}/);
      assert.match(error.message, /repo\.cloneEnv\.vars\.PGDATABASE/);
      return true;
    },
  );
});

test('a KNOWN token with no value in this context throws too', () => {
  // `{port}` means nothing outside a port role. Distinct from the unknown case on purpose:
  // the token is spelled correctly and the fix is a different one, so the messages differ.
  assert.throws(
    () => render('http://localhost:{port}', { id: 'wt' }, 'ports.roles[0].url'),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /\{port\}/);
      assert.match(error.message, /no value here/);
      return true;
    },
  );
});

test('unknownTokens reports names, deduplicated, and is empty for a valid template', () => {
  assert.deepEqual(unknownTokens('{indx2}-{indx2}-{nope}'), ['indx2', 'nope']);
  assert.deepEqual(unknownTokens('{id}-{index2}'), []);
  assert.deepEqual(unknownTokens('no tokens at all'), []);
});

test('every token in the table is renderable, so the table and the renderer cannot drift', () => {
  // Guards the one mistake a reader would not catch: adding a name to TOKENS while the renderer
  // still rejects it, or removing one the schema still advertises as known.
  for (const token of TOKENS) {
    assert.equal(
      render(`{${token}}`, { [token]: 'x' }, 'the token table'),
      'x',
      `{${token}} did not render`,
    );
    assert.deepEqual(unknownTokens(`{${token}}`), [], `{${token}} is not in the known set`);
  }
});
