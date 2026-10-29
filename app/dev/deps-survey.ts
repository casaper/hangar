import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { parse as parseYaml } from 'yaml';

/**
 * `pnpm deps:survey` -- what a dependency sweep may take today, and when the rest may.
 *
 * Read-only: it asks the registry and `pnpm audit`, and changes nothing. Every sweep used to
 * rebuild these facts by hand, and each one has a way of answering wrongly that looks right:
 *
 * - The floor is `minimumReleaseAge` in `pnpm-workspace.yaml`, and pnpm applies it only to what
 *   it installs. The `packageManager` pin goes through corepack, which ignores it.
 * - The pick is per CURRENT MAJOR. Sorting by publish date is fooled by backport lines (an older
 *   major patched after the current one), and `pnpm outdated` compares only against `latest`.
 * - `@types/node` follows the runtime major in `.nvmrc`, not the registry's `latest`.
 * - TypeScript is capped by typescript-eslint's `typescript` peer, and pnpm installs across a
 *   violated peer with a warning only. The changelog preset is capped by the writer major
 *   release-notes-generator depends on, and the wrong one renders a malformed changelog rather
 *   than an error. `.claude/skills/hangar-deps/reference/holds.md` has why each hold exists.
 *
 * Everything below `gather` is pure and given its facts, so `test/deps-survey.test.ts` can
 * assert each of those without a network.
 */

// ---------------------------------------------------------------------------------------------
// Versions and ranges -- just enough semver for registry versions and peer ranges.

export type Version = readonly [number, number, number];

/** A stable `x.y.z`, or null for a prerelease or anything else. */
export const parseVersion = (text: string): Version | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export const compareVersions = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const partial = (text: string): { v: Version; given: number } | null => {
  const parts = text.replace(/^v/, '').split('.');
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break;
    nums.push(Number(part));
  }
  if (nums.length === 0) return null;
  return { v: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], given: nums.length };
};

const comparatorHolds = (v: Version, comparator: string): boolean => {
  if (comparator === '' || comparator === '*' || comparator === 'x') return true;
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(comparator);
  const p = m?.[2] === undefined ? null : partial(m[2]);
  if (!m || !p) return false;
  const c = compareVersions(v, p.v);
  const [major, minor] = p.v;
  switch (m[1]) {
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    case '^':
      return c >= 0 && (major > 0 ? v[0] === major : v[0] === 0 && v[1] === minor);
    case '~':
      return c >= 0 && v[0] === major && (p.given < 2 || v[1] === minor);
    default:
      // `=1.2.3`, `1.2.3`, or a partial `1` / `1.2` meaning that whole line.
      return p.given === 3 ? c === 0 : v[0] === major && (p.given < 2 || v[1] === minor);
  }
};

/** Whether `v` is in a range like `>=4.8.4 <6.1.0`, `^8.0.0` or `^5 || ^6`. */
export const satisfies = (v: Version, range: string): boolean =>
  range.split('||').some((set) =>
    set
      .trim()
      .replace(/([<>=~^]+)\s+/g, '$1')
      .split(/\s+/)
      .every((comparator) => comparatorHolds(v, comparator)),
  );

// ---------------------------------------------------------------------------------------------
// The floor and the pick.

export type Release = { version: string; published: Date };

/** Every stable release, oldest version first, from `npm view <pkg> time --json`. */
export const releasesFrom = (time: Readonly<Record<string, string>>): Release[] =>
  Object.entries(time)
    .flatMap(([version, at]) => {
      const v = parseVersion(version);
      return v ? [{ v, version, published: new Date(at) }] : [];
    })
    .sort((a, b) => compareVersions(a.v, b.v))
    .map(({ version, published }) => ({ version, published }));

export const floorCutoff = (now: Date, floorMinutes: number): Date =>
  new Date(now.getTime() - floorMinutes * 60_000);

export const clearsAt = (release: Release, floorMinutes: number): Date =>
  new Date(release.published.getTime() + floorMinutes * 60_000);

export type LinePick = {
  /** The newest release in the line, newer than current, that is past the floor. */
  take: Release | null;
  /** The next release in the line that is still inside the floor, newer than `take`. */
  waits: Release | null;
};

/**
 * Within one line: the newest release past the floor, and the next one still waiting.
 *
 * `inLine` is the line itself -- the current major, the `.nvmrc` major, a peer range -- so a
 * backport to an older major can never be picked however recently it was published.
 */
