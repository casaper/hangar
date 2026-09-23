import type { PortRole } from './config/schema.ts';
import type { Hangar } from './hangar.ts';

/**
 * Per-clone port assignment.
 *
 * Two clones sharing a dev server means a test run in one silently verifies the other's code --
 * the single worst failure a hangar can produce. So the ports are a pure function of the clone
 * index rather than something a human types into a dotenv file, and `hangar doctor` checks the
 * file still agrees with the formula.
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
