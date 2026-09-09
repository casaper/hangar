# CLAUDE.md — the `hangar` CLI

This file is about **changing the CLI**. It sits one level below the hangar root, so Claude Code
loads it the first time a session reads any file under `app/` — a clone session and a session that
only _runs_ `hangar` commands never pay for it. The hangar root's own `CLAUDE.md` is the fleet map
and is loaded everywhere; nothing here is repeated there.

Two companions:

- **`.claude/skills/hangar-internals`** — why each command is built the way it is. Load it before
  editing anything under `app/src/**` or debugging a `sync`, `tmp merge`, `plans collect`,
  `ide sync`, `colours` or `doctor` run. Its `reference/` files carry one subsystem each.
- **`.claude/skills/hangar-ops`** — the command surface and how to drive it. That is the operator's
  manual, not the developer's; reach for it when you need a flag spelling.

## The package

The fleet is orchestrated by one TypeScript commander CLI. The executable is `bin/hangar`; the
package it runs is `app/` (`app/src/**`, `app/package.json`, `app/node_modules`), kept out of the
hangar root for the reason below.

> **Never put `node_modules`, or anything that would create it, in the hangar root.** That
> directory is an ancestor of every clone, and Node resolves both a file's module type and its
> imports from the nearest `package.json` and `node_modules` walking up. A clone has no
> `package.json` at its own root — only in `angular/` — so whatever is at this level is what every
> clone file outside `angular/` reads. It has already broken things once: `"type": "module"` here
> flipped `clone_NN/.claude/hooks/*.js` to ESM, so every one of them died with
> `ReferenceError: require is not defined in ES module scope` at session start, and
> `npm pkg get name` run at a clone root answered the fleet's package. That is why the CLI is in
> `app/`.
>
> **There is now one file at that level, and it is scripts and nothing else.** The root
> `package.json` exists so `pnpm release` and the other gates can be run from the hangar root
> instead of `cd app` first, and it declares **no `dependencies`, no `devDependencies`, no
> `"type"`, no `workspaces` and no `packageManager`** — which is what keeps the paragraph above
> true rather than merely historical. `app/pnpm-workspace.yaml` stays the workspace root and
> `app/pnpm-lock.yaml` stays the lockfile.
>
> **`dev/scrub-check.sh` enforces that shape, because the obvious guard does not work.** A
> `preinstall` script exiting 1 was written and then measured: **pnpm 10 does not run it** — not
> even with a dependency present to install (probed both ways; `pnpm run preinstall` fires,
> `pnpm install` does not), and npm skipped it too. So a stray `pnpm install` here still leaves an
> empty `node_modules`, which resolves nothing and harms nothing. What must never happen is this
> file growing something to put in it, and that is the line the gate holds.

**There is no build step.** Node strips the types and runs `src/cli.ts` directly, so an edit is
live the moment it is saved and there is nothing to rebuild before trying it.

**The package manager is pnpm**, pinned by `packageManager: "pnpm@11.7.0"` in `app/package.json`,
which is the single source of truth for both the shell and CI. Run the CLI's own checks **from
`app/`** — they cover the CLI, not the app:

```bash
cd app && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
# pnpm lint:fix and pnpm format write; format:check is what a commit gate wants
pnpm golden && git diff --exit-code dev/golden/gated   # the regression net; see below
pnpm scan     # both hygiene gates; see **Nothing in here names one organisation**
pnpm hooks    # ONCE per clone of this repo: installs the two git hooks. See Commit messages
pnpm release -n   # what the next release would be. See Releasing
```

**`pnpm scan` is two gates and they are not interchangeable.** `scan:secrets` is gitleaks over the
whole history; `scan:literals` is `dev/scrub-check.sh` over the tracked tree. The split is
measured rather than stylistic: gitleaks was run against a canary of seven planted credentials and
caught the Atlassian token, an `ATBB` Bitbucket token, an AWS key id, a GitHub PAT and a quoted
`db_password` — and **missed both plain `USER_READWRITE_PASSWORD=<human-chosen value>` lines**,
because low entropy defeats its `generic-api-key` rule. That is one of this hangar's four real
credentials and the exact shape a person pastes, so `scrub-check.sh` carries the pattern for it.
Both also run in `app/.husky/pre-commit` (on what is staged) and in the workflow's `scan` job,
which `release` needs — the same fast-feedback-plus-enforcement shape as `commitlint`.

`pnpm` is not assumed to be on PATH: it lives inside an fnm multishell and so moves when the Node
version moves. The hangar root's `.envrc` activates it through `hangar_use_pnpm` (defined in
`.envrc.hangar`), alongside `hangar_use_node .nvmrc`, `hangar_use_gnu`, `PATH_add bin` and
`PATH_add app/node_modules/.bin` — which is how `tsc`, `eslint` and `prettier` are reached. If any
of those commands is not found, the answer is almost always that direnv has not loaded: run
`direnv allow` at the hangar root.

## Two conventions for changing it

Both exist because they caught something, and both apply to every edit under `app/src/**`.

- **Anything that produces text for a human or an agent gets a PURE builder, given its facts and
  exported.** Every variant can then be printed side by side without constructing the state that
  produces it, which is how `sync`'s eight closing messages were checked — and it found two bugs
  reading the code had not: one froze an agent after a SUCCESSFUL sync, the other told it a
  branch had moved when nothing was integrated. This convention predates the test suite and is
  what made one possible at all: every assertion in `test/` is a call to a pure builder.
- **`pnpm golden` is the first convention, mechanised.** It captures every artifact this hangar
  would write — through the same pure builders `doctor` compares against and `add-clone` writes —
  and records each one's **destination** alongside its content, because every path in this CLI is
  a bare `string` and a builder rendering perfect text into the wrong file passes a content-only
  diff. `dev/golden/README.md` has the detail; three things about it are worth knowing before
  relying on it:
  - **`gated/` is a gate, portable, and expected to diff for NOBODY.** Everything in it renders
    from a checked-in fixture config in a temp directory with `%HANGAR%`/`%HOME%` normalised
    away, so `pnpm golden` in a fresh clone of this repo on another machine produces no diff and
    any diff is a finding. It did not always: a capture of this hangar was gated too, and the
    first developer gate a colleague ran opened with a 120-file diff that looked like a broken
    tool. **The one legitimate exception is the platform** — each fixture's `manifest.txt` carries
    the platform driver's own answers, including the capability record, and a Linux run diffs
    those rows. They are captured rather
    than normalised because a capture that hid them would hide the seam that only exists at all
    because three `darwin`-only assumptions survived unnoticed until this was published.
  - **`advisory/` is not a gate, for either of two reasons.** It MOVES — `doctor --all`,
    `status --all`, `list` and the `tmp`/`plans` dry runs read live state, so a green command
    diff proves less than it looks like it does. Or it is stable but NOT PORTABLE:
    `advisory/hangar/` is this hangar's own artifact tree, and `advisory/commands/` holds the
    four command captures that read this config and these clones. `config validate` is the one
    that could not simply be re-aimed at a fixture — the example-vs-live comparison is its whole
    value and a temp directory has no committed example — so it moved rather than being weakened
    in place.
  - **Two fixtures, and the second one is not a variant.** A fixture disagreeing with the schema
    defaults is what proves the config file was read at all: while a config agrees with the
    defaults, "read the config file" and "fell into a catch and used the defaults" produce
    identical output. Two fixtures that also disagree with EACH OTHER are what no single
    swallowed error can satisfy. `dev/fixture.config.yaml` is Zed-shaped — no app subdirectory,
    one workspace directory, a literal install `command`, a non-zero port offset.
    `dev/fixture-vscode.config.yaml` is the shape the DEFAULT editor takes, and its header lists
    the seven things it is the only capture of: an editor kind that consumes `rootPathKeys`, a
    non-empty `rootPathKeys` table, two `workspaceDirs`, a non-empty `repo.appDir`, `manager:`
    install steps with and without an `INSTALL_MARKERS` entry, `skipIfDirMissing: true`, and
    `ports.offset: 0`. Adding a kind or a key means asking which of the two should carry it.
    The manifest also records the discovery `source` and `EditorSelection.fellBack`, for the
    same reason the fixtures disagree.
  - **An expected diff is fine; an unenumerated one is the finding.** Making a config key live for
    the first time is _supposed_ to change the fixture half, and that change is the proof. Write
    the expected delta down before making the change.
