# Releasing: why it is a local command

`hangar dev release` derives the next version from the commit types since the last tag, bumps
`app/package.json`, regenerates `CHANGELOG.md`, commits both, tags, pushes, and makes the GitHub
release with `gh`. `app/CLAUDE.md`'s **Releasing** section is the how. This is the why.

## It replaced a workflow that had never cut anything

`.github/workflows/release.yml` ran semantic-release on every push to `main`, and it did not
work. The cause was not in the workflow:

```
$ git ls-remote origin
77381f43…  HEAD
77381f43…  refs/heads/main
```

**No tag had ever been pushed.** All fourteen existed only in one working copy. semantic-release
finding zero releases treats the next one as the first and publishes **1.0.0** — the exact outcome
the "no `!` and no `BREAKING CHANGE:` while the CLI is 0.x" rule exists to prevent, arrived at by
a route that rule never looked at. The same absence made every `compare/v0.12.0...v0.13.0` link in
`CHANGELOG.md` a 404, while the commit-SHA links beside them resolved.

That is now **a preflight check**: local tags and `git ls-remote --tags origin` must agree, or the
release refuses and names the missing ones. A tag that exists in one place and not the other means
two readers of the same commits compute different versions, which is the whole failure in one
sentence.

## Refuse, do not escalate

`conventional-changelog`'s `preMajor` option handles a breaking change below 1.0 by bumping one
level instead of the major — a `feat!` becomes a minor, a `fix!` a patch. That is a reasonable
default and the wrong one here: the bump then depends on what else happened to be in the range,
and it happens silently.

`nextVersion` throws instead, naming the commit that carries the marker. Cutting 1.0.0 is a
decision somebody makes; the way past the error is to reword the commit or to set the version by
hand and tag it deliberately. Past 1.0.0 the same function returns an ordinary major, so the
refusal is about 0.x specifically rather than about breaking changes.

## The release commit is hidden from its own changelog

The CHANGELOG is written **before** the tag. `dev/changelog.sh` passes `-k app/package.json`, so
the section that has no tag yet takes its version from the file just bumped, and the heading, the
date and the compare link all come out right from a tag that does not exist. Verified by running
it, not inferred.

The cost is that the release commit falls inside its own tag's range: regenerate the file
afterwards and a `Chores` line nobody wrote appears — the unexplainable one-line diff
`changelog.sh` was written to prevent in the first place.

`CHANGELOG_TYPES` carries `{ type: 'chore', scope: 'release', hidden: true }`, and two things about
it are fragile enough to be worth writing down. The preset's `findTypeEntry` uses `Array.find`, so
**the scoped entry only wins while it precedes the bare `chore` one** — `test/release-version.test.ts`
asserts that ordering. And it matches on the scope, so **`chore(release)` is a contract between
`commands/release.ts` and `rules.ts`**: rename the scope, or lose it while rewording the subject
into the house style, and the commit walks back into the section it is committing.

`pnpm changelog` producing zero diff at a released state is the check that all of this holds.

## Three probes, and what each answered

Run in a throwaway clone before any of it was designed, because the ordering above is the sort of
thing that reads as obviously-fine and is not.

| Probe | Answer |
| --- | --- |
| Bump `app/package.json`, then `changelog.sh`, with no tag for the new version | renders `## [0.14.0](…/compare/v0.13.0...v0.14.0) (2026-09-06)` correctly — so the changelog goes **before** the tag |
| `{ type: 'chore', scope: 'release', hidden: true }` ahead of the bare `chore` entry | the commit disappears from the regenerated file; behind it, nothing changes |
| A `.ts` preset importing another `.ts` module, loaded by `conventional-changelog-cli` | works, which is what let the tables leave `.releaserc.json` for `src/release/rules.ts` |

A fourth probe answered in the negative and changed the design. A `preinstall` script exiting 1 was
going to be the guard on the new hangar-root `package.json`, and **pnpm 10 does not run it** — not
even with a dependency present to install. `pnpm run preinstall` fires; `pnpm install` does not,
and npm skipped it too. The guard is `dev/scrub-check.sh` asserting the file's shape instead, and
`app/CLAUDE.md`'s package blockquote carries the reasoning.

## What enforcement looks like without CI

`.github/` is gone entirely. The husky hooks are fast feedback for whoever ran `pnpm hooks`, and
the release preflight is the place nothing can be skipped: typecheck, lint, format, the suite,
both scans, the golden gate and `commitlint` over the whole range, before a version moves.

Two details the deleted workflow was the only record of, now living in `commands/release.ts`:

- **commitlint needs `--config app/.commitlintrc.json`.** The config is in `app/`, the release
  runs from the hangar root because the git operations must, and a bare invocation errors on a
  missing config rather than linting anything.
- **`scan:secrets` fails rather than skips when gitleaks is absent.** `app/.husky/pre-commit`
  skips deliberately — a per-machine developer tool must not block a commit — and the workflow's
  `scan` job used to be the place that could not be skipped. A release cut without a history scan
  is a release nobody scanned, so this is that place now.

## Why `dev`, and what does not change

A release is only meaningful in a checkout of this repo, never in an operator's hangar — the same
contract `dev golden` has. So it is hidden, it gets **no row in `hangar-ops/reference/commands.md`**,
and `.claude/modes/ops.settings.json` denies `hangar dev` outright: operator mode has no business
cutting a release, and developer mode is the only one that can write that file.

`hangar doctor` gets no row for any of this either, for the reason it gets none for
`core.hooksPath`: every hangar root is a clone of this repo, but only a CLI developer ever releases
from one, and a row red forever in every operator's hangar is the check nobody reads.
