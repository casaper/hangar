/**
 * The two tables a release is derived from, and the single authority for both.
 *
 * They used to live in `.releaserc.json`: `presetConfig.types` for the CHANGELOG sections and
 * `releaseRules` for which commit type moves which number. semantic-release read them there and
 * `changelog.preset.ts` parsed the same file to stay in step. Releases are cut locally now, so
 * the JSON is gone and both tables are here -- still ONE source, still read twice, but by the
 * two things that actually consume them: `changelog.preset.ts` imports `CHANGELOG_TYPES`, and
 * `release/version.ts` reads `RELEASE_RULES`.
 */

export type ChangelogType = {
  readonly type: string;
  /** Match only commits with this scope. Entries are searched in order, so put these first. */
  readonly scope?: string;
  readonly section?: string;
  readonly hidden?: boolean;
};

/**
 * The CHANGELOG's section list, in render order.
 *
 * It exists at all because the `conventionalcommits` preset hides everything but `feat`, `fix`
 * and `perf` by default, and for this history that is wrong rather than merely terse: with the
 * defaults, v0.11.0 -- the release that added the entire `node:test` suite -- rendered as a
 * heading with nothing under it, and v0.7.0, which added both skills and the mode pair, showed
 * one line. Documentation is a first-class change here.
 *
 * **The `chore(release)` entry is what keeps `pnpm changelog` reproducible, and its position is
 * load-bearing.** A release commit is made BEFORE its tag, so it falls inside its own tag's
 * range: without this entry, regenerating the file would add a `Chores` line nobody wrote, and
 * the next developer to run `pnpm changelog` would see a diff they could not explain. The
 * preset's `findTypeEntry` uses `Array.find`, so a scoped entry only wins while it precedes the
 * bare one -- and it only matches at all while the release commit really is scoped `release`.
 * `commands/release.ts` writes that subject; the two have to be changed together.
 */
export const CHANGELOG_TYPES: readonly ChangelogType[] = [
  { type: 'feat', section: 'Features' },
  { type: 'fix', section: 'Bug Fixes' },
  { type: 'perf', section: 'Performance' },
  { type: 'refactor', section: 'Refactoring' },
  { type: 'docs', section: 'Documentation' },
  { type: 'test', section: 'Tests' },
  { type: 'build', section: 'Build & Dependencies' },
  { type: 'ci', section: 'Continuous Integration' },
  { type: 'chore', scope: 'release', hidden: true },
  { type: 'chore', section: 'Chores' },
  { type: 'style', section: 'Styles' },
  { type: 'revert', section: 'Reverts' },
];

export type Bump = 'minor' | 'patch';

/**
 * Which commit type moves which number.
 *
 * Written out in full rather than as "these five, and everything else defaults", because
 * flattening two tables into one is exactly where drift enters unseen. `feat`, `fix`, `perf`
 * and `revert` are `@semantic-release/commit-analyzer`'s own defaults; `docs`, `refactor`,
 * `test` and `build` were this repo's four `releaseRules`, because a documentation commit here
 * is a real change -- the `hangar-internals` reference files are the regression record for the
 * two thirds of this CLI no test covers. `revert` is the one a casual "everything else is no
 * release" would silently demote from patch to nothing.
 *
 * A type absent from this table releases nothing: `ci`, `chore` and `style` by design, and any
 * type a future commitlint config adds, which is the safe direction to fail in.
 */
export const RELEASE_RULES: Readonly<Record<string, Bump>> = {
  feat: 'minor',
  fix: 'patch',
  perf: 'patch',
  revert: 'patch',
  docs: 'patch',
  refactor: 'patch',
  test: 'patch',
  build: 'patch',
};