- **`pnpm test` covers what a capture structurally cannot, and nothing else.** `app/test/`, run by
  `node --test` with no flags — Node 24 strips the types, and `test/**/*.ts` is in the tsconfig
  include so the suite is checked under the same strict flags as `src/`. Three things live there
  and the boundary matters:
  - **Two hangars in ONE process.** `dev/golden.sh` runs the binary once per hangar, so a module-level
    singleton or a cache keyed on nothing passes it every time and still hands the second hangar
    the first one's answers. `two-hangars.test.ts` reads them interleaved and asserts no path and
    no port of one appears in the other's.
  - **Input that is WRONG.** A capture shows what one config rendered to; it cannot show the
    refusal. An unknown `{token}`, a known token with no value in context, two port roles
    congruent mod step.
  - **Properties, never snapshots.** `gated/fixture/` already pins every builder byte for byte, so
    expected text here would be a second oracle to hand-update on every prose edit — the work the
    golden net exists to absorb. Assert that the offset reached the port and that an identity file
    names no sibling; leave the bytes to golden.
  - **Text that must name NO repo in particular.** `generic-text.test.ts` renders the per-clone
    builders against a config disagreeing with this repo's _and_ with every schema default, and
    asserts six literals from this repo appear nowhere in the result. A capture says what the
    bytes are; only this says what they may never contain — and two of the six (`clone_`,
    `.env.local`) are schema defaults, so a fixture agreeing with a default could not have shown
    them. `hangar-internals/reference/doctor.md` has the table.

  Everything runs against a synthetic root and a synthetic `~/.claude`, and that is a requirement:
  `makeClone` reads `.hangar/colour-assignments.json` under the hangar root and caches it per
  root, so a test aimed at this hangar would read one developer's own `colours change` history.
  `namesNoMachinePath` in `test/fixture.ts` is the standing guard.

- **Derive state at the moment you report it; carry a flag only for what git cannot know.** A
  `restored` boolean set beside a `git stash pop` lies whenever the pop fails, which it can — it
  only warns. Ask `inProgressOperation`, `conflictedFiles`, `syncStashes` instead. Whether an
  integration got committed is the one thing git cannot answer, so that one is carried, and a
  carried flag needs guarding for the paths that do nothing (`up-to-date` integrates nothing).

## Nothing in here names one organisation

Hangar manages any repo, but it was built in one, and a tool built inside a company tends to name
it — a Bitbucket URL here, a Jira host there, a ticket key in a worked example, one machine's home
directory in a tracked settings file. None of that is true of the next hangar, and all of it is
somebody's business but the reader's. `pnpm scan:literals` is what keeps it out.

The rule, and the two halves it splits into:

- **A name that identifies a company, a repository, a ticket or a person does not belong in a
  tracked file.** Worked examples still name something concrete, because a paragraph with
  `<some file>` in it is a claim rather than evidence — they name `ABC-1323` and `storefront_ui`,
  which are fictional and match `dev/fixture*.config.yaml`'s vocabulary (`acme`, `storefront_ui`,
  `warehouse_sql`).
- **The hangar id `dvb_gn` is deliberately NOT in that set.** It is an opaque slug naming no
  organisation, and it is load-bearing outside this repo: `~/.claude/<id>-clone-statusline.sh`,
  one theme file per clone, and the `hangar_dvb_gn_colour` shell function two hangars can both
  source. Renaming it is a three-phase operation, not a find-and-replace.

Two consequences worth knowing before editing the files they touch:

- **`hangar.config.example.yaml` is a superset of the live config EXCEPT for five keys.**
  `displayName`, `profile`, `forge.originUrl`, `forge.webBaseUrl` and `tracker.baseUrl` are
  placeholders, and `configDrift` in `config/drift.ts` excludes exactly those from the
  example-vs-live comparison. Everything else is still held equal — `forge.defaultBranch`
  included, which is the line that comparison was written for after the pair silently drifted.
- **`app/test/generic-text.test.ts`'s `THIS_REPOS_OWN` names `DN-`, the live config's
  `keyPrefixes`, and that is the only place in this repo that may.** It is the guard asserting
  those strings never reach text generated for another hangar, and a guard has to name what it
  forbids. The **bare prefix** rather than a whole key, twice over: it forbids every ticket rather
  than one, and a whole key is exactly what a bulk find-and-replace over the tree would rewrite —
  leaving a guard that guards nothing while every check stays green. `dev/scrub-check.sh` writes
  its own patterns as `datav[a]ult` and `__D[V]B_` for the same reason, and needs no allow-list at
  all as a result.

## Commit messages

**Every commit in this repo is a Conventional Commit, and a `commit-msg` hook enforces it.**
`type(scope): subject`, then a blank line, then the body. The subject keeps the house style — a
sentence saying what changed, in Sentence case — and the body keeps doing the work it already
does: for the two thirds of this CLI that no test covers, the commit body IS the regression
record.

```
fix(editor): Let a hangar whose editor is not VS Code actually be one
feat(sync):  Stream the headless conflict resolver, and refuse to sync onto a half-applied rebase
docs(test):  Say the suite exists, and say exactly what it does not cover
```

**Types** are `@commitlint/config-conventional`'s: `feat` `fix` `docs` `style` `refactor` `perf`
`test` `build` `ci` `chore` `revert`. What they mean here — `feat` adds a command, a flag, a seam,
a driver or a generated artifact; `fix` corrects behaviour that was wrong; `docs` is `CLAUDE.md`,
the README or the skills and nothing else.

**Scopes** are the subsystem: `sync` `doctor` `open` `tmp` `plans` `jira` `colours` `config`
`editor` `terminal` `platform` `setup` `add-clone` `install` `resume` `ide` `status` `golden`
`cli` `fleet` `modes` `test`. That list is documented and deliberately **not** enforced — a
`scope-enum` rule goes red the first time somebody adds a subsystem, and this repo already knows
what a check that is red in normal operation is worth.

Three rules in `.commitlintrc.json` differ from the defaults, and each one is there because the
default rejected this repo's own history:

- **`header-max-length` is 120, not 100.** The longest subject here is 89 characters and a
  `fix(golden): ` prefix puts it at 102. Cutting eighty-four hand-written subjects down to fit a
  round number is the wrong side of that trade.
- **`subject-case` is off.** `config-conventional` forbids Sentence case, which is the case every
  subject in this repo is written in.
- **`body-max-line-length` is left at 100** and needs no exception: the longest body line in the
  whole history is 88.

`footer-leading-blank` warns on about a quarter of the history and is left warning. The parser
reads any `word: value` line in a prose body as a footer token, and these bodies are full of them
(`kind: none`, `type: module`). Reflowing twenty-one bodies to satisfy a heuristic would damage
the record to silence a warning that blocks nothing.

**No `!` and no `BREAKING CHANGE:` footer while the CLI is 0.x.** Several changes here are
breaking by content — the `orch-util` → `hangar` rename, untracking files a command rewrites — and
marking them would cut a 1.0.0. Versions move by patch and minor only until somebody decides
otherwise, and that is a decision, not a commit message. **`hangar dev release` refuses rather
than escalating**: `conventional-changelog`'s own `preMajor` option bumps one level instead, which
would turn a stray `!` into a version silently and differently depending on what else was in the
range. The release stops and names the commit.

### The hooks, and where this is actually enforced

`pnpm hooks` installs **both**, once per clone of this repo, **by hand**. It cannot be automatic:
`pnpm-workspace.yaml` sets `ignoreScripts: true`, so husky's `prepare` never runs on install.

- **`app/.husky/commit-msg`** reaches `commitlint` by path rather than through `pnpm` (pnpm lives
  inside an fnm multishell and moves with the Node version, so a hook needing it fails in any
  shell direnv has not touched), and names `direnv allow` when it cannot find `node` — the same
  failure and the same fix `bin/hangar` already reports.
- **`app/.husky/pre-commit`** runs the two hygiene gates on what is STAGED. It calls `gitleaks` by
  NAME, and **skips with a message rather than failing when it is absent**: gitleaks is a per-
  machine developer tool (`brew install gitleaks`), not a dependency of this package, and a
  missing scanner must not block a commit. `scrub-check.sh` has no such dependency and always
  runs.

So the hooks are fast feedback for whoever installed them, and **`hangar dev release` is where
none of it can be skipped**: it runs typecheck, lint, format, the suite, both scans, the golden
gate and `commitlint` over the whole range being released, before it hands over to
semantic-release. There was a `.github/workflows/release.yml` running the same checks; it is gone,
because the release it gated never worked from CI. `hangar-internals/reference/release.md` says why.

**A missing gitleaks is an error there, not a skip.** The hook's leniency is deliberate and stays
— a per-machine developer tool must not block a commit — but a release cut without a history scan
is a release nobody scanned, so `dev/scan-secrets.sh` exits 1 with `brew install gitleaks` and the
preflight stops.

**`hangar doctor` deliberately gets no row for `core.hooksPath`.** Every hangar root is a clone of
this repo, but only a CLI developer ever commits in one — an operator's hangar would carry that
row red forever, which is the check nobody reads.

### Releasing

**`pnpm release` cuts one, from a terminal.** It is `hangar dev release`, and it runs this repo's
gates and then hands over to **semantic-release**, which does the release itself: the version from
the commit types, the CHANGELOG, the version bump, the release commit, the tag, the push and the
GitHub release, all from `.releaserc.json`. `-n` runs the gates and `semantic-release --dry-run`,
changing nothing, and it is the first thing to run. `-y` releases without asking.

That used to be a GitHub workflow and it never successfully cut anything: **no tag had ever been
pushed to origin**, so in CI semantic-release found zero releases, would have treated the next one
as the first and published 1.0.0. Run from a developer's machine it sees the local tags and gets
the right answer — moving it here is what fixed it, and the tag check below is what keeps it fixed.

**What the command adds is everything semantic-release will not do for itself:**

- **The preflight.** On `main`, clean tree, not behind origin, a token in `GH_TOKEN` or
  `GITHUB_TOKEN`, and **local tags agreeing with `git ls-remote --tags origin`** — the check that
  would have caught the failure above. Each is a sentence rather than a stack trace halfway
  through the pipeline.
- **A refusal on a breaking marker while the CLI is 0.x.** semantic-release has no setting for
  this and would answer by cutting 1.0.0. `release/commits.ts` finds them and the release stops,
  naming the commits; `test/release-commits.test.ts` pins both spellings of the footer and the
  `!`, because missing one IS the failure.
- **Every gate**, since there is no CI to run them: typecheck, lint, format, the suite, both
  scans, the golden gate, and `commitlint` over the whole range being released.
- **A confirmation**, because the next thing that happens is a push. It reads `/dev/tty` and
  **fails closed where there is none**, so an unattended run declines rather than releasing;
  `-y` is the only way past it, and it has to be typed. Inferring consent from the absence of a
  terminal is the same bug the other way round — it skips the question and nothing else.

**`--no-ci` is what makes a local run legal**, not a weakening: without it semantic-release detects
no CI environment and refuses outright. The branch check, the up-to-date check and the whole
`verifyConditions` pipeline still run.

Four things about `.releaserc.json` are load-bearing:

- **It is the single source of the CHANGELOG's section list.** `app/changelog.preset.ts` — the
  preset behind `pnpm changelog` — reads `presetConfig.types` out of it rather than declaring its
  own. Two copies of a twelve-entry table that must agree is the drift this repo keeps finding,
  and the symptom would be sections with different titles in one file with nothing saying why.
- **The list exists at all because the preset's defaults hide everything but `feat`, `fix` and
  `perf`.** With them, v0.11.0 — the release that added the whole `node:test` suite — rendered as
  a heading with nothing under it.
- **`docs`, `refactor`, `test` and `build` are given `patch`** rather than the default of no
  release, because in this repo a documentation commit is a real change.
- **`{ "type": "chore", "scope": "release", "hidden": true }` keeps `pnpm changelog`
  reproducible, and its POSITION is the whole trick.** `@semantic-release/git` writes
  `chore(release): <version>` before the tag is made, so that commit falls inside its own tag's
  range and a later regeneration would add a `Chores` line nobody wrote. The preset matches with
  `Array.find`, so the scoped entry only works while it precedes the bare `chore` one —
  `changelog.preset.ts` throws if it does not, which is the only place that parses the table.

`pnpm changelog` is `dev/changelog.sh` rather than a one-line script entry, for the same reason
`pnpm golden` is: **it has to be reproducible.** The bare `conventional-changelog` invocation
regenerates every section and drops the `# Changelog` heading, so running it would show the next
developer a one-line diff they did not make. The script puts the heading back. That heading is
load-bearing — `.releaserc.json` sets `changelogTitle` to it, and semantic-release prepends
_under_ it. Producing no diff at a released state is the check that the hidden entry above works.

`hangar --version` reads `app/package.json` rather than repeating it, so a release bump moves one
file. It used to be a literal, which is the kind of duplicate nothing notices until a tool starts
moving the other copy.

### The history was rewritten once