export const pickInLine = (
  releases: readonly Release[],
  current: string,
  cutoff: Date,
  inLine: (v: Version) => boolean,
): LinePick => {
  const cur = parseVersion(current);
  const newer = releases.filter((r) => {
    const v = parseVersion(r.version);
    return v !== null && inLine(v) && (cur === null || compareVersions(v, cur) > 0);
  });
  const past = newer.filter((r) => r.published <= cutoff);
  const take = past.at(-1) ?? null;
  const takeV = take ? parseVersion(take.version) : cur;
  const waits =
    newer.find((r) => {
      const v = parseVersion(r.version);
      return (
        r.published > cutoff && v !== null && (takeV === null || compareVersions(v, takeV) > 0)
      );
    }) ?? null;
  return { take, waits };
};

export const sameMajor =
  (major: number) =>
  (v: Version): boolean =>
    v[0] === major;

export const majorOf = (version: string): number | null => parseVersion(version)?.[0] ?? null;

/** The newest release past the floor in a major above `current`'s, if any. */
export const newerMajor = (
  releases: readonly Release[],
  current: string,
  cutoff: Date,
): Release | null => {
  const major = majorOf(current);
  if (major === null) return null;
  return (
    releases.filter((r) => (majorOf(r.version) ?? -1) > major && r.published <= cutoff).at(-1) ??
    null
  );
};

// ---------------------------------------------------------------------------------------------
// The report.

export type HoldStatus = {
  /** What would have to be true upstream for this hold to lift. */
  unblockedWhen: string;
  /** Measured today. */
  unblocked: boolean;
  evidence: string;
};

export type Row = {
  name: string;
  dev: boolean;
  /** The manifest's range, e.g. `^18.0.7` or `6.0.3`. */
  range: string;
  installed: string;
  pick: LinePick;
  /** A newer major past the floor that a sweep must ask about rather than take. */
  major: Release | null;
  /** Why this package's line is not simply its current major. */
  line?: string;
  hold?: HoldStatus;
};

export type AuditRow = {
  module: string;
  severity: string;
  installed: string;
  /** The lowest patched release in the installed major, or null when that major has none. */
  fix: Release | null;
};

export type Survey = {
  now: Date;
  floorMinutes: number;
  rows: Row[];
  audit: AuditRow[];
  /** Set when `pnpm audit` could not be read; the audit section then says so, never "clean". */
  auditError?: string;
};

const iso = (d: Date): string => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export const renderSurvey = (s: Survey): string => {
  const at = (r: Release): string =>
    clearsAt(r, s.floorMinutes) <= s.now
      ? 'past floor'
      : `clears ${iso(clearsAt(r, s.floorMinutes))}`;
  const name = (r: Row): string => `${r.name}${r.dev ? ' (dev)' : ''}`;
  const out: string[] = [
    `Floor ${s.floorMinutes / 1440} days: anything published before ${iso(floorCutoff(s.now, s.floorMinutes))} is takeable.`,
    '',
  ];

  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return;
    out.push(title, ...lines.map((l) => `  ${l}`), '');
  };

  section(
    'TAKE -- past the floor, inside the line; `pnpm add` each one',
    s.rows.flatMap((r) =>
      r.pick.take && !r.hold?.unblocked
        ? [
            `${name(r)} ${r.installed} -> ${r.pick.take.version}${r.range.startsWith('^') ? '  (range was a caret: put it back)' : ''}${r.line ? `  [${r.line}]` : ''}`,
          ]
        : [],
    ),
  );
  section(
    'WAITS -- the next release in the line, still inside the floor',
    s.rows.flatMap((r) =>
      r.pick.waits ? [`${name(r)} ${r.pick.waits.version} ${at(r.pick.waits)}`] : [],
    ),
  );
  section(
    'HELD -- a standing hold; see reference/holds.md',
    s.rows.flatMap((r) =>
      r.hold
        ? [
            `${name(r)} stays on its line: ${r.hold.unblocked ? 'UNBLOCKED -- stop and ask, this is a migration' : 'still blocked'}`,
            `    lifts when ${r.hold.unblockedWhen}`,
            `    measured: ${r.hold.evidence}`,
          ]
        : [],
    ),
  );
  section(
    'MAJOR AVAILABLE -- never taken in a sweep; ask',
    s.rows.flatMap((r) =>
      r.major && !r.hold
        ? [`${name(r)} ${r.installed} -> ${r.major.version}${r.line ? `  [${r.line}]` : ''}`]
        : [],
    ),
  );

  if (s.auditError !== undefined) {
    section('AUDIT -- could not be read', [s.auditError]);
  } else if (s.audit.length === 0) {
    section('AUDIT', ['no advisories']);
  } else {
    section(
      'AUDIT -- fixed by the transitive `pnpm update` once the fix is past the floor',
      s.audit.map((a) =>
        a.fix
          ? `${a.module} ${a.installed} (${a.severity}) -> ${a.fix.version} ${at(a.fix)}`
          : `${a.module} ${a.installed} (${a.severity}) -> no patched release in its major`,
      ),
    );
  }

  const current = s.rows.filter((r) => !r.pick.take && !r.pick.waits && !r.major && !r.hold);
  if (current.length > 0) section('CURRENT', [current.map(name).join(', ')]);

  return out.join('\n').trimEnd() + '\n';
};

