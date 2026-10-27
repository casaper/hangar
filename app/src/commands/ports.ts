import pc from 'picocolors';

import { portClaims, readEnvLocalPorts, rewritePortArtifacts } from '../clone-config.ts';
import { CliError } from '../exec.ts';
import { cloneAt, discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { clearPortPin, setPortPin } from '../port-pins.ts';
import {
  describeCollision,
  planTake,
  portCollisions,
  portsFor,
  portSummary,
  roleUrl,
  slotOf,
  slotPorts,
  type ClonePorts,
} from '../ports.ts';
import { claudeSessionsIn, listenersOn, runningServersIn } from '../procs.ts';
import { cloneLabel, note, ok, table, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar ports` -- the fleet's whole port map in one place.
 *
 * The numbers come from each clone's `.env.local`, read directly. Do NOT get them by running
 * `node dev/ports.mjs` from the fleet root: a parent session has no direnv SessionStart hook,
 * so `.env.local` is never loaded and that script cheerfully reports clone_01's fallbacks
 * (4200 / 6006 / 9323) for every clone. Any disagreement with the index formula is a real
 * problem -- two clones on one port means a test run silently verifies the wrong code -- so
 * it is flagged rather than smoothed over.
 */
export type PortsOptions = { json?: boolean | undefined };

type Row = {
  clone: Clone;
  actual: Partial<Record<string, number>>;
  drift: string[];
};

const inspect = (hangar: Hangar): Row[] =>
  discoverClones(hangar).map((clone) => {
    const actual = readEnvLocalPorts(clone);
    const drift: string[] = [];
    for (const entry of clone.ports) {
      const key = entry.role.envKey;
      const found = actual[key];
      if (found === undefined) drift.push(`${key} missing from .env.local`);
      else if (found !== entry.port)
        drift.push(`${key} is ${String(found)}, formula says ${String(entry.port)}`);
    }
    return { clone, actual, drift };
  });

export const ports = (hangar: Hangar, opts: PortsOptions): void => {
  const rows = inspect(hangar);
  const anyPinned = rows.some((row) => row.clone.portsPinned);
  const hasSlots = hangar.config.ports.slots !== undefined;
  const slotCell = (clone: Clone): string => {
    const slot = slotOf(hangar, clone.ports);
    return slot === undefined ? '' : String(slot);
  };

  if (opts.json === true) {
    console.log(
      JSON.stringify(
        rows.map(({ clone, drift }) => ({
          clone: clone.name,
          index: clone.index,
          colour: clone.colour.name,
          pinned: clone.portsPinned,
          slot: slotOf(hangar, clone.ports) ?? null,
          ports: clone.ports.map((entry) => ({
            id: entry.role.id,
            envKey: entry.role.envKey,
            label: entry.role.label,
            port: entry.port,
            url: roleUrl(entry) ?? null,
          })),
          drift,
        })),
        null,
        2,
      ),
    );
    return;
  }

  // One column per configured role, labelled from the config. A hangar with no roles gets the
  // CLONE column alone, which is the honest rendering of "this hangar manages no ports".
  table([
    [
      pc.dim('CLONE'),
      ...hangar.config.ports.roles.map((role) => pc.dim(role.label)),
      ...(hasSlots ? [pc.dim('SLOT')] : []),
      ...(anyPinned ? [pc.dim('PINNED')] : []),
    ],
    ...rows.map(({ clone }) => [
      cloneLabel(clone),
      ...clone.ports.map((entry) => String(entry.port)),
      ...(hasSlots ? [slotCell(clone)] : []),
      ...(anyPinned ? [clone.portsPinned ? 'pinned' : ''] : []),
    ]),
  ]);

  const collisions = portCollisions(rows.map((row) => portClaims(row.clone)));
  for (const collision of collisions) warn(`two clones claim port ${describeCollision(collision)}`);
  if (anyPinned) {
    note(
      hasSlots
        ? 'A pinned clone is off its formula: swapped into or out of a slot by `hangar ports take`, or held through a layout change.'
        : 'A pinned clone keeps the ports it had before the layout changed; `hangar ports unpin <clone>` releases it to the formula.',
    );
  }

  const drifted = rows.filter((r) => r.drift.length > 0);
  if (drifted.length === 0) {
    note(
      anyPinned
        ? 'Every .env.local agrees with the index formula or its pin.'
        : 'Every .env.local agrees with the index formula.',
    );
    return;
  }
  for (const row of drifted) {
    for (const problem of row.drift) warn(`${row.clone.name}: ${problem}`);
  }
  note('Repair with `hangar doctor --fix`, then re-run `direnv allow` in that clone.');
};

export type PinOptions = { all?: boolean | undefined; dryRun?: boolean | undefined };

/**
 * `hangar ports pin` -- hold clones on the ports their `.env.local` names right now.
 *
 * The first half of moving a fleet to a new port layout without moving a busy clone: pin every
 * clone, then change `ports` in the config, and nothing derives a different port for any of them
 * -- not `doctor`, not `servers`, not the health-check allow or the identity file. The snapshot
 * is of the DOTENV rather than of the formula, because the dotenv is where the running dev server
 * actually is.
 *
 * All or nothing: a clone whose `.env.local` lacks a role is refused, and then nothing is written,
 * so `--all` never leaves half a fleet pinned with nothing saying which half.
 */
export const portsPin = (hangar: Hangar, refs: readonly string[], opts: PinOptions): void => {
  let targets: Clone[];
  if (opts.all === true) targets = discoverClones(hangar);
  else if (refs.length === 0)
    throw new CliError('ports pin needs a clone name, or --all', knownClonesHint(hangar));
  else {
    const byIndex = new Map<number, Clone>();
    for (const ref of refs) {
      const clone = requireClone(hangar, ref);
      byIndex.set(clone.index, clone);
    }
    targets = [...byIndex.values()].sort((a, b) => a.index - b.index);
  }

  const pins: { clone: Clone; pin: Map<string, number> }[] = [];
  const refused: string[] = [];
  for (const clone of targets) {
    const actual = readEnvLocalPorts(clone);
    const missing = hangar.config.ports.roles
      .map((role) => role.envKey)
      .filter((key) => actual[key] === undefined);
    if (missing.length > 0) {
      refused.push(`${clone.name}: ${missing.join(', ')} missing from its .env.local`);
      continue;
    }
    const pin = new Map<string, number>();
    for (const role of hangar.config.ports.roles) {
      const port = actual[role.envKey];
      if (port !== undefined) pin.set(role.envKey, port);
    }
    pins.push({ clone, pin });
  }
  if (refused.length > 0) {
    throw new CliError(
      `nothing pinned — a pin snapshots a complete .env.local:\n  ${refused.join('\n  ')}`,
      'Repair it with `hangar doctor <clone> --fix` first, or pin the other clones by name.',
    );
  }

  for (const { clone, pin } of pins) {
    const summary = [...pin.entries()].map(([key, port]) => `${key}=${String(port)}`).join(' ');
    if (opts.dryRun === true) note(`${clone.name}: would pin ${summary}`);
    else {
      setPortPin(hangar, clone.index, pin);
      ok(`${clone.name}: pinned ${summary}`);
    }
  }
};

export type UnpinOptions = { dryRun?: boolean | undefined };

/**
 * `hangar ports unpin <clone>` -- release one clone to the current formula.
 *
 * Only the pin: the clone's `.env.local`, its health-check allow and its `CLAUDE.local.md` still
 * name the old ports until `hangar doctor <clone> --fix` rewrites all three, which is the next
 * thing it says. It refuses when the formula would put the clone on a port a sibling still
 * holds -- two layouts coexist while clones are pinned, and the new one can land exactly on a
 * pinned sibling's port.
 */
export const portsUnpin = (hangar: Hangar, ref: string, opts: UnpinOptions): void => {
  const clone = requireClone(hangar, ref);
  if (!clone.portsPinned) {
    note(`${clone.name} is not pinned; its ports are the formula's (${portSummary(clone.ports)}).`);
    return;
  }
  const released = { name: clone.name, ports: portsFor(hangar, clone.index) };
  const others = discoverClones(hangar)
    .filter((c) => c.index !== clone.index)
    .map(portClaims);
  const contested = portCollisions([...others, released]).filter((collision) =>
    collision.claims.some((claim) => claim.clone === clone.name),
  );
  if (contested.length > 0) {
    throw new CliError(
      `${clone.name} stays pinned — the formula would put it on a port a sibling holds: ${contested.map(describeCollision).join('; ')}`,
      'Release that sibling first -- `hangar ports unpin` and then `hangar doctor --fix` on it -- so its ports move out of the way.',
    );
  }

  const moves = clone.ports.map((entry, i) => {
    const next = released.ports[i]?.port ?? entry.port;
    return `${entry.role.id} ${String(entry.port)} → ${String(next)}`;
  });
  if (opts.dryRun === true) {
    note(`${clone.name}: would unpin (${moves.join(' · ')})`);
    return;
  }
  clearPortPin(hangar, clone.index);
  ok(`${clone.name}: unpinned (${moves.join(' · ')})`);
  note(
    `Next: \`hangar doctor ${String(clone.index)} --fix\` rewrites its .env.local, health-check allow and CLAUDE.local.md; ` +
      `then restart that clone's servers, and \`hangar reload ${String(clone.index)}\` so its Claude session starts on the new ports.`,
  );
};