All 84 commits up to `v0.13.0` were originally prose subjects with no type; they were rewritten in
place — prefix added, body byte-identical, GPG signature re-made, committer date preserved — and
tagged into fourteen milestone releases. `git filter-repo` cannot re-sign and was ruled out for
that reason; `git rebase --root --exec` re-signs from `commit.gpgsign`.

One thing that rewrite found, worth knowing before anyone tries it again: **a root rebase cannot
run in a live hangar.** `.claude/settings.json`, `clone-colours.sh`, `clone-terminal.sh` and
`hangar.config.yaml` are generated and untracked _now_, but were tracked earlier in this history —
so replaying the root commit tries to overwrite the live files and git refuses. Do it in a
throwaway clone and fetch the result back.

## The code, by role

68 files, ~15k lines. **`commands/sync.ts` (882 lines) and `commands/doctor.ts` (777) are the two
worth reading in full before changing either** — they are also the two whose mistakes reach a live
working tree. The rest of the table names files without sizing them on purpose: a count here goes
stale on the next commit and nothing checks it, so run `wc -l` when you want one.

| Role                  | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entry point           | `cli.ts` — every command, option and alias is registered here, plus the `preAction` config gate and the `configureHelp` that prints all of a command's aliases                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| maintainer            | `commands/dev.ts` — `hangar dev golden`, the capture behind `pnpm golden`; `commands/release.ts` — `hangar dev release`, the gates and preflight in front of semantic-release, with `release/commits.ts` beside it reading the range. **Both are hidden in `cli.ts`, and that is their interface contract**: nothing about either is promised to an operator, so neither gets a row in `hangar-ops/reference/commands.md`. `dev` is deliberately NOT in `NEEDS_NO_CONFIG` — a capture, or a release, derived from a hangar with no config would be derived from the schema defaults, the one output neither may be mistaken for |
| commands              | `commands/*.ts`, one per command: `sync`, `doctor`, `tmp`, `jira`, `setup`, `open`, `checkout-default`, `vscode`, `plans`, `add-clone`, `resume`, `colours`, `status`, `remove-clone`, `teach-rg`, `config`, `ports`, `list`, `install`, `claude`                                                                                                                                                                                                                                                                                                                                                                               |
| config                | `config/schema.ts` (the zod authority), `default-branch.ts`, `load.ts` (discovery + precedence), `derive.ts`, `json-schema.ts`, `drift.ts` (the example-vs-live comparison `config validate` runs)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| per-clone artifacts   | `clone-config.ts` — the byte-compared builders `doctor` holds every clone to; `colour-assignments.ts`; `ports.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| generators            | `generate/` — `terminal-sh.ts`, `tmux-conf.ts`, `claude-tmux-conf.ts`, `statusline-sh.ts`, `colours-sh.ts`, `theme-json.ts`, `index.ts` (the dry-run-aware writer)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| editor drivers        | `editor/` — `vscode.ts`, `jetbrains.ts`, `index.ts`, `kinds.ts`, `types.ts`, `launch-only.ts`, `emacs.ts`, `vim.ts`, `zed.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| emulator drivers      | `terminal/` — one window-opener each: `iterm2.ts`, `apple-terminal.ts`, `konsole.ts`, `gnome-terminal.ts`, `none.ts`, plus `applescript.ts`, `index.ts`, `types.ts`. Everything a window CONTAINS is `tmux.ts`, in the shared row                                                                                                                                                                                                                                                                                                                                                                                               |
| platform              | `platform/` — `darwin.ts`, `linux.ts`, `index.ts`, `types.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| git / forge / tracker | `git.ts`, `bitbucket.ts`, `jira-records.ts`, `jira.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| fleet                 | `fleet.ts` — clone discovery, and everything per-clone derived from the index                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| tests                 | `test/**/*.test.ts` — run by `pnpm test`; `test/fixture.ts` builds the synthetic hangar they all use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| shared                | `dedupe.ts`, `claude-sessions.ts`, `resolve-conflicts.ts`, `procs.ts`, `plans.ts`, `environment.ts`, `install.ts`, `secrets.ts`, `tui.ts`, `palette.ts`, `tmp.ts`, `sessions.ts`, `adopt.ts`, `ui.ts`, `hangar.ts`, `user-paths.ts`, `template.ts`, `exec.ts`                                                                                                                                                                                                                                                                                                                                                                   |

**Five seams**, each a capability record plus a driver interface rather than a pretence that the
implementations are equivalent. Adding a kind means implementing the interface and registering it;
callers degrade one capability at a time instead of branching on a product name:

- `editor/types.ts` — `EditorCapabilities` / `EditorDriver`; registered in `editor/kinds.ts`
- `terminal/types.ts` — `EmulatorCapabilities` / `EmulatorDriver`; registered in
  `terminal/index.ts`. It answers one question — _which program can open a window and raise one_ —
  because everything that needs enumerating, naming and typing into happens inside the hangar's own
  tmux server (`src/tmux.ts`). That is one implementation of nothing else, so it is a module rather
  than a sixth seam: a seam here is a capability record plus a driver interface, BECAUSE the
  implementations are not equivalent
- `platform/types.ts` — `PlatformCapabilities` / `PlatformDriver`; registered in
  `platform/index.ts`. The only one **not** overridable by config: `editor.kinds` and
  `terminal.kind` name a preference, this names a fact
- `generate/index.ts` — every generated artifact is a pure function of the clone plus a path
- `fleet.ts` — clone discovery is filesystem-only; there is no list of clones in any file

The platform seam arrived last, and the reason is worth keeping: this fleet runs on macOS, so
every platform difference here was invisible until the tool was published for someone else to
run. Three were already in the code, written as if `darwin` were the only case — and none of
them **failed**. `vscodeWindowState` returned a plausible path under a `~/Library` that is not
there, the read threw, the catch said "no opinion", and `hangar open` opened a second window on
a workspace that was already open. That is how two Claude Code sessions end up in one clone.
`hangar-internals/reference/terminal-and-sessions.md` has the capability table, the two Linux
fixes with no seam of their own, and the one open question the seam does **not** answer: whether
`ps` under procps reports a Claude Code process as `claude` at all.

One thing in here is known and deliberate rather than waiting to be found:
`resolve-conflicts.ts` reads `ORCH_UTIL_RESOLVE_TIMEOUT_MS`, the last `ORCH_UTIL_` name left in
the CLI. **`paths.ts` is gone** — its hangar-derived half became `HangarPaths` (threaded from
`cli.ts`, never a module constant, because a value derived from a root that comes from a file
cannot be evaluated at import time), its `homedir()` half became `user-paths.ts`, and its last
four literals — this fleet's Bitbucket repo, workspace, Jira host and origin URL — became
`forge.originUrl` and `tracker.{baseUrl,issueUrlTemplate}`.

## Which editors it opens

`editor.kinds` in `hangar.config.yaml` is a **list**, because a clone can be open in more than one
editor at once — their project files are different files. `hangar open` opens every one of them;
`hangar ide <kind> sync` keeps one editor's shareable project files in step.

