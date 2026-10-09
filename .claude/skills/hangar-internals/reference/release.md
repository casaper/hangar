# Releasing: semantic-release, run locally, behind this repo's gates

`pnpm release` is `hangar dev release`. It runs every gate this repo has, then hands over to
**semantic-release**, which does the release itself from `.releaserc.json`: the version from the
commit types, the CHANGELOG, the bump, the release commit, the tag, the push and the GitHub
release. `app/CLAUDE.md`'s **Releasing** section is the how. This is the why.

## Why a terminal: semantic-release versions from the tags it can see

semantic-release reads the last release off the tags in the checkout it runs in, and a CI checkout
has only what origin has. **A repository whose tags live in one working copy and not on origin**
looks, to a CI run, like one with zero releases — so semantic-release treats the next one as the
first and publishes **1.0.0**. That is the exact outcome the "no `!` and no `BREAKING CHANGE:`
while the CLI is 0.x" rule exists to prevent, reached by a route that rule never looks at. The
same absence turns every `compare/v0.12.0...v0.13.0` link in `CHANGELOG.md` into a 404 while the
commit-SHA links beside them resolve.

This repo was in exactly that state (`git ls-remote origin` listed `HEAD` and `refs/heads/main`
and nothing else), which is why the release runs where the tags are: on a developer's machine.
Measured, not assumed: `semantic-release --dry-run --no-ci` in a throwaway clone answers `The next
release version is 0.14.0`.

**The tag check is what keeps the two readers agreeing.** Local tags and `git ls-remote --tags
origin` must match, or the release refuses and names the missing ones: a tag in one place and not
the other means two readers of the same commits compute different versions, which is the whole
failure in a sentence. It is also why running from a terminal stays correct rather than merely
convenient — without the check, a local clone missing a tag would make the same mistake CI did.

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
  `confirm` reads `/dev/tty` and returns false when there is none, so a run nobody is watching
  declines instead of releasing. **`-y` is the only way past it, and it is a flag rather than a
  tty probe on purpose**: "no terminal, so assume yes" is the same mistake inverted, and it is the
  one that fires in a cron job or a forgotten hook. It skips the question and nothing else — the
  preflight and the gates are what the answer would have rested on, so they still run.

**`--no-ci` is not a weakening.** Without it semantic-release detects no CI environment and
refuses to run at all; with it, the branch check, the up-to-date check and the whole
`verifyConditions` pipeline still run. It says "a human is doing this", nothing else.

**It does not compute a version, deliberately.** A release-rules table of its own would be a
second table that must agree with `.releaserc.json` — the drift this repo keeps finding — so
`.releaserc.json` is the only thing that decides a version, and the command only reports what
semantic-release decided.

## What `.releaserc.json` decides, and the one file that reads it

**It is the single source of the CHANGELOG's section list.** `app/changelog.preset.ts` — the
preset behind `pnpm changelog` — reads `presetConfig.types` out of it rather than declaring its
own. Two copies of a twelve-entry table that must agree is the drift this repo keeps finding, and
the symptom would be sections with different titles in one file with nothing saying why.

**The list exists at all because the preset's defaults hide everything but `feat`, `fix` and
`perf`.** With them, v0.11.0 — the release that added the whole `node:test` suite — renders as a
heading with nothing under it.

**`docs`, `refactor`, `test` and `build` are given `patch`** rather than the default of no
release, because in this repo a documentation commit is a real change.

**`pnpm changelog` is `dev/changelog.sh` rather than a one-line script entry**, for the same
reason `pnpm golden` is: it has to be reproducible. The bare `conventional-changelog` invocation
regenerates every section and drops the `# Changelog` heading, which would show the next developer
a one-line diff they did not make, so the script puts the heading back. That heading is
load-bearing: `.releaserc.json` sets `changelogTitle` to it, and semantic-release prepends _under_
it.

**`hangar --version` reads `app/package.json`** rather than repeating it, so a release bump moves
one file. A literal copy is the kind of duplicate nothing notices until a tool moves the other one.

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

Each design choice here rests on one, because most of it reads as obviously fine and one part is
not.

| Probe | Answer |
| --- | --- |
| `semantic-release --dry-run --no-ci` in a throwaway clone | `The next release version is 0.14.0`; `Allowed to push to the Git repository` over SSH; the only failing step is the GitHub token |
| `{ "type": "chore", "scope": "release", "hidden": true }` ahead of the bare `chore` entry | the commit disappears from the regenerated file; behind it, nothing changes |
| A `preinstall` script exiting 1, as a guard on the hangar-root `package.json` | **does not fire.** pnpm 10 does not run it, not even with a dependency present to install — `pnpm run preinstall` does, `pnpm install` does not, and npm skipped it too |

The third is why the guard is `dev/scrub-check.sh` asserting the root `package.json`'s shape
rather than an install hook; `app/CLAUDE.md`'s package blockquote carries the reasoning.

## The token, and the two failures that look alike

`@semantic-release/github` reads `GH_TOKEN` or `GITHUB_TOKEN`, and both of its failures were hit
here in turn. They need different fixes and the messages are not interchangeable, so the preflight
asks GitHub twice — once about the account, once about the repository — before running any gate.

| `gh api user` | `gh api repos/<slug>` | What it is |
| --- | --- | --- |
| fails | fails | the token does not authenticate: expired, revoked, or a shell that never loaded it |
| works | fails | the token authenticates but **cannot see this repository** |

