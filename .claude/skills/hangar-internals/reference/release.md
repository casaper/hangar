# Releasing: semantic-release, run locally, behind this repo's gates

`pnpm release` is `hangar dev release`. It runs every gate this repo has, then hands over to
**semantic-release**, which does the release itself from `.releaserc.json`: the version from the
commit types, the CHANGELOG, the bump, the release commit, the tag, the push and the GitHub
release. `app/CLAUDE.md`'s **Releasing** section is the how. This is the why.

## The workflow did not fail because of semantic-release

`.github/workflows/release.yml` ran the same tool on every push to `main`, and it had never cut
anything. The cause was not in the workflow and not in the tool:

```
$ git ls-remote origin
77381f43…  HEAD
77381f43…  refs/heads/main
```

**No tag had ever been pushed.** All fourteen existed only in one working copy, and
`actions/checkout` fetches refs — there was nothing to fetch. semantic-release finding zero
releases treats the next one as the first and publishes **1.0.0**, the exact outcome the "no `!`
and no `BREAKING CHANGE:` while the CLI is 0.x" rule exists to prevent, reached by a route that
rule never looked at. The same absence made every `compare/v0.12.0...v0.13.0` link in
`CHANGELOG.md` a 404 while the commit-SHA links beside them resolved.

**Run from a developer's machine, the same tool gets the right answer** — the local tags are
there — which is why moving it here fixed it rather than merely relocating it. Measured, not
assumed: `semantic-release --dry-run --no-ci` in a throwaway clone answers `The next release
version is 0.14.0`.

That is now a preflight check as well: local tags and `git ls-remote --tags origin` must agree, or
the release refuses and names the missing ones. A tag in one place and not the other means two
readers of the same commits compute different versions, which is the whole failure in a sentence.

## What the command adds, and why each piece is not semantic-release's job

- **The preflight.** Branch, clean tree, up to date, a token, the tag check. semantic-release
  checks some of this itself, but as `verifyConditions` failures partway through a pipeline that
  has already printed forty lines. Each of these is one sentence before anything starts.
