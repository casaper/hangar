import type { PortRole } from './config/schema.ts';
import type { Hangar } from './hangar.ts';

/**
 * Per-clone port assignment.
 *
 * Two clones sharing a dev server means a test run in one silently verifies the other's code --
 * the single worst failure a hangar can produce. So the ports are a pure function of the clone
 * index rather than something a human types into a dotenv file, and `hangar doctor` checks the
 * file still agrees with the formula. The one input beside the index is the clone's pin, which
 * a layout rollout or a slot swap (`hangar ports take`) writes, and which `portsFor` is handed.
 *
 * The roles come from `ports.roles[]` in the config, in the order written there. They used to be
 * a CLOSED UNION of three names -- `ng`, `storybook`, `playwrightReport` -- with their bases
 * frozen beside it, which is why a hangar for a repo that serves anything else could not express
 * its ports at all. Opening it is what made `tsc` enumerate all 42 places that spelled a role by
 * name, and under this package's `noUncheckedIndexedAccess` and
 * `noPropertyAccessFromIndexSignature` it refused to compile until each one had decided what to
 * do about a role that may not exist. With no test suite, that enumeration was worth more than
 * any diff.
 *
 * `offset` is the per-hangar residue class, and it is the whole reason two hangars can coexist:
 * distinct offsets put them in different classes mod `step`, so a same-role collision is
 * impossible for ANY clone counts. `offset: 0` keeps this hangar exactly where it was.
 */
export type ClonePort = {
  readonly role: PortRole;
  readonly port: number;
};

/**
 * A clone's ports, ordered as the config lists the roles.
 *
 * A LIST, not a record keyed by role id, and deliberately: almost every consumer prints all of
 * them in order, and a record under `noUncheckedIndexedAccess` makes each lookup
 * `number | undefined` — which would spread an impossible case through nine files. Lookup by id
 * is the rare path and has `portForRole` for it.
 */
export type ClonePorts = readonly ClonePort[];

/**
 * The ports a clone index (1-based) owns in this hangar.
 *
 * `pin` is the clone's entry in `.hangar/port-pins.json`, passed in rather than read here so this
 * stays a pure function of its arguments: a pinned role keeps the port it was snapshotted on, and
 * every other role takes the formula. `makeClone` is the one caller that reads the file.
 */
export const portsFor = (
  hangar: Hangar,
  index: number,
  pin?: ReadonlyMap<string, number>,
): ClonePorts => {
  const { roles, step, offset } = hangar.config.ports;
  return roles.map((role) => ({
    role,
    port: pin?.get(role.envKey) ?? role.base + offset + (index - 1) * step,
  }));
};

/** One port two or more clones claim, and which clones and roles claim it. */
export type PortCollision = {
  readonly port: number;
  readonly claims: readonly { readonly clone: string; readonly role: string }[];
};

/**
 * Every port claimed more than once across the given clones.
 *
 * The schema proves a single layout collision-free, but while pinned clones keep an earlier
 * layout two layouts coexist and nothing static can: a clone released onto the new layout can
 * land exactly on a port a still-pinned sibling holds. Two clones on one port means a test run in
 * one verifies the other's code, so this is checked over the clones that EXIST, every time.
 */
export const portCollisions = (
  clones: readonly { readonly name: string; readonly ports: ClonePorts }[],
): PortCollision[] => {
  const byPort = new Map<number, { clone: string; role: string }[]>();
  for (const clone of clones) {
    for (const entry of clone.ports) {
      const claims = byPort.get(entry.port) ?? [];
      // One clone claiming a port twice -- derived and written agreeing -- is not a collision.
      if (!claims.some((claim) => claim.clone === clone.name && claim.role === entry.role.id))
        claims.push({ clone: clone.name, role: entry.role.id });
      byPort.set(entry.port, claims);
    }
  }
  return [...byPort.entries()]
    .filter(([, claims]) => new Set(claims.map((claim) => claim.clone)).size > 1)
    .sort(([a], [b]) => a - b)
    .map(([port, claims]) => ({ port, claims }));
};