**VS Code is the default and the only editor that has to work; every other kind is best effort.**
That is a rank, not a disclaimer, and it is enforced rather than hoped for: `DEFAULT_EDITOR_KIND`
in `app/src/editor/kinds.ts` is the one place that names it (the schema default reads it, and the
fallback for a config that will not parse goes through that same default, so the two cannot
disagree). `editors()` builds each configured driver in a loop with a per-kind catch, and `open`
and `doctor` isolate each one again around `isAvailable`/`launch` — so a clone configured
`[zed, vscode]` cannot lose VS Code to Zed's launcher, which listing order alone would have done.
`hangar ide <kind> sync` is the deliberate exception: there the developer named the editor, so its
failure is the answer to their command rather than something to step over.

| kind                                                                      | launch                                                 | Hangar syncs                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| `vscode` `cursor` `windsurf` `vscodium` `code-insiders` `positron` `trae` | the workspace copy it already has open                 | `.vscode/*` + the workspace pair   |
| `jetbrains` (`product:` idea, webstorm, pycharm, …)                       | the clone directory                                    | the shareable half of `.idea/`     |
| `zed`                                                                     | the clone directory                                    | `.zed/settings.json`, `tasks.json` |
| `emacs`                                                                   | `emacsclient -n`, else fresh `emacs`                   | `.dir-locals.el`                   |
| `vim`                                                                     | `mvim`/`gvim --remote-silent`, else **a clone window** | nothing                            |
| `xcode` `eclipse`                                                         | the clone directory                                    | nothing                            |

Four things in that table are decisions rather than gaps:

- **Only the VS Code family needs `rootPathKeys`.** A handful of its settings take an absolute
  path into the checkout and it resolves them against nothing, so those values must differ per
  clone — which is what makes `ide vscode sync` a text transform. Everyone else escapes it:
  JetBrains has `$PROJECT_DIR$`, Zed resolves from the project root itself. So the config's
  cross-check asks "is there a kind that CONSUMES these keys", not "is an editor configured".
  **The `*.code-workspace` pair follows the same rule and through the same predicate**
  (`wantsWorkspaceFiles` in `clone-config.ts`): `add-clone`, `doctor` and the golden capture write,
  check and record it only where a configured kind reads one. It was unconditional, so a
  JetBrains-only hangar got the file anyway and `doctor --fix` put it back after you deleted it.
- **Only the VS Code family needs deduplicating.** It identifies a workspace by its config
  file's URI, so a clone's two byte-identical `*.code-workspace` twins are two different
  workspaces to it and it has to be handed the copy it already has open. Every other editor here
  keys on the project DIRECTORY and focuses its own window; `focusExisting: false` means "the
  editor handles it", not "expect duplicates". **A fork has its own window-state file**
  (`Cursor`, `Windsurf`, `Code - Insiders`, …) — reading the wrong one answers about another
  application's windows.
- **`vim` may not be a window at all.** With `mvim` or `gvim` it behaves like any other editor.
  With only `nvim`/`vim` it gets **an extra window in the clone's tmux session**, built alongside
  the configured roles so it sits beside them. Launching terminal vim as a
  subprocess would attach it to the tty `hangar` itself is on and hold the command hostage.
- **`xcode` and `eclipse` are launch-only, deliberately.** Xcode's `.xcodeproj` is a directory of
  generated state — copying it imports another checkout's index rather than a setting. Eclipse's
  `.project`/`.classpath` are normally tracked, so the sync engine refuses them anyway, and its
  per-user state lives in the `-data` workspace, which Hangar puts in the gitignored
  `.hangar/eclipse/<clone>` — outside every clone, one per clone.

**Trackedness is a floor, never a verdict.** `launch.json` and `tasks.json` are declared tracked
and are compared, never written, with no flag to force it — they are versioned per branch, so the
newest copy is not the right one. Git can only ADD to that: any artifact a clone turns out to
track is protected too, which is what catches `.idea/` (gitignored in this repo, tracked in
plenty of others). Never the reverse — a purely dynamic test would make the protection depend on
which branch happens to be checked out.

Of these, **only the VS Code path is exercised**: nothing else is installed on this machine. Each
driver header says so, and `hangar doctor` prints a row per configured editor with whether it can
actually be launched — a `code` command never installed into PATH and a Toolbox that generated no
shell scripts both mean `hangar open` silently opens no editor at all.

## Which terminal it drives, and what tmux owns

`hangar open` gives a clone **one tab of the developer's emulator**, and that tab is a client
attached to **that clone's tmux session** — one tmux window inside it per `terminal.tabs[]` role,
named for the clone and the role. `--window` puts it in a window of its own and
`terminal.placement` sets the default. So the emulator is asked for two things and nothing else:
**open one tab or window running one command**, and **bring one it opened to the front**.
Everything that happens inside — creating the roles, naming them, ordering them, moving between
them, typing a `SYNC PAUSE` into a live session — is `src/tmux.ts`, which is the same program on
macOS and on Linux.

**That server is Hangar's own: `tmux -L hangar-<id>`, started from a config this CLI generates.**
A private socket is what makes the layer safe to be opinionated in — prefix keys, status-line
format and, the reason it has to be private, SERVER options. `extended-keys`, which is what makes
Shift+Enter a newline in Claude Code, is a server option, and writing one onto the server somebody
keeps their own work on is not a trade this tool gets to make for them. Two hangars are two
sockets, for the same reason they get differently named files under `~/.claude`. The cost is real
and is printed rather than hidden: these sessions are invisible to a bare `tmux ls`, so
`tmux -L hangar-<id> ls` is the fleet's window list and `tmux -L hangar-<id> attach -t '=<clone>:'`
is the way back into one whose tab was closed.

**Identity is the session NAME, not a tag stamped on a window.** The socket says which hangar and
the session says which clone, so "is this clone already open" has an exact answer —
`has-session` — instead of an inference from where some window's shell happens to be standing,
and a window the developer splits, renames or `cd`s elsewhere cannot lie about which clone it
belongs to. That is the check that keeps a clone from ending up with two Claude Code sessions in
it, which is this fleet's worst failure. It also makes the good case possible at all: a session
outlives the tab attached to it, so a clone whose tab was closed still has `claude` running in it
and opening the clone again reattaches.

Which emulator hosts that tab comes from the environment (`ITERM_SESSION_ID`, `TERM_PROGRAM`,
`KONSOLE_VERSION`, `VTE_VERSION`, …), then from what is running, and `terminal.kind` overrides
both. **There is no system setting to consult** — macOS has no default-terminal preference at all,
and the `.command` handler answers Terminal.app for a developer who lives in iTerm2 — so the
terminal `hangar` was typed into is the only honest reading of "the terminal I use". Drivers
declare **capabilities** rather than pretending to be equivalent:

| driver         | new tab                                                     | new window | raise a window it opened |
| -------------- | ----------------------------------------------------------- | ---------- | ------------------------ |
| iTerm2         | yes                                                         | yes        | yes                      |
| Terminal.app   | needs Accessibility                                         | yes        | yes                      |
| Konsole        | yes                                                         | yes        | with `qdbus`             |
| GNOME Terminal | yes                                                         | yes        | **no**                   |
| none           | no — the session is still built and the attach line printed |            |                          |

**Raising is the only capability a caller degrades around**, and its absence costs one line: the
clone's window is open and not in front, and `open` prints the `attach` line that finishes the
job. Opening is the floor — a driver that cannot open a window is `none`, which is a mode rather
than a failure.

Three things about that table are decisions rather than gaps:

- **Terminal.app is the one place a tab costs something.** Its `window`'s `tab` element is
  declared `access="r"` in the AppleScript dictionary, so there is no `make new tab` and a tab can
  only be created by sending Cmd-T through System Events, which needs Accessibility permission for
  whichever terminal `hangar` runs from. `do script` with no `in` clause creates a WINDOW and needs
  none of it. So a tab is attempted, the tab count is checked to have actually grown — System
  Events reports success for a key it delivered nowhere — and a refusal falls back to a window
  naming what to allow. The developer asked for their clone, not for a piece of window furniture.
- **iTerm2 is handed the command at CREATION, never typed into afterwards**, and every part of
  that is measured rather than chosen. `iterm2.ts` records the three findings: `write text` into a
  session that was just created is accepted and dropped, a bare `create tab with default profile`
  returns `missing value`, and `command` is argv rather than a shell line — so a builtin like
  `exec` starts nothing and PATH is the application's, which is why `attachCommand` names tmux by
  absolute path.
- **Nothing is ever typed at a raw tty, and there is no portable way to.** VTE exposes no API for
  writing into a running terminal, and the generic POSIX route (the `TIOCSTI` ioctl) has been
  disabled by default since Linux 6.2, because injecting keystrokes into another process's
  terminal is a privilege-escalation primitive. tmux is the mechanism precisely because it needs
  neither — which is what makes `SYNC PAUSE` available on a Linux box with no KDE, and what makes
  a session started by hand OUTSIDE hangar's tmux unreachable. `sync` attributes that miss rather
  than reporting a generic one, and still asks before touching the clone.

**The colour is the generated shell hook's, in every emulator.** `clone-terminal.sh` paints
whatever `$PWD` is in, so a window the developer made with `C-b c` is coloured too — which nothing
that only paints what `hangar open` created can manage. Inside tmux it sets window options rather
than emitting escapes, since tmux swallows those. The hue lands at full strength on both pane
borders, and on the status bar it is a **background** rather than text: the current window-status
entry gets `bg=<hue>` with `colour.ink` in front of it, and the others get the hue as text in its
`barText` form. The status line's `status-left` is the one piece `open` paints itself, at SESSION
scope when it creates the session — a badge in the clone's hue, same shape — because the bar has
to be right the instant the client attaches, which is before any shell has printed a prompt, and
it is a session option the hook could only reach with `-g`. `generate/terminal-sh.ts` carries the
rest, including why every `tmux set -w` names `$TMUX_PANE`.

**The bar names its own background, and that is not decoration.** With no `status-style` tmux uses
its built-in `bg=green,fg=black` — a saturated default, not a neutral one — so every hue was being
drawn as text on green: measured, the whole palette between 1.00:1 and 2.64:1, with the `green`
clone at exactly 1.00, invisible. `palette.ts` owns the three neutrals and the two contrast
derivations, and the reason the ink is restricted to pure black and pure white is that it makes
the floor provable rather than measured — best-of-the-two can never fall below 4.58:1 for any
sRGB colour, so every hue anyone appends to the palette is readable without anybody checking.
`test/contrast.test.ts` is what holds that, and it is a case where a golden capture structurally
cannot help: it records what the colours are and says nothing about whether one reads on the
other.

**tmux is exercised; two of the four emulators are not.** Against tmux 3.7c here: a session per
clone with a window per role, read back by role in `tabs[]` order, four sessions carrying four
distinct hues with no global leak, a clone raised and a clone reattached with its scrollback
intact, and a real `SYNC PAUSE` landed in the pane on a named tty and — confirmed with
`capture-pane` — in **no** other of four. iTerm2 is exercised on this machine. Konsole and GNOME
Terminal are written from Konsole's documented D-Bus interface and gnome-terminal's documented
command line and have **not been exercised against live ones** — macOS is the platform this fleet
runs on, and what is unverified there is which window comes up, not what happens inside it, which
is tmux either way. `hangar doctor` prints the detected emulator and the state of the tmux server,
which is the first thing to look at.

## What `colours sync` generates

**The rule that settles every naming question here: what a hangar writes OUTSIDE its own root
carries its id; what it writes inside does not.** `~/.claude` is the same directory for every
hangar on the machine, so the statusline script and the theme files are `<id>-clone-…`; the two
shell helpers at the hangar root are inside it, and their FUNCTION names still carry the id
because two hangars can be sourced into one shell. Renaming any of them is a three-phase
operation rather than an edit -- see `hangar-internals/reference/doctor.md`.

The hues are data in **`src/palette.ts`** and everything else is derived from them: shimmer is the
main hue 40% of the way toward white, border is main x 0.8, statusline dim is main x 0.6. So these
four files are **generated by `hangar colours sync` — never hand-edit them**:

- `~/.claude/<id>-clone-statusline.sh` — **one script, all clones of one hangar.** It derives the hue from the
  clone directory in its stdin payload rather than hardcoding one, so every clone runs identical
  code. Shows `● clone_NN · branch · model`.
- `~/.claude/themes/<id>-clone-NN-*.json` — one per clone, structurally identical, differing only
  in hue (`claude`, `claudeShimmer`, `briefLabelClaude`, `promptBorder`, `promptBorderShimmer`).
- `clone-colours.sh` — the hue table for shell consumers. `hangar_dvb_gn_colour <clone>` prints
  `<r;g;b> <xterm-256 index> <name> <ink> <bar text>`. **The function name carries the hangar id**
  because two hangars can be sourced into one shell, and a bare name would have the last one
  sourced answer for both. **Fields are appended, never reordered** — `$1..$3` are what a
  developer's own prompt may already read out of `set --`, and the split in `clone-terminal.sh`
  has to move in the same edit: a split whose last step is `name=${rest#* }` takes everything
  after that space, so an appended field lands inside `$name` and is exported as
  `HANGAR_CLONE_COLOUR`, with every gate still green.
- `clone-terminal.sh` — the terminal colour hook, sourced from `~/.zshrc` or `~/.bashrc`.
- `clone-tmux.conf` — the config this hangar's own tmux server starts under
  (`tmux -L hangar-<id> -f <this>`). It carries no per-clone hue: that is a session option `open`
  sets when it creates a clone's session, and the window options are the hook's. It does carry the
  **status bar's own neutral background and text**, which are hangar-level and which nothing else
  can set — see the contrast note above. It holds the four settings Claude Code documents for
  running inside tmux, two of which are SERVER options and are the reason the socket is private at
  all. **It is read once, when the server starts**, so regenerating it reaches nothing already
  running — `hangar doctor` reads the live server's options back and says when they disagree, and
  `--fix` deliberately will not `kill-server`, because that would end every live agent in the
  fleet. **`colours sync` closes most of that gap without a restart:** every option the bar needs
  is a global _session_ option, so it writes them onto a running server and re-paints each live
  session's badge and windows. `kill-server` is left as the answer for the two settings that
  genuinely are server-scope, which is the only thing it was ever needed for.

Not generated, because it holds no per-clone data: each clone's untracked
`.claude/settings.local.json` (`theme` + the shared `statusLine`).