The second row is the one that misleads. **GitHub answers 404, not 403, for a repository a token
cannot see** — so `@semantic-release/github` reports "The repository casaper/hangar doesn't exist"
for what is really a permissions problem, while `git push` over SSH keeps working perfectly because
it is a different credential entirely. It happened here on a repo that had been **deleted and
recreated after the token was issued**: a fine-grained PAT names the repositories it may touch, and
the new repo was not among them.

**Where the token comes from is the hangar root's `.env.local`, loaded by `.envrc` through
direnv** — so an unset one usually means `direnv allow` has not been run here, not that the
profile is wrong, and the hint says both. `.gitignore` covers `.env.local` and also `/.env`,
which has no file today: `.envrc` carries a `dotenv_if_exists .env` line, and an ignore entry is
cheaper than noticing a committed one later.

The permission that failed at v0.14.0 is worth naming, because the message does not: GitHub put it
in a response header, `x-accepted-github-permissions: contents=write`. A fine-grained PAT needs
**Contents: Read and write** to create a release, and **Issues** and **Pull requests** write as
well, because `@semantic-release/github` comments on the issues and PRs a release closes.

Checked in the preflight rather than left to `verifyConditions`, because that step runs after the
whole gate suite — so the answer would arrive several minutes late, as a forty-line
`AggregateError`, for a question `gh api user` answers in a second. `gh` is a per-machine developer tool, so its
absence is a note and a skip, not a failure; semantic-release still does its own check.

## What a release leaves behind

**The tag is lightweight.** Confirmed at v0.14.0: `git cat-file -t v0.14.0` answers `commit`.
`@semantic-release/git` tags with `git tag <name> <sha>` — no `-a`, no message — while the fourteen
historical tags are annotated and carry hand-written milestone prose (`v0.13.0` is "the IntelliJ
colleague: an editor that is not VS Code"). So from `v0.14.0` on, `git cat-file -t <tag>` answers
`commit` rather than `tag`. Nothing breaks: `git describe --tags` in `lastReleaseTag` matches both,
and `changelog.sh --tag-prefix v` reads either. But it is a visible change in a repo that clearly
cared about those messages, and `.releaserc.json` has no option for it — the only way back is a `git
tag -f -a` after the fact, which needs a force-push.

**A failed release usually leaves everything ALREADY PUSHED.** The order is `prepare` (changelog,
version bump, release commit), then tag, then **push**, and only then `publish` — the GitHub
release. So the likeliest failure of all, a token that can read the repository but not create a
release, fails after the push, and the only missing artifact is the GitHub release object.

**So never answer a failed release with `git reset --hard HEAD~1` by reflex**: on a pushed release
that is wrong, and it needs a force-push to carry out. Reading the plugin order suggests the
opposite; watching one fail does not — v0.14.0 failed exactly this way. `failureHint` asks git
which of three states it is in rather than guessing:

| State | What to do |
| --- | --- |
| no tag at HEAD | nothing happened; the tree is as it was |
| tag at HEAD, **on origin** | do not reset. `gh release create <tag> --notes-file <notes>`, taking the notes from the top section of `CHANGELOG.md` |
| tag at HEAD, not on origin | `git reset --hard HEAD~1 && git tag -d <tag>` |

Re-running the command after a pushed-but-unpublished release correctly finds nothing to release:
the tag is the last release, and there are no commits after it.

## What enforcement looks like without CI

There is no `.github/` and no CI. The husky hooks are fast feedback for whoever ran `pnpm hooks`,
and the release preflight is the place nothing can be skipped. Two details of it live in
`commands/release.ts` and nowhere else:

- **commitlint needs `--config app/.commitlintrc.json`.** The config is in `app/`, the release
  runs from the hangar root because `.releaserc.json` is there and semantic-release takes the
  repository from the working directory, and a bare invocation errors on a missing config rather
  than linting anything.
- **`pnpm scan` is two gates, and they are not interchangeable.** `scan:secrets` is gitleaks over
  the whole history; `scan:literals` is `dev/scrub-check.sh` over the tracked tree. The split is
  measured: against a canary of seven planted credentials gitleaks caught the Atlassian token, an
  `ATBB` Bitbucket token, an AWS key id, a GitHub PAT and a quoted `db_password`, and **missed both
  plain `USER_READWRITE_PASSWORD=<human-chosen value>` lines**, because low entropy defeats its
  `generic-api-key` rule. That is one of this hangar's four real credentials and the exact shape a
  person pastes, so `scrub-check.sh` carries the pattern for it.
- **`scan:secrets` fails rather than skips when gitleaks is absent.** `app/.husky/pre-commit`
  skips deliberately — a per-machine developer tool must not block a commit — so the release is
  the one place the scan cannot be skipped. A release cut without a history scan is a release
  nobody scanned.

## Why `dev`, and what does not change

A release is only meaningful in a checkout of this repo, never in an operator's hangar — the same
contract `dev golden` has. So it is hidden, it gets **no row in
`hangar-ops/reference/commands.md`**, and `.claude/modes/ops.settings.json` denies `hangar dev`
outright: operator mode has no business cutting a release, and developer mode is the only one that
can write that file.

`hangar doctor` gets no row for any of this either, for the reason it gets none for
`core.hooksPath`: every hangar root is a clone of this repo, but only a CLI developer ever releases
from one, and a row red forever in every operator's hangar is the check nobody reads.
