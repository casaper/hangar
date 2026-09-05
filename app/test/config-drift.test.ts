import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configDrift, exampleIsOwnRecord } from '../src/config/drift.ts';
import { parseConfigText } from '../src/config/load.ts';
import { first, fixtureConfigText } from './fixture.ts';

/**
 * The example-vs-live comparison, which `hangar-internals` stated as an invariant and nothing ran.
 *
 * `hangar.config.yaml` is gitignored and `hangar.config.example.yaml` is the only committed
 * record of it, so the example is what a colleague copies to join a fleet somebody has already
 * configured. The two had drifted by one line -- `forge.defaultBranch`, `master` live and `main`
 * in the example -- and that single line pointed `checkout-default`, `open`'s fast-forward and
 * `sync`'s fallback at a branch this repo does not have.
 *
 * Asserted as properties, not against either real file: pinning the real pair here would make
 * this suite fail on every legitimate config edit, and `config validate` already reports the
 * live pair on demand.
 */

const withEdit = (edit: (lines: string[]) => void): ReturnType<typeof parseConfigText> => {
  const lines = fixtureConfigText().split('\n');
  edit(lines);
  return parseConfigText(lines.join('\n'), 'a drift test');
};

const base = () => parseConfigText(fixtureConfigText(), 'a drift test');

test('a config does not drift from itself', () => {
  assert.deepEqual(configDrift(base(), base()), []);
});

test('one changed scalar is reported by DOTTED PATH, with both values', () => {
  const example = withEdit((lines) => {
    const i = lines.findIndex((l) => l.trimStart().startsWith('defaultBranch:'));
    assert.notEqual(i, -1, 'the fixture must pin a defaultBranch for this test to mean anything');
    lines[i] = '  defaultBranch: some-other-branch';
  });

  const drift = configDrift(base(), example);
  assert.equal(drift.length, 1);
  const only = first(drift, 'drift entry');
  assert.equal(only.path, 'forge.defaultBranch');
  assert.equal(only.example, 'some-other-branch');
  assert.notEqual(only.live, only.example);
});

test('the free-text `_` note is excluded — it differs on purpose', () => {
  const example = withEdit((lines) => {
    lines.unshift("_: 'a completely different note'");
  });
  assert.deepEqual(configDrift(base(), example), []);
});

test('a value left to its DEFAULT on one side matches one written out on the other', () => {
  // The reason the invariant is phrased over `config show` rather than over file text: the
  // example documents keys the live file deletes as unused, and that is agreement, not drift.
  const live = parseConfigText(fixtureConfigText().replace(/^ {2}mode: .*$/m, ''), 'a drift test');
  const modeDrift = configDrift(live, base()).filter((d) => d.path === 'secrets.mode');
  // The fixture pins a non-default mode, so removing the line SHOULD drift -- and the reported
  // pair must be the DEFAULT against the fixture's value, never the two raw lines.
  assert.equal(modeDrift.length, 1);
  const mode = first(modeDrift, 'drift entry');
  assert.equal(mode.live, '600');
  assert.equal(mode.example, '640');
});

test('the id gate is what keeps this check quiet in a hangar it was not written for', () => {
  // Without it, every hangar but the one shipping the example would be permanently red -- the
  // failure mode `hangar-internals` names three times: a check that is red in normal operation
  // is a check nobody reads.
  const other = withEdit((lines) => {
    const i = lines.findIndex((l) => l.startsWith('id:'));
    assert.notEqual(i, -1);
    lines[i] = 'id: someone_elses';
  });
  assert.equal(exampleIsOwnRecord(base(), base()), true);
  assert.equal(exampleIsOwnRecord(base(), other), false);
});
