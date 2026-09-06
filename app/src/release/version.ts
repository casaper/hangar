/**
 * Working out what the next release is, as pure functions of the commit list.
 *
 * This is the half of `hangar dev release` that decides anything, kept away from the half that
 * moves git state so it can be asserted directly -- `test/release-version.test.ts` calls these
 * with commit lists that no repository has to be in. It is the same convention every text
 * builder in this CLI follows, for the same reason.
 */
import { CliError } from '../exec.ts';
import { RELEASE_RULES, type Bump } from './rules.ts';

/** A commit as `git log` hands it over, before anything has been read out of it. */
export type RawCommit = {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
};

export type ParsedCommit = RawCommit & {
  /** `undefined` when the subject is not a Conventional Commit at all. */
  readonly type: string | undefined;
  readonly scope: string | undefined;
  readonly breaking: boolean;
  /** The subject with its `type(scope):` prefix removed, or the whole subject if it had none. */
  readonly summary: string;
  /** `undefined` when this commit releases nothing -- `ci`, `chore`, `style`, or unparseable. */
  readonly bump: Bump | undefined;
};

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<subject>.*)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

/**
 * Read the type, scope and breaking marker out of one commit.
 *
 * A subject that does not parse is not an error here: `commitlint` is what refuses those, and it
 * runs over the same range before this is ever reached. An unparseable commit simply releases
 * nothing, which is the safe direction -- it can never quietly move the version.
 */
export const parseCommit = (raw: RawCommit): ParsedCommit => {
  const groups = HEADER.exec(raw.subject)?.groups;
  const type = groups?.['type'];
  const scope = groups?.['scope'];
  const breaking = groups?.['bang'] === '!' || BREAKING_FOOTER.test(raw.body);

  return {
    ...raw,
    type,
    scope: scope === undefined || scope === '' ? undefined : scope,
    breaking,
    summary: groups?.['subject'] ?? raw.subject,
    bump: type === undefined ? undefined : RELEASE_RULES[type],
  };
};

const RANK = { patch: 1, minor: 2, major: 3 } as const;

export type Version = { readonly major: number; readonly minor: number; readonly patch: number };

export const parseVersion = (v: string): Version => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (m === null) throw new CliError(`app/package.json has no plain x.y.z version: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
};

export const formatVersion = (v: Version): string => `${v.major}.${v.minor}.${v.patch}`;

export type NextRelease = {
  readonly version: string;
  readonly bump: Bump | 'major';
  /** One line per commit type that contributed, e.g. `1 feat`, `4 fix`. */
  readonly reasons: readonly string[];
};

/**
 * The next version, or `undefined` when nothing in the range releases anything.
 *
 * **A breaking change while the major is 0 is REFUSED, not escalated.** `conventional-changelog`
 * bumps one level instead (its `preMajor` option), which would turn a `feat!` here into 0.x+1
 * and a `fix!` into 0.x.y+1 -- quietly, and differently depending on what else was in the range.
 * This repo's rule is the other one: no `!` and no `BREAKING CHANGE:` footer while the CLI is
 * 0.x, because cutting 1.0.0 is a decision somebody makes rather than a side effect of a commit
 * message. So the marker is an error naming the commit that carries it, and the way past it is
 * to reword that commit or to decide on 1.0.0 deliberately.
 */
export const nextVersion = (
  current: string,
  commits: readonly ParsedCommit[],
): NextRelease | undefined => {
  const version = parseVersion(current);

  const breaking = commits.find((c) => c.breaking);
  if (breaking !== undefined && version.major === 0) {
    throw new CliError(
      `${breaking.sha} is marked as a breaking change, and this CLI is ${current}`,
      'Cutting 1.0.0 is a decision, not a commit message. Reword the commit to drop the `!`\n' +
        '       and the `BREAKING CHANGE:` footer, or set the version by hand and tag it.',
    );
  }

  const level = commits.reduce<0 | 1 | 2 | 3>((worst, c) => {
    const bump = c.breaking ? 'major' : c.bump;
    return bump === undefined ? worst : (Math.max(worst, RANK[bump]) as 0 | 1 | 2 | 3);
  }, 0);

  if (level === 0) return undefined;

  const counts = new Map<string, number>();
  for (const c of commits) {
    if (c.bump === undefined && !c.breaking) continue;
    const key = c.type ?? '(unconventional)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const reasons = [...counts].map(([type, n]) => `${n} ${type}`);

  if (level === RANK.major) {
    return {
      version: formatVersion({ major: version.major + 1, minor: 0, patch: 0 }),
      bump: 'major',
      reasons,
    };
  }
  if (level === RANK.minor) {
    return {
      version: formatVersion({ major: version.major, minor: version.minor + 1, patch: 0 }),
      bump: 'minor',
      reasons,
    };
  }
  return {
    version: formatVersion({ ...version, patch: version.patch + 1 }),
    bump: 'patch',
    reasons,
  };
};

export type ReleasePlan = {
  readonly from: string | undefined;
  readonly current: string;
  readonly next: NextRelease;
  readonly tag: string;
  readonly commits: readonly ParsedCommit[];
};

const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));

/**
 * The dry-run report, as a pure function of the plan.
 *
 * Exported and text-only so every variant can be read side by side without cutting a release to
 * see one -- the first release is the interesting case, and it is the one nobody can rehearse.
 */
export const releasePlanText = (plan: ReleasePlan): string => {
  const lines = [
    `  from      ${plan.from ?? '(no tag yet -- the whole history)'}`,
    `  current   ${plan.current}`,
    `  next      ${plan.next.version}   ${plan.next.bump}: ${plan.next.reasons.join(', ')}`,
    `  tag       ${plan.tag}`,
    '',
  ];

  const rows = plan.commits.map((c) => {
    const label = c.breaking ? 'BREAKING' : (c.bump ?? '-');
    return [
      label,
      c.sha,
      `${c.type ?? '?'}${c.scope === undefined ? '' : `(${c.scope})`}`,
      c.subject,
    ];
  });
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => (r[i] ?? '').length), 0));

  for (const r of rows) {
    lines.push(
      `  ${pad(r[0] ?? '', widths[0] ?? 0)}  ${pad(r[1] ?? '', widths[1] ?? 0)}  ` +
        `${pad(r[2] ?? '', widths[2] ?? 0)}  ${r[3] ?? ''}`,
    );
  }

  return lines.join('\n');
};