**Claude Code takes arbitrary 24-bit hex in a custom theme** — the generated
`~/.claude/themes/<id>-clone-NN-*.json` files already do exactly that for `claude`,
`claudeShimmer`, `briefLabelClaude`, `promptBorder` and `promptBorderShimmer` — so the palette is
limited by what a human can tell apart at a glance, not by anything Claude Code enforces. It
holds 16 hues; the last four fill the gaps left by the first twelve and are the least
distinguishable, so low indices stay the good ones.

Two consumers cannot source
`clone-colours.sh` and carry their own copy — the theme JSONs (static JSON) and the statusline
script (self-contained so it can never fail) — but both are generated from the same data, so
they cannot drift. A theme change needs a Claude Code restart in that clone to show up.

## What is tracked at the hangar root, and what is generated

**This inventory used to be in the root `CLAUDE.md`, which every clone session pays for and no
clone session can act on.** It moved here because a session editing `app/src/**` is the only one
that needs it — the same reason the rest of this file is here.

One rule decides every row: _a tracked file that a `hangar` command rewrites is a merge conflict
on every `git pull` from a published upstream._

| Not tracked                                                | Written by                             |
| ---------------------------------------------------------- | -------------------------------------- |
| `hangar.config.yaml` — **the marker file**                 | `hangar setup`                         |
| `CLAUDE.local.md` — this hangar's identity                 | `setup`, `doctor --fix`                |
| `.claude/settings.json`                                    | `setup`, `doctor --fix`                |
| `clone-colours.sh`, `clone-terminal.sh`, `clone-tmux.conf` | `hangar colours sync`                  |
| `.hangar/colour-assignments.json` — **INPUT**              | `hangar colours change` — nothing else |
| `.hangar/claude-tmux.conf`                                 | `hangar claude`, every run             |

Tracked: this file, the root `CLAUDE.md`, `bin/**`, `.local/bin/**`, `app/**`, `.envrc`,
`.envrc.hangar`, `.nvmrc`,
`.editorconfig`, `hangar.config.example.yaml`, `hangar.schema.json`, `.gitignore`, `CHANGELOG.md`,
`package.json` (scripts and nothing else — see the top of this file), `.releaserc.json`,
`.claude/**` except the
generated `settings.json`, and the two `.gitkeep` files under `plans/` and `tmp/`. Never the
application.

Five of those rows are worth a sentence each:

- **`.hangar/claude-tmux.conf` gets no `doctor` row and no `.gitignore` line of its own**, and
  the reason is which command owns it. `colours sync` writes `clone-tmux.conf` and `doctor`
  byte-compares it, because nothing else would notice it going stale. `hangar claude` rewrites
  this one immediately before it starts the server that reads it, so stale is not a state it can
  reach — and `.hangar/` is already gitignored. It is also why `.local/bin/claude` is TRACKED
  rather than generated: the shim holds no machine-specific value, so there is nothing to
  generate and nothing to drift.
- **`.hangar/colour-assignments.json` is the only file here that is both untracked and
  irreplaceable** — operator input that nothing regenerates. It has its own gitignore entry rather
  than sitting under the `.hangar/` line, because that line is documented as safe-to-delete
  generated state and clearing a corepack cache must not take the colours with it. The old
  root-level path is read as a permanent fallback, and `doctor --fix` migrates it byte for byte.
- **`.claude/modes/{ops,dev}.settings.json` stay tracked despite naming an absolute path**, and
  that is a security property: their permission arrays are operator mode's boundary, and operator
  mode may run `hangar doctor`. `hangar-internals/reference/modes.md` has the reasoning and the
  three alternatives that were rejected.
- **`CHANGELOG.md` is generated AND tracked, and that is not an exception to the rule above.**
  That rule is about files whose content differs PER HANGAR — a config, an identity file, a
  palette rendered for this hangar's clones. The CLI's own release history is the same in every
  hangar, so a pull brings the upstream copy and there is nothing local for it to conflict with.
  Only semantic-release writes it, and only on `main`.
- **The gated golden baseline is entirely portable and entirely tracked**, which is what makes
  `git diff --exit-code dev/golden/gated` mean the same thing in every clone of this repo. The
  capture of THIS hangar is still taken and is worth reading, but it lands under the gitignored
  `dev/golden/advisory/` — a gitignored path INSIDE `gated/` would have made the gate cover less
  than its own name says. See `dev/golden/README.md`.

## The hangar root files this package owns

The code is in `app/`, but files one level up are generated out of it — so changing their source
and not regenerating them leaves a hangar that contradicts itself. Nothing catches that: there is
no hook in `.git/hooks`.

| Change this in `app/src/**`                                                                | Regenerate with        | Which rewrites                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------ |
| `config/schema.ts`                                                                         | `hangar config schema` | `hangar.schema.json` — **tracked**                                             |
| `palette.ts`, `generate/colours-sh.ts`, `generate/terminal-sh.ts`, `generate/tmux-conf.ts` | `hangar colours sync`  | `clone-colours.sh`, `clone-terminal.sh` **and** `clone-tmux.conf` — gitignored |
| any new config key                                                                         | by hand                | `hangar.config.example.yaml` — **tracked**                                     |

**Only one generated root file is still tracked, and the rule that decides it is publication:** a
tracked file that a `hangar` command rewrites is a merge conflict on every `git pull` from
upstream. `hangar.schema.json` survives because nothing but `hangar config schema` writes it and
its content is the same in every hangar; the two shell helpers do not, because `colours sync`
rewrites them from the palette, the hangar id and the clone list. `git rm --cached` left both on
disk, so no shell rc that sources `clone-terminal.sh` broke.

- **`hangar config validate` now also compares `hangar.config.example.yaml` with the live file**,
  whenever the two declare the same `id`. The invariant was stated in
  `hangar-internals/reference/config.md` from the start and run by nothing, and the pair had
  drifted by the worst available line: `forge.defaultBranch`, `main` in the committed example
  against `master` live. A colleague adopting this fleet by copying the example — which is the
  fastest and most correct way in — got a config naming a branch the repo does not have. The
  `id` gate is what keeps the check quiet in a hangar the example is only a template for.
- **`hangar config schema --check` fails instead of writing**, which makes it the fourth thing to
  run after touching `config/schema.ts`. Both YAML files open with
  `# yaml-language-server: $schema=./hangar.schema.json`, so a stale committed schema silently
  validates every editor against last week's shape — invisible until someone opens the file.
- **`clone-colours.sh` and `clone-terminal.sh` are gitignored**, like the artifacts under
  `~/.claude/` (one statusline plus one theme per clone) — so a `palette.ts` edit no longer puts
  two hangar-root files into your commit, and **nothing in git records that they are stale.** Both
  are headed `GENERATED by hangar colours sync -- do not edit by hand`, and
  `hangar colours sync -n` reports whether they are current: that dry run is now the only check
  there is, so run it after a palette change rather than looking at `git status`.
- **`hangar.config.example.yaml` is the committed record and a faithful SUPERSET of the
  gitignored live `hangar.config.yaml`.** A new schema key belongs there too — with its default,
  and any alternative as a **comment** beside the one live choice, because `superRefine` rejects
  two uncommented alternatives. `hangar config show` on each must differ only in the free-text
  `_` note; `hangar-internals/reference/config.md` has why the pair is shaped this way.

Five more root files are hand-maintained and belong to this package rather than to the fleet:

- **`bin/hangar`** — a short `sh` entry point. It resolves the hangar root from **its own
  location** and never from `$PWD`, then `exec`s `node "$hangar/app/src/cli.ts"`. A Node flag, or a
  move of the entry point, is edited here rather than in `app/`. It uses **`${0%/*}` and two
  builtins rather than `dirname`**, because it also has to work when PATH is degraded — with
  `dirname` unavailable the substitution came back empty, the root resolved to `/`, and the advice
  below printed a path to somewhere nobody asked about.
  It carries **the one check that has to run before Node does**: no `node` on PATH, or no
  `app/node_modules`, and it names which of the two and the command that fixes it. That check
  cannot live in `app/`, because the failure it reports is the CLI being unable to load at all —
  Node's own `ERR_MODULE_NOT_FOUND` stack trace is the first thing a fresh clone of this repo
  would otherwise see. **`jira hook` is exempt and exits 0 silently**, for the same reason
  `cli.ts`'s config gate exempts it: a non-zero exit from a `PreToolUse` hook blocks the tool call.
- **`.envrc.hangar`** — `hangar_use_node`, `hangar_use_pnpm`, `hangar_use_gnu`. **Functions only,
  no side effects**: direnv's `source_env` does a `pushd` into this file's own directory, so a
  relative path written here would resolve against the hangar root instead of the caller, and
  every caller invokes the functions itself. `.envrc` is the only consumer today; `.envrc.clone`
  becomes the second at B7. `hangar_use_gnu` resolves the Homebrew prefix in three steps —
  `HOMEBREW_PREFIX`, then `/opt/homebrew`, then `brew --prefix` — and `environment.ts`'s
  `resolveBrewPrefix` does the same three in the same order, deliberately. The probe is last and
  conditional in both: an Intel Mac without `brew shellenv` in its profile has the variable unset,
  and stopping at the default aborted the whole `.envrc` on a machine that has Homebrew.
- **`.local/bin/claude` and `bin/hangar-statusline`, plus the five files in `.claude/modes/`** —
  `ops.md`, `dev.md`, a `*.settings.json` beside each, and `statusline.sh`. **`hangar claude` is
  the one way into either mode** (`src/commands/claude.ts`): it opens both as tabs of one tmux
  session on its own socket — with a third tab holding a plain shell at the hangar root, which is
  not a mode and takes no `-m` — and a bare `claude` at the hangar root reaches it through the
  shim. A mode is `--settings` + `--append-system-prompt-file` + `-n`, read once at startup, and
  `dev`'s working directory is `app/` so that THIS file is loaded from its first turn.
  **`statusline.sh` badges the window `OPS` / `DEV` / a red `NO MODE`**, taking the mode from its
  own argv or from `$HANGAR_MODE` — which `hangar claude` sets per tmux window and nothing else
  may, since from `.envrc` it would reach every shell in the hangar and make the badge
  meaningless.
  **The shim cannot be a shell function in `.envrc.hangar`**: direnv exports an environment diff,
  and a function is not an environment variable — `PATH_add` is what actually reaches the shell.
  **It also cannot be in `bin/`**, and that is the one thing to know before moving it: every
  clone's `.envrc.private` repeats `PATH_add <hangar>/bin` so `hangar` works from inside a clone,
  so a `claude` there would have been on PATH in every clone shell, where `terminal.tabs[]`'s
  default `command: 'claude'` starts each clone's own session. `.local/bin` gets its own
  `PATH_add` in the hangar's `.envrc` alone. That same mechanism is why the two settings files say
  **`hangar-statusline <mode>` rather than an absolute path**: a tracked file cannot name one
  machine's home directory, and a session running in a mode is proof direnv loaded, because the
  `hangar` that started it was found the same way. All seven are **hand-maintained, so they add no
  row to the derivation table above and need no `--check`** — nothing derives them from
  `app/src/**`. Operator mode is denied writes to `app/**`, `.claude/skills/**` and
  `.claude/modes/**`, **and is denied `hangar claude` itself**, which means **developer mode is
  the only one that can improve operator mode's instructions**; that asymmetry is the reason the
  pair exists, and the denial is what stops a pass-through `-p` from getting around it.
  `hangar-internals/reference/modes.md` has the rationale, including why the root `CLAUDE.md`
  cannot be suppressed for either of them, the socket and the singleton rules, four probes that
  answered wrongly, and two more that could not answer at all — the status line does not run
  under `claude -p`, and `$CLAUDE_PROJECT_DIR` is not exported to tool subprocesses.
- **`.nvmrc` and `app/.nvmrc`** are a pair, both `24`. Move them together.
- **`.claude/skills/**` is tracked, and both skills are artifacts of this package.** A command
  whose flags change is a `hangar-ops/reference/commands.md` edit; a design decision that changes
  is the matching `hangar-internals/reference/*.md`. That edit starts on this side of the
  boundary, which is why it is named here and not only in the skills.

**One thing that looks broken and is not: `pnpm --version` differs by directory.** corepack reads
`packageManager` from the NEAREST `package.json` walking up, so inside `app/` it answers the
pinned 11.7.0, while the hangar root — which has no `package.json`, deliberately and permanently —
answers corepack's own bundled default. `app/` is the only place pnpm is ever run, so the pin
governs every real invocation. `.envrc.hangar` records this beside `hangar_use_pnpm`; do not
"fix" it.

## Do not run project work from the hangar root

**`ng`, `jest`, `playwright`, the project's lint and format and the project skills all require a
clone's root** (or its `angular/` subdirectory) as the working directory, and the repo's
`SessionStart` hooks resolve paths via `git rev-parse --show-toplevel`, which fails here. Start a
session in the clone instead. The CLI's own checks are the exception and are the ones above, from
`app/`.

`.gitignore` here is load-bearing, not leftover: `clone_*/`, `.env.shared`, `node_modules/`,
`plans/`, `tmp/` and `hangar.config.yaml` are the only reason the clones, the secrets, the CLI's
dependencies, the plan archive, the shared scratch directory and this machine's own config stay
out of the hangar repo. Do not remove any of those lines. (`clone_*/`, not `clone_0*/`: the old
glob stopped matching at `clone_10`. And `hangar.schema.json` stays TRACKED — it is generated
from the zod schema, and both YAML files point at it for editor validation.)

## Where the rationale is

Everything about _why_ each command is built the way it is lives in the **`hangar-internals`**
skill: why `sync` asks Bitbucket for a branch's pull-request target instead of guessing, why
`merge-default` reads the invocation out of `process.argv`, how `tmp merge` collapses a ticket's
many cached names onto one inode, what `ide vscode sync` rewrites per clone and what it refuses to
write, what `doctor` checks and the two rules for anything generated into a clone, the Jira hook's
fail-open design, and why `forge.defaultBranch` is stored rather than derived.

Load it before editing anything here. Its `SKILL.md` is a short index; the depth is in
`reference/{sync,jira-cache,editors,terminal-and-sessions,config,doctor}.md`, which are not loaded
until they are read — so take the one that matches the subsystem you are touching rather than all
six.

**The reason those notes read the way they do:** the test suite is a seed covering the pure core,
so for everything outside it every "this exists because it caught something" paragraph is still the
regression record. When you change behaviour there,
update the note; when you tidy prose, leave them alone.