export type TakeOptions = { slot?: string | undefined; dryRun?: boolean | undefined };

/** `ng 4210 → 4201 · storybook 6110 → 6101` -- one clone's move, role by role. */
const describeMove = (from: ClonePorts, to: ClonePorts): string =>
  from
    .map(
      (entry, i) => `${entry.role.id} ${String(entry.port)} → ${String(to[i]?.port ?? entry.port)}`,
    )
    .join(' · ');

/**
 * `hangar ports take <clone>` -- move a clone onto an idle slot's ports, all roles at once.
 *
 * A SWAP, written as two pins, rather than a lease: every consumer of a clone's ports already
 * honours a pin, so nothing new derives a port, no clone is ever left without one, and the
 * collision net `doctor` runs covers a swap the same as a layout rollout. Swapping back is the
 * same command on the other clone, and two pins that land on their formulas leave no file.
 *
 * A clone's sessions re-read its `.env.local` on every Bash call, through the repo's own direnv
 * hook, but its `CLAUDE.local.md` was read once at startup and still names the old ports -- so
 * the holder's live session is warned about by name, and `reload` is the next step for both.
 */
export const portsTake = (hangar: Hangar, ref: string, opts: TakeOptions): void => {
  const taker = requireClone(hangar, ref);
  const wantSlot = opts.slot === undefined ? undefined : Number.parseInt(opts.slot, 10);
  if (wantSlot !== undefined && !Number.isInteger(wantSlot)) {
    throw new CliError(`--slot ${String(opts.slot)} is not a slot number`);
  }
  const clones = discoverClones(hangar);
  const slots = hangar.config.ports.slots ?? 0;

  const candidates = clones.filter(
    (clone) => clone.index === taker.index || slotOf(hangar, clone.ports) !== undefined,
  );
  const busyClones = new Set<string>();
  for (const clone of candidates) {
    const scan = runningServersIn(clone);
    if (!scan.portsChecked) {
      throw new CliError(
        'cannot tell which slots are idle — lsof did not run',
        'A take that guessed could move a clone out from under its own dev server.',
      );
    }
    if (scan.servers.length > 0) busyClones.add(clone.name);
  }
  const busySlots = new Set<number>();
  const slotList = Array.from({ length: slots }, (_, i) => i + 1);
  const listening = listenersOn(slotList.flatMap((s) => slotPorts(hangar, s).map((e) => e.port)));
  for (const slot of slotList) {
    if (slotPorts(hangar, slot).some((entry) => listening?.has(entry.port) === true)) {
      busySlots.add(slot);
    }
  }

  const plan = planTake(hangar, taker, clones, { clones: busyClones, slots: busySlots }, wantSlot);
  if ('refused' in plan)
    throw new CliError(`${taker.name} takes nothing — ${plan.refused}`, plan.hint);

  // The net behind the plan: what the moved clones will claim against what every other clone
  // derives AND still has written, which is the window a pin edited by hand can open.
  const moved = new Set(plan.moves.map((move) => move.clone.name));
  const contested = portCollisions([
    ...clones.filter((clone) => !moved.has(clone.name)).map(portClaims),
    ...plan.moves.map((move) => ({ name: move.clone.name, ports: move.to })),
  ]);
  if (contested.length > 0) {
    throw new CliError(
      `${taker.name} takes nothing — the swap would put two clones on one port: ${contested.map(describeCollision).join('; ')}`,
      'Run `hangar doctor` and repair the clone in the way first.',
    );
  }

  const lines = plan.moves.map(
    (move) => `${move.clone.name}: ${describeMove(move.clone.ports, move.to)}`,
  );
  const holderSessions =
    plan.holder === undefined ? [] : claudeSessionsIn(cloneAt(hangar, plan.holder.index).path);
  const sessionWarning =
    plan.holder !== undefined && holderSessions.length > 0
      ? `${plan.holder.name} has a live Claude session that still believes it holds slot ${String(plan.slot)}; its env follows .env.local, its CLAUDE.local.md does not until it restarts`
      : undefined;
  if (opts.dryRun === true) {
    note(`${taker.name} would take slot ${String(plan.slot)}:`);
    for (const line of lines) note(`  ${line}`);
    if (sessionWarning !== undefined) warn(sessionWarning);
    return;
  }

  for (const move of plan.moves) {
    if (move.pin === undefined) clearPortPin(hangar, move.clone.index);
    else setPortPin(hangar, move.clone.index, move.pin);
  }
  for (const move of plan.moves) rewritePortArtifacts(cloneAt(hangar, move.clone.index));

  ok(`${taker.name} took slot ${String(plan.slot)}`);
  for (const line of lines) note(`  ${line}`);
  if (sessionWarning !== undefined) warn(sessionWarning);
  const reloads = plan.moves.map((move) => String(move.clone.index)).join(' ');
  note(
    `Next: \`hangar reload ${reloads}\` so the sessions read their new ports, \`direnv allow\` in any pane that asks, ` +
      `then start ${taker.name}'s servers. Role bookmarks follow at the next \`hangar bookmarks sync\`.`,
  );
};