// ---------------------------------------------------------------------------------------------
// Gathering -- the only impure part.

const run = promisify(execFile);

const json = async (cmd: string, args: string[], cwd: string): Promise<unknown> => {
  try {
    const { stdout } = await run(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout) as unknown;
  } catch (e) {
    // `pnpm audit` exits non-zero when it finds anything, with the JSON on stdout.
    const stdout = (e as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) return JSON.parse(stdout);
    throw e;
  }
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const strings = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value)).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );

const npmView = async (spec: string, field: string, cwd: string): Promise<unknown> =>
  json('npm', ['view', spec, field, '--json'], cwd);

/** typescript-eslint's `typescript` peer caps TypeScript; see reference/holds.md. */
const TS_PEER_HOST = 'typescript-eslint';
/** release-notes-generator's writer major caps the changelog preset. */
const WRITER_HOST = '@semantic-release/release-notes-generator';
const WRITER = 'conventional-changelog-writer';
/** Preset 10 is built on writer 9; the preset may move once the generator admits it. */
const WRITER_THE_PRESET_NEEDS: Version = [9, 0, 0];

const gather = async (app: string, now: Date): Promise<Survey> => {
  const workspace = record(parseYaml(readFileSync(join(app, 'pnpm-workspace.yaml'), 'utf8')));
  const floorMinutes = Number(workspace['minimumReleaseAge'] ?? 0);
  const cutoff = floorCutoff(now, floorMinutes);
  const manifest = record(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')));
  const nodeMajor = Number(readFileSync(join(app, '.nvmrc'), 'utf8').trim().replace(/^v/, ''));

  const listed = record(
    ((await json('pnpm', ['list', '--json', '--depth', '0'], app)) as unknown[])[0],
  );
  const installed = (dev: boolean): Record<string, string> =>
    Object.fromEntries(
      Object.entries(record(listed[dev ? 'devDependencies' : 'dependencies'])).map(([n, v]) => [
        n,
        String(record(v)['version']),
      ]),
    );

  const entries: { name: string; dev: boolean; range: string; installed: string }[] = [
    ...([false, true] as const).flatMap((dev) => {
      const have = installed(dev);
      return Object.entries(strings(manifest[dev ? 'devDependencies' : 'dependencies'])).map(
        ([name, range]) => ({
          name,
          dev,
          range,
          installed: have[name] ?? range.replace(/^\^|~/, ''),
        }),
      );
    }),
  ];
  const pin = /^pnpm@(.+)$/.exec(String(manifest['packageManager']))?.[1];
  if (pin) entries.push({ name: 'pnpm', dev: false, range: pin, installed: pin });

  const releases = new Map<string, Release[]>();
  await Promise.all(
    [...entries.map((e) => e.name), WRITER_HOST].map(async (name) => {
      releases.set(name, releasesFrom(strings(await npmView(name, 'time', app))));
    }),
  );
  const rel = (name: string): Release[] => releases.get(name) ?? [];

  const rows: Row[] = entries.map((e) => {
    const major = majorOf(e.installed) ?? 0;
    const row: Row = {
      ...e,
      pick: pickInLine(rel(e.name), e.installed, cutoff, sameMajor(major)),
      major: newerMajor(rel(e.name), e.installed, cutoff),
    };
    if (e.name === 'pnpm')
      row.line = 'packageManager pin: corepack ignores the floor, so edit it by hand';
    if (e.name === '@types/node') {
      row.line = `tracks .nvmrc's Node ${nodeMajor}`;
      row.pick = pickInLine(rel(e.name), e.installed, cutoff, sameMajor(nodeMajor));
      row.major = null;
    }
    return row;
  });

  // TypeScript: its line is whatever the typescript-eslint we would be on admits.
  const tsEslint = rows.find((r) => r.name === TS_PEER_HOST);
  const ts = rows.find((r) => r.name === 'typescript');
  if (tsEslint && ts) {
    const on = tsEslint.pick.take?.version ?? tsEslint.installed;
    const peer =
      strings(await npmView(`${TS_PEER_HOST}@${on}`, 'peerDependencies', app))['typescript'] ?? '*';
    const admitted = (v: Version): boolean => satisfies(v, peer);
    ts.pick = pickInLine(rel('typescript'), ts.installed, cutoff, admitted);
    ts.line = `${TS_PEER_HOST} ${on} peers typescript ${peer}`;
    const next = ts.major;
    ts.hold = {
      unblockedWhen: `a ${TS_PEER_HOST} past the floor peers a typescript range admitting the next major`,
      unblocked: next !== null && admitted(parseVersion(next.version) ?? [0, 0, 0]),
      evidence: `${TS_PEER_HOST} ${on} peers ${peer}; newest typescript major past the floor is ${next?.version ?? 'none'}`,
    };
  }

  // The changelog preset: capped by the writer major the release-notes generator depends on.
  const preset = rows.find((r) => r.name === 'conventional-changelog-conventionalcommits');
  if (preset) {
    const generator = rel(WRITER_HOST)
      .filter((r) => r.published <= cutoff)
      .at(-1)?.version;
    const writer = generator
      ? (strings(await npmView(`${WRITER_HOST}@${generator}`, 'dependencies', app))[WRITER] ?? '?')
      : '?';
    preset.hold = {
      unblockedWhen: `${WRITER_HOST} depends on ${WRITER} 9 (and .releaserc.json moves to the effect schema)`,
      unblocked: satisfies(WRITER_THE_PRESET_NEEDS, writer),
      evidence: `${WRITER_HOST} ${generator ?? '?'} depends on ${WRITER} ${writer}`,
    };
  }
  const cli = rows.find((r) => r.name === 'conventional-changelog-cli');
  if (cli) {
    cli.hold = {
      unblockedWhen: 'the changelog preset hold lifts; the deprecated CLI goes with that migration',
      unblocked: preset?.hold?.unblocked ?? false,
      evidence: 'deprecated upstream; kept only because the preset hold keeps writer 8',
    };
  }

  // The audit: per installed version, the lowest patched release in that same major.
  const survey: Survey = { now, floorMinutes, rows, audit: [] };
  try {
    const report = record(await json('pnpm', ['audit', '--json'], app));
    // One installed version often carries several advisories; it is one row, at its worst.
    const rank = ['info', 'low', 'moderate', 'high', 'critical'];
    const byInstalled = new Map<string, AuditRow & { patched: string[] }>();
    for (const adv of Object.values(record(report['advisories']))) {
      const a = record(adv);
      const module = String(a['module_name']);
      const severity = String(a['severity']);
      for (const finding of Array.isArray(a['findings']) ? a['findings'] : []) {
        const installed = String(record(finding)['version']);
        const key = `${module}@${installed}`;
        const row = byInstalled.get(key) ?? { module, severity, installed, fix: null, patched: [] };
        if (rank.indexOf(severity) > rank.indexOf(row.severity)) row.severity = severity;
        row.patched.push(String(a['patched_versions']));
        byInstalled.set(key, row);
      }
    }
    for (const row of byInstalled.values()) {
      if (!releases.has(row.module)) {
        releases.set(row.module, releasesFrom(strings(await npmView(row.module, 'time', app))));
      }
      const major = majorOf(row.installed);
      row.fix =
        rel(row.module).find((r) => {
          const v = parseVersion(r.version);
          return v !== null && v[0] === major && row.patched.every((p) => satisfies(v, p));
        }) ?? null;
      survey.audit.push({
        module: row.module,
        severity: row.severity,
        installed: row.installed,
        fix: row.fix,
      });
    }
    survey.audit.sort(
      (x, y) => x.module.localeCompare(y.module) || x.installed.localeCompare(y.installed),
    );
  } catch (e) {
    survey.auditError = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
  }
  return survey;
};

// Run when executed, not when the test suite imports the pure half.
if (process.argv[1] === import.meta.filename) {
  const app = join(import.meta.dirname, '..');
  process.stdout.write(renderSurvey(await gather(app, new Date())));
}