/** `4300 (clone_02 storybook, clone_06 ng)` -- one collision as `doctor` and `ports` print it. */
export const describeCollision = (collision: PortCollision): string =>
  `${String(collision.port)} (${collision.claims.map((c) => `${c.clone} ${c.role}`).join(', ')})`;

/** One role's port, or undefined when this hangar declares no such role. */
export const portForRole = (ports: ClonePorts, roleId: string): number | undefined =>
  ports.find((entry) => entry.role.id === roleId)?.port;

/**
 * The URL for a port, or undefined for a role that has none.
 *
 * `{port}` is the one token this renders. It is a per-role template rather than a hardcoded
 * `http://localhost:` so a role can be a database, a socket, or anything else a URL does not
 * describe -- `url: null` says so.
 */
export const roleUrl = (entry: ClonePort): string | undefined =>
  entry.role.url === null ? undefined : entry.role.url.replace('{port}', String(entry.port));

/** `ng 4300 · storybook 6106 · playwright 9423` -- the one-line form `status` and `open` print. */
export const portSummary = (ports: ClonePorts): string =>
  ports.map((entry) => `${entry.role.id} ${String(entry.port)}`).join(' · ');

/**
 * Slot `k`'s ports: clone k's formula, whoever holds them now.
 *
 * Slots exist because something outside the hangar allows ports BY NAME -- an identity provider's
 * redirect hosts -- and that list stops at however many clones it was told about. A clone past it
 * borrows an idle slot with `hangar ports take` rather than the list growing with the fleet.
 */
export const slotPorts = (hangar: Hangar, slot: number): ClonePorts => portsFor(hangar, slot);

const samePorts = (a: ClonePorts, b: ClonePorts): boolean =>
  a.length === b.length && a.every((entry, i) => entry.port === b[i]?.port);

/** Which slot a port set is EXACTLY -- every role -- or undefined. */
export const slotOf = (hangar: Hangar, ports: ClonePorts): number | undefined => {
  const slots = hangar.config.ports.slots ?? 0;
  for (let slot = 1; slot <= slots; slot += 1) {
    if (samePorts(ports, slotPorts(hangar, slot))) return slot;
  }
  return undefined;
};

/**
 * The pin that puts clone `index` on `ports`: undefined when those ARE its formula, so a swap
 * back leaves no bookkeeping behind and a fleet with nothing borrowed has no pin file at all.
 */
export const pinFor = (
  hangar: Hangar,
  index: number,
  ports: ClonePorts,
): ReadonlyMap<string, number> | undefined =>
  samePorts(ports, portsFor(hangar, index))
    ? undefined
    : new Map(ports.map((entry) => [entry.role.envKey, entry.port]));

/** What `planTake` needs of a clone: its identity and the ports it derives now. */
export type SlotClone = {
  readonly name: string;
  readonly index: number;
  readonly ports: ClonePorts;
};

export type PortMove = {
  readonly clone: SlotClone;
  readonly to: ClonePorts;
  readonly pin: ReadonlyMap<string, number> | undefined;
};

export type TakePlan = {
  readonly slot: number;
  /** The clone swapped out of the slot; undefined when nobody held it (a removed clone's slot). */
  readonly holder: SlotClone | undefined;
  /** The taker's move first, then the holder's. */
  readonly moves: readonly PortMove[];
};

export type TakeRefusal = { readonly refused: string; readonly hint?: string };

/**
 * Which slot `taker` should take, and where its holder goes. PURE -- what is running is handed in.
 *
 * Preference: `wantSlot` when given, else the taker's own home slot, else the lowest. A slot is
 * free when nothing listens on its ports and its holder runs nothing; a holder with only a live
 * Claude session is NOT busy, because idle prompt context is what fills the slots this exists for.
 *
 * The holder goes HOME when nobody else claims its formula ports -- so a chain of borrowings
 * unwinds instead of every clone drifting further off its formula -- and otherwise onto the
 * ports the taker leaves. Every move is a whole port set: a slot is all of a clone's roles at
 * once, because what allows the ports by name allows every role's.
 */
