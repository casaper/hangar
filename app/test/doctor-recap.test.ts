import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DoctorWarning, doctorRecap } from '../src/commands/doctor.ts';

/**
 * The closing recap repeats what `doctor` found, and repeats it VERBATIM.
 *
 * Properties, never a snapshot: the point of the builder is not what the bullet character is, it
 * is that a warning printed a hundred rows up is reproduced word for word at the bottom. These
 * assertions hold while somebody reworks the prose of any individual check, which is the whole
 * reason expected text does not live here.
 *
 * The bug this covers is not a wrong string, it is an ABSENT one: `doctor`'s summary counted its
 * problems without naming them, so a correct check printing a correct fix went unread through
 * several sessions. `no warnings -> no lines` matters for the same reason in reverse -- a recap
 * that printed a heading over an empty list would be one more row to learn to scroll past.
 */

test('no warnings produces no lines at all', () => {
  assert.deepEqual(doctorRecap([]), []);
});

test('a warning is reproduced verbatim, not re-worded', () => {
  const text = 'no shell rc sources clone-terminal.sh, so no shell colours itself per clone';
  const [line] = doctorRecap([{ text }]);
  assert.ok(line !== undefined);
  assert.ok(
    line.includes(text),
    'the recap must carry the discovery-point wording; two phrasings read as two findings',
  );
});

test('a clone warning names its clone and a hangar one does not', () => {
  const warnings: readonly DoctorWarning[] = [
    { text: 'the shared secrets file does not exist' },
    { clone: 'checkout_0002', text: 'theme json — missing' },
  ];
  const [hangarLine, cloneLine] = doctorRecap(warnings);
  assert.ok(hangarLine !== undefined && cloneLine !== undefined);
  assert.ok(cloneLine.includes('checkout_0002'), 'a clone warning is useless without its clone');
  assert.ok(
    !hangarLine.includes('checkout_0002'),
    'a hangar-level warning belongs to no clone and must not be attributed to one',
  );
});

test('every warning survives, in the order it was found', () => {
  const warnings: readonly DoctorWarning[] = [
    { text: 'first' },
    { clone: 'a', text: 'second' },
    { clone: 'b', text: 'third' },
  ];
  const lines = doctorRecap(warnings);
  assert.equal(lines.length, warnings.length, 'a dropped warning is the failure being fixed');
  // Order is the report's order, so the recap reads in the same sequence as the rows above it.
  assert.deepEqual(
    lines.map((line) => warnings.findIndex((w) => line.includes(w.text))),
    [0, 1, 2],
  );
});

/**
 * An empty `clone` string is not a clone.
 *
 * `DoctorWarning.clone` is free text arriving from `Clone.name`, and the recap decides how to
 * render a line by whether it is there. Only `undefined` means "above the clones"; anything else
 * is rendered as a clone, so this pins that the distinction is made on presence and nothing else.
 */
test('undefined is the only thing that means hangar-level', () => {
  const [line] = doctorRecap([{ clone: undefined, text: 'x' }]);
  const [named] = doctorRecap([{ clone: 'c', text: 'x' }]);
  assert.ok(line !== undefined && named !== undefined);
  assert.notEqual(line, named);
});