- **The breaking-change refusal.** semantic-release has **no setting** for "never cut a major".
  `preMajor` in the changelog preset escalates one level instead, which is a different behaviour
  and not one that stops anything. So `release/commits.ts` finds every `!` and every
  `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer in the range, and the release stops while
  `app/package.json` is still `0.x`. `test/release-commits.test.ts` pins both spellings and the
  bang, because missing one IS the failure — this gate is worth exactly what its parser catches.
- **The gates.** There is no CI. This is the only place typecheck, lint, format, the suite, both
  scans, the golden gate and `commitlint` all have to pass.
- **The confirmation.** The next thing that happens is a push to a published repository.

**`--no-ci` is not a weakening.** Without it semantic-release detects no CI environment and
refuses to run at all; with it, the branch check, the up-to-date check and the whole
`verifyConditions` pipeline still run. It says "a human is doing this", nothing else.

**It does not compute a version, deliberately.** An earlier draft of this command did, with its
own `RELEASE_RULES` table. That is two tables that must agree — the drift this repo keeps finding
— so it was deleted. `.releaserc.json` is the only thing that decides a version.

## The release commit is hidden from its own changelog

`@semantic-release/git` writes `chore(release): <version>` **before** the tag is made, so that
commit falls inside its own tag's range. Regenerate `CHANGELOG.md` afterwards and a `Chores` line
nobody wrote appears — precisely the unexplainable diff `dev/changelog.sh` exists to prevent.

`.releaserc.json`'s `presetConfig.types` carries `{ "type": "chore", "scope": "release", "hidden":
true }`, and two things about it are fragile enough to write down. The preset's `findTypeEntry`
uses `Array.find`, so **the scoped entry only wins while it precedes the bare `chore` one**. And
it matches on the scope, so it depends on `@semantic-release/git`'s `message:` really producing
`chore(release)`. `changelog.preset.ts` throws if the ordering is wrong — it is the one place that
parses the table, and `.releaserc.json` is the live repo's own file, which `pnpm test` may not
read.

`pnpm changelog` producing zero diff at a released state is the check that all of this holds.

## Probes

Run before the design settled, because most of it reads as obviously-fine and one part was not.

| Probe | Answer |
| --- | --- |
| `semantic-release --dry-run --no-ci` in a throwaway clone | `The next release version is 0.14.0`; `Allowed to push to the Git repository` over SSH; the only failing step is the GitHub token |
| `{ "type": "chore", "scope": "release", "hidden": true }` ahead of the bare `chore` entry | the commit disappears from the regenerated file; behind it, nothing changes |
| A `preinstall` script exiting 1, as the guard on the new hangar-root `package.json` | **does not fire.** pnpm 10 does not run it, not even with a dependency present to install — `pnpm run preinstall` does, `pnpm install` does not, and npm skipped it too |

The third one changed the design: the guard is `dev/scrub-check.sh` asserting the root
`package.json`'s shape instead, and `app/CLAUDE.md`'s package blockquote carries the reasoning.

## The token, and the two failures that look alike

`@semantic-release/github` reads `GH_TOKEN` or `GITHUB_TOKEN`, and both of its failures were hit
here in turn. They need different fixes and the messages are not interchangeable, so the preflight
asks GitHub twice — once about the account, once about the repository — before running any gate.

| `gh api user` | `gh api repos/<slug>` | What it is |
| --- | --- | --- |
| fails | fails | the token does not authenticate: expired, revoked, or a shell older than the profile that sets it (`source ~/.zshrc`) |
| works | fails | the token authenticates but **cannot see this repository** |

The second row is the one that misleads. **GitHub answers 404, not 403, for a repository a token
cannot see** — so `@semantic-release/github` reports "The repository casaper/hangar doesn't exist"
for what is really a permissions problem, while `git push` over SSH keeps working perfectly because
it is a different credential entirely. It happened here on a repo that had been **deleted and
recreated after the token was issued**: a fine-grained PAT names the repositories it may touch, and
the new repo was not among them.

Checked in the preflight rather than left to `verifyConditions`, because that step runs after the
whole gate suite — so the answer arrived several minutes late, as a forty-line `AggregateError`,
for a question `gh api user` answers in a second. `gh` is a per-machine developer tool, so its
absence is a note and a skip, not a failure; semantic-release still does its own check.

## Two things to know before the first real run

**The tag will be lightweight.** `@semantic-release/git` tags with `git tag <name> <sha>` — no
`-a`, no message — while the fourteen historical tags are annotated and carry hand-written
milestone prose (`v0.13.0` is "the IntelliJ colleague: an editor that is not VS Code"). So from
`v0.14.0` on, `git cat-file -t <tag>` answers `commit` rather than `tag`. Nothing breaks:
`git describe --tags` in `lastReleaseTag` matches both, and `changelog.sh --tag-prefix v` reads
either. But it is a visible change in a repo that clearly cared about those messages, and
`.releaserc.json` has no option for it — the only way back is a `git tag -f -a` after the fact,
which needs a force-push.

**An interrupted release leaves the commit here and nothing on origin.** semantic-release runs
`prepare` — changelog, version bump, release commit, tag — before `publish`, which pushes and
creates the GitHub release. A token that passes `verifyConditions` and then fails on publish
leaves a local `chore(release)` commit and its tag with the remote untouched. The command's error
says so and names the undo: `git reset --hard HEAD~1 && git tag -d <the tag>`.

## What enforcement looks like without CI

`.github/` is gone entirely. The husky hooks are fast feedback for whoever ran `pnpm hooks`, and
the release preflight is the place nothing can be skipped. Two details the deleted workflow was
the only record of now live in `commands/release.ts`:

- **commitlint needs `--config app/.commitlintrc.json`.** The config is in `app/`, the release
  runs from the hangar root because `.releaserc.json` is there and semantic-release takes the
  repository from the working directory, and a bare invocation errors on a missing config rather
  than linting anything.
- **`scan:secrets` fails rather than skips when gitleaks is absent.** `app/.husky/pre-commit`
  skips deliberately — a per-machine developer tool must not block a commit — and the workflow's
  `scan` job used to be the place that could not be skipped. A release cut without a history scan
  is a release nobody scanned.

## Why `dev`, and what does not change

A release is only meaningful in a checkout of this repo, never in an operator's hangar — the same
contract `dev golden` has. So it is hidden, it gets **no row in `hangar-ops/reference/commands.md`**,
and `.claude/modes/ops.settings.json` denies `hangar dev` outright: operator mode has no business
cutting a release, and developer mode is the only one that can write that file.

`hangar doctor` gets no row for any of this either, for the reason it gets none for
`core.hooksPath`: every hangar root is a clone of this repo, but only a CLI developer ever releases
from one, and a row red forever in every operator's hangar is the check nobody reads.