export const planTake = (
  hangar: Hangar,
  taker: SlotClone,
  clones: readonly SlotClone[],
  busy: { readonly clones: ReadonlySet<string>; readonly slots: ReadonlySet<number> },
  wantSlot?: number,
): TakePlan | TakeRefusal => {
  const slots = hangar.config.ports.slots;
  if (slots === undefined) {
    return {
      refused: 'this hangar declares no slots',
      hint: 'Set `ports.slots` in hangar.config.yaml to how many clones the outside allow-list names.',
    };
  }
  if (wantSlot !== undefined && (wantSlot < 1 || wantSlot > slots)) {
    return { refused: `there is no slot ${String(wantSlot)}; slots are 1-${String(slots)}` };
  }
  const current = slotOf(hangar, taker.ports);
  if (current !== undefined && (wantSlot === undefined || wantSlot === current)) {
    return { refused: `${taker.name} already holds slot ${String(current)}` };
  }
  if (busy.clones.has(taker.name)) {
    return {
      refused: `${taker.name} is serving, and taking a slot moves every one of its ports`,
      hint: `Stop its servers first (\`hangar servers kill ${String(taker.index)}\`).`,
    };
  }

  const others = clones.filter((clone) => clone.name !== taker.name);
  const holderOf = (slot: number): SlotClone | undefined =>
    others.find((clone) => samePorts(clone.ports, slotPorts(hangar, slot)));
  const whyBusy = (slot: number): string | undefined => {
    const holder = holderOf(slot);
    if (holder !== undefined && busy.clones.has(holder.name)) return `${holder.name} is serving`;
    if (busy.slots.has(slot)) return 'something is listening on its ports';
    return undefined;
  };

  const home = taker.index <= slots ? [taker.index] : [];
  const order =
    wantSlot !== undefined
      ? [wantSlot]
      : [
          ...home,
          ...Array.from({ length: slots }, (_, i) => i + 1).filter((s) => s !== taker.index),
        ];
  const slot = order.find((s) => s !== current && whyBusy(s) === undefined);
  if (slot === undefined) {
    return {
      refused: `no slot is free — ${order
        .filter((s) => s !== current)
        .map((s) => `slot ${String(s)}: ${whyBusy(s) ?? 'held'}`)
        .join('; ')}`,
      hint: 'Stop the servers in a clone you are not using, then take its slot.',
    };
  }

  const to = slotPorts(hangar, slot);
  const holder = holderOf(slot);
  const moves: PortMove[] = [{ clone: taker, to, pin: pinFor(hangar, taker.index, to) }];
  if (holder !== undefined) {
    const formula = portsFor(hangar, holder.index);
    const formulaPorts = new Set(formula.map((entry) => entry.port));
    const homeFree =
      !formula.some((entry) => to.some((t) => t.port === entry.port)) &&
      !others.some(
        (clone) =>
          clone.name !== holder.name && clone.ports.some((entry) => formulaPorts.has(entry.port)),
      );
    const dest = homeFree ? formula : taker.ports;
    moves.push({ clone: holder, to: dest, pin: pinFor(hangar, holder.index, dest) });
  }
  return { slot, holder, moves };
};

/**
 * The clone a removed one leaves off its formula: the one sitting on the removed clone's formula
 * ports, swapped there by a `take`. Undefined when nobody is, or when that clone's own formula is
 * claimed by anybody that remains -- then it stays where it is, and the pin keeps saying so.
 *
 * Releasing it matters beyond tidiness: `add-clone` reuses the removed index, and its formula is
 * exactly the ports this clone holds.
 */
export const strandedBy = (
  hangar: Hangar,
  removed: SlotClone,
  remaining: readonly SlotClone[],
): SlotClone | undefined => {
  const vacated = portsFor(hangar, removed.index);
  // A removed HOLDER's formula is a slot, and whoever sits on it took it on purpose.
  if (slotOf(hangar, vacated) !== undefined) return undefined;
  const partner = remaining.find(
    (clone) => clone.name !== removed.name && samePorts(clone.ports, vacated),
  );
  if (partner === undefined) return undefined;
  const home = new Set(portsFor(hangar, partner.index).map((entry) => entry.port));
  const claimed = remaining.some(
    (clone) =>
      clone.name !== removed.name &&
      clone.name !== partner.name &&
      clone.ports.some((entry) => home.has(entry.port)),
  );
  return claimed ? undefined : partner;
};
