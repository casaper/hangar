import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { freeIndexOffEveryPort } from '../src/commands/add-clone.ts';
import { discoverClones } from '../src/fleet.ts';
import { setPortPin } from '../src/port-pins.ts';
import {
  planTake,
  portCollisions,
  portsFor,
  slotOf,
  slotPorts,
  strandedBy,
  type PortMove,
  type SlotClone,
  type TakePlan,
  type TakeRefusal,
} from '../src/ports.ts';
import { fixtureConfigText, syntheticHangar } from './fixture.ts';

/**
 * Slots: `hangar ports take` swapping a clone onto an idle slot's ports.
 *
 * Properties, never bytes -- what matters is which slot is chosen, that a swap never lands two
 * clones on one port, and that swapping back leaves no pin. The fixture declares two slots and
 * has three clones, so clone 3 is the clone outside them.
 */

const hangar = syntheticHangar();
const NONE = { clones: new Set<string>(), slots: new Set<number>() };

const at = (index: number, ports = portsFor(hangar, index)): SlotClone => ({
  name: `wt-${String(index).padStart(3, '0')}`,
  index,
  ports,
});

const plan = (result: TakePlan | TakeRefusal): TakePlan => {
  if ('refused' in result) assert.fail(`refused: ${result.refused}`);
  return result;
};

/** The fleet after a plan is applied. */
const apply = (clones: readonly SlotClone[], moves: readonly PortMove[]): SlotClone[] =>
  clones.map((clone) => {
    const move = moves.find((m) => m.clone.name === clone.name);
    return move === undefined ? clone : { ...clone, ports: move.to };
  });

const fleet = [at(1), at(2), at(3)];

test('a clone outside the slots takes the lowest idle one, and its holder takes its ports', () => {
  const result = plan(planTake(hangar, at(3), fleet, NONE));
  assert.equal(result.slot, 1);
  assert.equal(result.holder?.name, 'wt-001');
  const after = apply(fleet, result.moves);
  assert.equal(slotOf(hangar, after[2]?.ports ?? []), 1);
  assert.deepEqual(after[0]?.ports, portsFor(hangar, 3));
  assert.equal(portCollisions(after).length, 0);
  // Both are off their formulas, so both carry a pin naming every role.
  for (const move of result.moves) assert.equal(move.pin?.size, move.to.length);
});

test('a slot whose holder is serving, or whose ports something listens on, is skipped', () => {
  const busyHolder = { clones: new Set(['wt-001']), slots: new Set<number>() };
  assert.equal(plan(planTake(hangar, at(3), fleet, busyHolder)).slot, 2);
  const busyPort = { clones: new Set<string>(), slots: new Set([1]) };
  assert.equal(plan(planTake(hangar, at(3), fleet, busyPort)).slot, 2);
});

test('it refuses rather than guessing: no free slot, a serving taker, a taker already in one', () => {
  const allBusy = { clones: new Set(['wt-001', 'wt-002']), slots: new Set<number>() };
  const none = planTake(hangar, at(3), fleet, allBusy);
  assert.ok('refused' in none && none.refused.includes('no slot is free'));

  const serving = planTake(hangar, at(3), fleet, { ...NONE, clones: new Set(['wt-003']) });
  assert.ok('refused' in serving && serving.refused.includes('serving'));

  const home = planTake(hangar, at(1), fleet, NONE);
  assert.ok('refused' in home && home.refused.includes('already holds slot 1'));

  const nowhere = planTake(hangar, at(3), fleet, NONE, 3);
  assert.ok('refused' in nowhere && nowhere.refused.includes('no slot 3'));
});

test('a hangar with no slots refuses and names the key', () => {
  const bare = syntheticHangar({
    configText: fixtureConfigText().replace(/\n {2}slots: \d+\n/, '\n'),
  });
  assert.equal(bare.config.ports.slots, undefined);
  const result = planTake(bare, at(3), fleet, NONE);
  assert.ok('refused' in result && result.hint?.includes('ports.slots') === true);
});

test('taking the home slot back swaps both clones onto their formulas, with no pin left', () => {
  const swapped = apply(fleet, plan(planTake(hangar, at(3), fleet, NONE)).moves);
  const back = plan(planTake(hangar, swapped[0] ?? at(1), swapped, NONE));
  assert.equal(back.slot, 1);
  for (const move of back.moves) assert.equal(move.pin, undefined, move.clone.name);
  assert.deepEqual(apply(swapped, back.moves), fleet);
});

test('a chain of takes never puts two clones on one port', () => {
  // 3 takes slot 1, then 2 takes slot 1 from 3: 3's home is held by 1, so 3 lands on 2's.
  let clones = apply(fleet, plan(planTake(hangar, at(3), fleet, NONE)).moves);
  const second = plan(planTake(hangar, clones[1] ?? at(2), clones, NONE, 1));
  clones = apply(clones, second.moves);
  assert.equal(portCollisions(clones).length, 0);
  assert.equal(slotOf(hangar, clones[1]?.ports ?? []), 1);
  assert.equal(slotOf(hangar, clones[2]?.ports ?? []), 2);
});

test('a holder goes home when nothing else claims its formula', () => {
  // 3 holds slot 1 and 1 sits on 3's formula; 1 retakes slot 1, so 3's formula is free again.
  const swapped = apply(fleet, plan(planTake(hangar, at(3), fleet, NONE)).moves);
  const back = plan(planTake(hangar, swapped[0] ?? at(1), swapped, NONE));
  assert.deepEqual(back.moves[1]?.to, portsFor(hangar, 3));
});

test('removing a taker names the clone it left on its formula, and only when that can go home', () => {
  const swapped = apply(fleet, plan(planTake(hangar, at(3), fleet, NONE)).moves);
  const remaining = swapped.filter((clone) => clone.index !== 3);
  assert.equal(strandedBy(hangar, at(3), remaining)?.name, 'wt-001');
  // Removing the HOLDER instead: the taker sits on its slot on purpose and stays there.
  assert.equal(
    strandedBy(
      hangar,
      at(1),
      swapped.filter((clone) => clone.index !== 1),
    ),
    undefined,
  );
  // Nobody swapped: nothing is stranded.
  assert.equal(strandedBy(hangar, at(3), [at(1), at(2)]), undefined);
  // Its home claimed by another: it stays where it is.
  const blocked = [{ ...at(2), ports: slotPorts(hangar, 1) }, swapped[0] ?? at(1)];
  assert.equal(strandedBy(hangar, at(3), blocked), undefined);
});

test('add-clone skips an index whose formula ports an existing clone holds', () => {
  const root = mkdtempSync(join(tmpdir(), 'hangar-slots-'));
  try {
    const h = syntheticHangar({ root });
    for (const name of ['wt-001', 'wt-002', 'wt-004']) mkdirSync(join(root, name));
    // Clone 4 was swapped onto clone 3's formula; index 3 is free on disk but not on the wire.
    setPortPin(h, 4, new Map(portsFor(h, 3).map((entry) => [entry.role.envKey, entry.port])));
    assert.equal(freeIndexOffEveryPort(h, discoverClones(h)), 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
