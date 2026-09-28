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

**The package manager is pnpm**, pinned by `packageManager: "pnpm@11.26.0"` in `app/package.json`,
which is the single source of truth for both the shell and CI. Run the CLI's own checks **from
`app/`** — they cover the CLI, not the app:

```bash
cd app && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
# pnpm lint:fix and pnpm format write; format:check is what a commit gate wants
# prettier never rewraps a comment and eslint has no max-len: wrap comments at 100 by hand
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

**`hangar_use_gnu` puts GNU coreutils first on PATH, so `sed -i` takes no `''` argument.** The
BSD spelling fails partway through a multi-file edit, and a half-edited `src/**` is live at once
— every clone's `SessionEnd` hook runs this working tree.

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
    fewer than `PORT_CAPACITY` whole steps apart.
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

**Commits go straight to `main`** — no feature branch unless the user asks for one.
`.claude/modes/dev.md` says why.

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

**Scopes** are the subsystem: `sync` `doctor` `open` `tmp` `plans` `pr` `jira` `colours` `config`
`editor` `terminal` `platform` `setup` `add-clone` `install` `resume` `ide` `status` `golden`
`cli` `fleet` `ports` `modes` `exec` `servers` `allow` `waypoint` `commit-gate` `skills` `scrub`
`test` `mcp` `release` `deps` — `release` being `hangar dev release`, and also the scope
semantic-release gives its own `chore(release)` commits. That list is documented and deliberately
**not** enforced — a `scope-enum` rule goes red the first time somebody adds a subsystem, and this
repo already knows what a check that is red in normal operation is worth.

Three commitlint rules are worth knowing. The two in `.commitlintrc.json` differ from the defaults
because the defaults reject this repo's own history; the third is the default, kept:

- **`header-max-length` is 120, not 100.** A Sentence-case subject that says what changed routinely
  runs past 100 once `type(scope): ` is in front of it, and cutting hand-written subjects down to
  fit a round number is the wrong side of that trade.
- **`subject-case` is off.** `config-conventional` forbids Sentence case, which is the case every
  subject in this repo is written in.
- **`body-max-line-length` is left at 100** and needs no exception: no hand-written body exceeds
  it. The long lines in `chore(release)` bodies are semantic-release's changelog links.

`footer-leading-blank` warns on a good share of the history and is left warning. The parser reads
any `word: value` line in a prose body as a footer token, and these bodies are full of them
(`kind: none`, `type: module`). Reflowing bodies to satisfy a heuristic would damage the record to
silence a warning that blocks nothing.

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
semantic-release. There is no CI workflow: the release these gates protect cannot run from CI, and
`hangar-internals/reference/release.md` says why.

**A missing gitleaks is an error there, not a skip.** The hook's leniency is deliberate and stays
— a per-machine developer tool must not block a commit — but a release cut without a history scan
is a release nobody scanned, so `dev/scan-secrets.sh` exits 1 with `brew install gitleaks` and the
preflight stops.

**`hangar doctor` deliberately gets no row for `core.hooksPath`.** Every hangar root is a clone of
this repo, but only a CLI developer ever commits in one — an operator's hangar would carry that
row red forever, which is the check nobody reads.

### Releasing

**`pnpm release` cuts one, from a terminal.** It is `hangar dev release`, and it runs this repo's
gates and then hands over to **semantic-release**, which does the release itself from
`.releaserc.json`: the version, the CHANGELOG, the bump, the release commit, the tag, the push and
the GitHub release. `-n` runs the gates and `semantic-release --dry-run`, changing nothing, and it
is the first thing to run. `-y` releases without asking.

**It runs from a terminal and not from CI** because semantic-release versions from the tags it can
see: a checkout that sees none on origin treats the next release as the first and publishes
1.0.0. A developer's machine has the local tags; `--no-ci` is what makes that run legal, and
weakens nothing.

What the command adds is what semantic-release will not do for itself:

- **The preflight** — on `main`, clean tree, not behind origin, a token in `GH_TOKEN` or
  `GITHUB_TOKEN`, and **local tags agreeing with `git ls-remote --tags origin`**. Each is one
  sentence before anything starts.
- **A refusal on a breaking marker while the CLI is 0.x**, naming the commits.
  `release/commits.ts` finds them; `test/release-commits.test.ts` pins both footer spellings and
  the `!`, because missing one IS the failure.
- **Every gate**, since there is no CI to run them — including `commitlint` over the range.
- **A confirmation** that reads `/dev/tty` and **fails closed where there is none**; `-y` is the
  only way past it.

**`.releaserc.json`, `app/changelog.preset.ts` and `dev/changelog.sh` are load-bearing** — the
section list, the patch-level types, the hidden `chore(release)` entry whose POSITION matters, the
`# Changelog` heading. `pnpm changelog` producing no diff at a released state is the check that
they hold. Read `hangar-internals/reference/release.md` before editing any of them.

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

**`commands/doctor.ts` and `commands/sync.ts` are the two worth reading in full before changing
either** — they are the two largest files here, and the two whose mistakes reach a live working
tree. The table names files without sizing them on purpose, this pair included: a
count here goes stale on the next commit and nothing checks it, so run `wc -l` when you want one.

| Role                  | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entry point           | `cli.ts` — every command, option and alias is registered here, plus the `preAction` config gate and the `configureHelp` that prints all of a command's aliases                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| maintainer            | `commands/dev.ts` — `hangar dev golden`, the capture behind `pnpm golden`; `commands/release.ts` — `hangar dev release`, the gates and preflight in front of semantic-release, with `release/commits.ts` beside it reading the range. **Both are hidden in `cli.ts`, and that is their interface contract**: nothing about either is promised to an operator, so neither gets a row in `hangar-ops/reference/commands.md`. `dev` is deliberately NOT in `NEEDS_NO_CONFIG` — a capture, or a release, derived from a hangar with no config would be derived from the schema defaults, the one output neither may be mistaken for |
| commands              | `commands/*.ts`, one per command: `sync`, `doctor`, `tmp`, `jira`, `setup`, `open`, `checkout-default`, `vscode`, `plans`, `add-clone`, `resume`, `colours`, `status`, `remove-clone`, `teach-rg`, `config`, `ports`, `list`, `install`, `claude`, `browse`, `close`, `reload`, `pr`, `mcp`, `exec`, `edit`, `servers`, `allow`, `scrub`, `skills`                                                                                                                                                                                                                                                                              |
| config                | `config/schema.ts` (the zod authority), `default-branch.ts`, `load.ts` (discovery + precedence), `derive.ts`, `json-schema.ts`, `drift.ts` (the example-vs-live comparison `config validate` runs), `presets.ts` (what `setup` SUGGESTS for the two questions no checkout can answer)                                                                                                                                                                                                                                                                                                                                           |
| per-clone artifacts   | `clone-config.ts` — the byte-compared builders `doctor` holds every clone to; `colour-assignments.ts`; `ports.ts`; `port-pins.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| hangar-root artifacts | `hangar-files.ts` — the pair to `clone-config.ts`, for the files a hangar writes into its OWN root. Every one of them names this machine's home directory, which is what puts them on the untracked side of the inventory below                                                                                                                                                                                                                                                                                                                                                                                                 |
| generators            | `generate/` — `terminal-sh.ts`, `tmux-conf.ts`, `tmux-status-sh.ts`, `claude-tmux-conf.ts`, `statusline-sh.ts`, `colours-sh.ts`, `theme-json.ts`, `index.ts` (the dry-run-aware writer)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| tool server           | `mcp/` — `tools.ts` (which commands are exposed, and the schema read off the commander registry), `server.ts` (the stdio JSON-RPC loop). **Nothing here may import `ui.ts`**: stdout is the protocol                                                                                                                                                                                                                                                                                                                                                                                                                            |
| editor drivers        | `editor/` — `vscode.ts`, `jetbrains.ts`, `index.ts`, `kinds.ts`, `types.ts`, `launch-only.ts`, `emacs.ts`, `vim.ts`, `zed.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| emulator drivers      | `terminal/` — one window-opener each: `iterm2.ts`, `apple-terminal.ts`, `konsole.ts`, `gnome-terminal.ts`, `none.ts`, plus `applescript.ts`, `index.ts`, `types.ts`. Everything a window CONTAINS is `tmux.ts`, in the shared row                                                                                                                                                                                                                                                                                                                                                                                               |
| platform              | `platform/` — `darwin.ts`, `linux.ts`, `index.ts`, `types.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| git / forge / tracker | `git.ts`, `bitbucket.ts`, `jira-records.ts`, `jira.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| fleet                 | `fleet.ts` — clone discovery, and everything per-clone derived from the index                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| tests                 | `test/**/*.test.ts` — run by `pnpm test`; `test/fixture.ts` builds the synthetic hangar they all use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| shared                | `dedupe.ts`, `pr-cache.ts`, `pr-description.ts`, `claude-sessions.ts`, `resolve-conflicts.ts`, `claude-headless.ts`, `procs.ts`, `plans.ts`, `environment.ts`, `install.ts`, `secrets.ts`, `tui.ts`, `palette.ts`, `tmp.ts`, `sessions.ts`, `adopt.ts`, `ui.ts`, `hangar.ts`, `user-paths.ts`, `template.ts`, `exec.ts`, `tmux.ts`                                                                                                                                                                                                                                                                                              |

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
`resolve-conflicts.ts` reads `ORCH_UTIL_RESOLVE_TIMEOUT_MS`, the one `ORCH_UTIL_` name in the
CLI. Everything else about paths is threaded, never a module constant: hangar-derived paths are
`HangarPaths`, handed down from `cli.ts` because a value derived from a root read from a file
cannot be evaluated at import time; `homedir()` paths are `user-paths.ts`; and the forge and
tracker locations are config (`forge.originUrl`, `tracker.{baseUrl,issueUrlTemplate}`), never
literals.

## Which editors it opens

**VS Code is the default and the only editor that has to work; every other kind is best effort**,
and only the VS Code path is exercised — nothing else is installed on this machine. That is a
rank enforced in code: `DEFAULT_EDITOR_KIND` in `editor/kinds.ts` is the one place that names it,
and every configured driver is built, probed and launched inside its own catch, so a clone
configured `[zed, vscode]` cannot lose VS Code to Zed's launcher. `hangar ide <kind> sync` is the
deliberate exception: there the developer named the editor, so its failure is the answer.

**Trackedness is a floor, never a verdict.** `launch.json` and `tasks.json` are compared and never
written, and any artifact a clone turns out to track is protected too — never the reverse.

`hangar-internals/reference/editors.md` has the table of which kind launches how and syncs what,
why only the VS Code family needs `rootPathKeys` and deduplicating, and the `vim`, `xcode` and
`eclipse` decisions; `terminal-and-sessions.md` has why `close` closes an editor window and
`reload` does not reload one.

## Which terminal it drives, and what tmux owns

`hangar open` gives a clone **one tab of the developer's emulator**, attached to **that clone's
tmux session** — one tmux window per `terminal.tabs[]` role. The emulator is asked for two things
only: **open one tab or window running one command**, and **bring one it opened to the front**.
Everything inside — the roles, their names and order, typing a `SYNC PAUSE` into a live session —
is `src/tmux.ts`, the same program on macOS and Linux. Raising is the only capability a caller
degrades around; a driver that cannot open a window is `none`, which is a mode, not a failure.

**The server is Hangar's own: `tmux -L hangar-<id>`, from a config this CLI generates**, because
the settings Claude Code needs there (`extended-keys` among them) are SERVER options, and writing
those onto the server somebody keeps their own work on is not this tool's trade to make. These
sessions are invisible to a bare `tmux ls`.

**Identity is the session NAME, not a tag stamped on a window**, so "is this clone already open"
is `has-session` rather than an inference — the check that keeps a clone from getting two Claude
Code sessions, this fleet's worst failure. **Nothing is ever typed at a raw tty**: tmux is the
mechanism precisely because there is no portable other one.

`hangar-internals/reference/terminal-and-sessions.md` has the rest: the emulator capability table
and how the emulator is detected, the tmux layer and the six things it enforces silently, the
colour hook, the two-line bar and the five things tmux would not let it say, the contrast proof
`test/contrast.test.ts` holds, the pull-request cache, and what has and has not been exercised.

## What operator mode reaches instead of a shell

`hangar mcp` serves one MCP tool per command over stdio, and `hangar claude` hands both modes
`.claude/modes/mcp.json` as `--mcp-config`. **It exists for one reason and it is a permission
one:** `Bash(hangar doctor:*)` cannot separate the report from the writer, whereas an MCP rule has
no arguments to widen across — so `doctor` and `doctor_fix` are two names with two rules, and so
is every `<thing>_preview` against the command it previews. That is what makes "run the dry run
first" a property of the tool list rather than a habit.

Three things about it belong here rather than only in the skill:

- **A tool call spawns `bin/hangar`; it never calls the command in-process.** `sync` recovers its
  strategy from `process.argv`, about twenty `console.log` sites bypass `ui.ts`'s `emit`, and
  `captureOutput()` is a module-level global — so an in-process server would silently mis-run
  `sync` and corrupt its own protocol stream. **Nothing under `src/mcp/` may import `ui.ts`.**
- **`src/mcp/tools.ts` is the table and the commander registry is the schema.** Descriptions,
  arguments and `.choices()` are read off `cli.ts`'s own entries, so a flag is declared once; what
  the table adds is the two facts the registry cannot carry — whether an exposure only reports,
  and which flags it fixes. `cli.ts` cannot be imported to reach that registry, because its last
  statement is `program.parseAsync()`; it is handed in from the action instead.
- **Adding a command means adding an exposure.** `hangar mcp` prints the ones it found no tool for
  on stderr when it starts, and refuses outright only for the two errors that would be wrong
  rather than missing: a table naming a command that is not there, and an acting tool whose schema
  offers `dry-run`.

**Coverage is every command but six, and every documented flag but one.** `claude` could only
ever fail (`$CLAUDECODE` refuses on every tool call) and is the boundary the mode pair exists for;
`dev release` completes as a tool only in its `-y` form; `dev golden` would be a partial capture
reading as the gate; `jira hook` takes its payload on stdin; `mcp` is the server itself. **`exec`
is the one excluded for a permission reason rather than a mechanical one**: everything after its
`--` is a shell snippet, so a schema could describe it and never constrain it — which is the only
thing a per-tool rule buys.

**`exec` is also the one command no agent may run at all**, and that is enforced by a hook rather
than by a rule. `bin/hangar-exec-guard` is a `PreToolUse` matcher on `Bash`, wired into both mode
settings files and into every clone's `settings.local.json`; it reads the whole command line and
refuses any invocation of `hangar exec`. The `Bash(hangar exec)` deny entries in both modes stay
beside it, but they are the weaker half and cannot be the only one: a permission rule matches the
START of the command string, so `cd /elsewhere && hangar exec ...` never matches it. The reason
the bar is higher here than for `remove-clone` is not blast radius but generality — a command
that takes an arbitrary snippet can spell every other command that is denied, and it reaches every
clone in one call, which is the rule the fleet's own `CLAUDE.md` is built around. `setup` IS exposed, and that closes a
hole rather than opening one — `modes.md` had it recorded as escalation-adjacent and unlisted, and
it now has a rule in both spellings. The one flag no tool offers is `--quiet`, which exists so a
`SessionEnd` hook and the bar's own spawn can stay silent; a caller reading the result wants the
opposite. A `.hideHelp()` option is dropped by the same rule that keeps it out of `--help`, unless
an exposure names it in `shows` — `add-clone --remote` is the only one that does.

`hangar-internals/reference/modes.md` has the rest — the measured separation, why the Bash path
stays open, and why the enumeration is a test while the coverage is a warning.

## What `colours sync` generates

**The rule that settles every naming question here: what a hangar writes OUTSIDE its own root
carries its id; what it writes inside does not.** `~/.claude` is the same directory for every
hangar on the machine, so the statusline script and the theme files are `<id>-clone-…`; the
shell helpers at the hangar root are inside it, and their FUNCTION names still carry the id
because two hangars can be sourced into one shell. Renaming any of them is a three-phase
operation rather than an edit -- see `hangar-internals/reference/doctor.md`.

The hues are data in **`src/palette.ts`** and everything else is derived from them. These files
are **generated by `hangar colours sync` — never hand-edit them**:

- `~/.claude/<id>-clone-statusline.sh` — one script for every clone of one hangar
- `~/.claude/themes/<id>-clone-NN-*.json` — one per clone, differing only in hue
- `clone-colours.sh` — the hue table for shell consumers, `hangar_<id>_colour <clone>`
- `clone-terminal.sh` — the terminal colour hook and the in-tmux prompt, sourced from the shell rc
- `clone-tmux-status.sh` — every field of the clone bar tmux cannot answer itself
- `clone-tmux.conf` — the config this hangar's tmux server starts under

Two things about them break silently, with every gate green:

- **`clone-colours.sh`'s fields are appended, never reordered**, and the split in
  `clone-terminal.sh` moves in the same edit. A split whose last step is `name=${rest#* }` takes
  everything after that space, so an appended field lands inside `$name` and is exported as
  `HANGAR_CLONE_COLOUR`.
- **`clone-tmux.conf` is read once, when the server starts.** `colours sync` writes every bar
  option onto a running server itself; `doctor --fix` deliberately never runs `kill-server`,
  because that would end every live agent in the fleet.

`hangar-internals/reference/colours.md` has what each file carries and why — the derivations, the
statusline's three measured blind spots, the prompt layer's socket gate, `hangar_<id>_allow`, and
why the status script is shell rather than the CLI.

## What is tracked at the hangar root, and what is generated

**This inventory is here rather than in the root `CLAUDE.md`** because every clone session pays
for that file and none can act on this; a session editing `app/src/**` is the only one that needs
it — the same reason the rest of this file is here.

One rule decides every row: _a tracked file that a `hangar` command rewrites is a merge conflict
on every `git pull` from a published upstream._

| Not tracked                                                                        | Written by                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `hangar.config.yaml` — **the marker file**                                         | `hangar setup`                              |
| `CLAUDE.local.md` — this hangar's identity                                         | `setup`, `doctor --fix`                     |
| `.claude/settings.json`                                                            | `setup`, `doctor --fix`                     |
| `clone-colours.sh`, `clone-terminal.sh`, `clone-tmux.conf`, `clone-tmux-status.sh` | `hangar colours sync`                       |
| `.hangar/colour-assignments.json` — **INPUT**                                      | `hangar colours change` — nothing else      |
| `.hangar/port-pins.json` — **INPUT**                                               | `hangar ports pin` / `unpin` — nothing else |
| `.hangar/claude-tmux.conf`                                                         | `hangar claude`, every run                  |

Tracked: this file, the root `CLAUDE.md`, `bin/**`, `.local/bin/**`, `app/**`, `.envrc`,
`.envrc.hangar`, `.nvmrc`,
`.editorconfig`, `hangar.config.example.yaml`, `hangar.schema.json`, `.gitignore`, `CHANGELOG.md`,
`package.json` (scripts and nothing else — see the top of this file), `.releaserc.json`,
`personal-skills/**` (the overrides `hangar skills sync` links into `~/.claude/skills`, tracked so
a shadow that goes stale is a diff rather than a silence), `.claude/**` except the
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

| Change this in `app/src/**`                                                                                              | Regenerate with        | Which rewrites                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `config/schema.ts`                                                                                                       | `hangar config schema` | `hangar.schema.json` — **tracked**                                                                     |
| `palette.ts`, `generate/colours-sh.ts`, `generate/terminal-sh.ts`, `generate/tmux-conf.ts`, `generate/tmux-status-sh.ts` | `hangar colours sync`  | `clone-colours.sh`, `clone-terminal.sh`, `clone-tmux.conf` **and** `clone-tmux-status.sh` — gitignored |
| any new config key                                                                                                       | by hand                | `hangar.config.example.yaml` — **tracked**                                                             |

**Only one generated root file is tracked, and the rule that decides it is publication:** a
tracked file that a `hangar` command rewrites is a merge conflict on every `git pull` from
upstream. `hangar.schema.json` is tracked because nothing but `hangar config schema` writes it and
its content is the same in every hangar; the two shell helpers are not, because `colours sync`
rewrites them from the palette, the hangar id and the clone list.

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
  **Run it when `zod` moves, too.** The generator's other input is the library, so a
  `toJSONSchema` change across a version leaves exactly the same stale schema with
  `config/schema.ts` untouched and this rule, read by the letter, never firing.
- **`clone-colours.sh` and `clone-terminal.sh` are gitignored**, like the artifacts under
  `~/.claude/` (one statusline plus one theme per clone) — so a `palette.ts` edit puts no
  hangar-root file into your commit, and **nothing in git records that they are stale.** Both
  are headed `GENERATED by hangar colours sync -- do not edit by hand`, and
  `hangar colours sync -n` reports whether they are current: that dry run is the only check there
  is, so run it after a palette change rather than looking at `git status`.
- **`hangar.config.example.yaml` is the committed record and a faithful SUPERSET of the
  gitignored live `hangar.config.yaml`.** A new schema key belongs there too — with its default,
  and any alternative as a **comment** beside the one live choice, because `superRefine` rejects
  two uncommented alternatives. `hangar config show` on each must differ only in the free-text
  `_` note; `hangar-internals/reference/config.md` has why the pair is shaped this way.

More root files are hand-maintained and belong to this package rather than to the fleet:

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
  every caller invokes the functions itself. `.envrc` is the only consumer.
  `hangar_use_gnu` resolves the Homebrew prefix in three steps —
  `HOMEBREW_PREFIX`, then `/opt/homebrew`, then `brew --prefix` — and `environment.ts`'s
  `resolveBrewPrefix` does the same three in the same order, deliberately. The probe is last and
  conditional in both: an Intel Mac without `brew shellenv` in its profile has the variable unset,
  and stopping at the default aborted the whole `.envrc` on a machine that has Homebrew.
- **`.local/bin/claude`, `bin/hangar-statusline` and `bin/hangar-exec-guard`, plus the six files in `.claude/modes/`** —
  `ops.md`, `dev.md`, a `*.settings.json` beside each, the shared `mcp.json`, and `statusline.sh`. **`hangar claude` is
  the one way into either mode** (`src/commands/claude.ts`): it opens both as tabs of one tmux
  session on its own socket — with a third tab holding a plain shell at the hangar root, which is
  not a mode and takes no `-m` — and a bare `claude` at the hangar root reaches it through the
  shim. A mode is `--settings` + `--append-system-prompt-file` + `--mcp-config` + `-n`, read once at
  startup, and `dev`'s working directory is `app/` so that THIS file is loaded from its first
  turn.
  **That working directory is also why `app/.claude/settings.json` exists.** Claude Code reads
  project settings from the session's OWN directory and does not walk up, so the hangar root's
  generated `.claude/settings.json` — the shared memory, the mode badge, `plansDirectory` —
  reaches operator mode and not this one. Developer mode's plans were falling back to
  `~/.claude/plans`, in with every other project on the machine; that file carries the one key
  that points them at `app/.claude/plans/` instead, and is tracked because a relative value
  names no machine path. **They stay there** — nothing collects them into `plans/` the way a
  clone's are, and nowhere outside `app/` is reachable to write them to in the first place:
  `plansDirectory` is resolved against the project root and rejected if it escapes, symlinks
  followed, so `../plans` and an absolute hangar path both fall back silently.
  `hangar-internals/reference/doctor.md` has the measurement.
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
  **`hangar-statusline <mode>` and `hangar-exec-guard` rather than absolute paths**: a tracked
  file cannot name one machine's home directory, and a session running in a mode is proof direnv
  loaded, because the `hangar` that started it was found the same way. **A clone's settings name
  the guard absolutely instead**, and that is not an inconsistency — that file is untracked, and
  a clone session may have been started by something other than `hangar open`, so its PATH proves
  nothing. All nine are **hand-maintained, so they add no
  row to the derivation table above and need no `--check`** — nothing derives them from
  `app/src/**`. The one thing that IS derived is the `mcp__hangar__*` half of
  `ops.settings.json`, and it is held to `src/mcp/tools.ts` by `test/mcp-tools.test.ts` rather
  than by a writer, because a command that regenerated that file would let operator mode rewrite
  its own permission list. Operator mode is denied writes to `app/**`, `.claude/skills/**` and
  `.claude/modes/**`, **and is denied `hangar claude` itself**, which means **developer mode is
  the only one that can improve operator mode's instructions**; that asymmetry is the reason the
  pair exists, and the denial is what stops a pass-through `-p` from getting around it.
  `hangar-internals/reference/modes.md` has the rationale, including why the root `CLAUDE.md`
  cannot be suppressed for either of them, the socket and the singleton rules, four probes that
  answered wrongly, and two more that could not answer at all — the status line does not run
  under `claude -p`, and `$CLAUDE_PROJECT_DIR` is not exported to tool subprocesses.
- **`bin/hangar-waypoint` and `bin/hangar-commit-gate`** — the two personal tools every clone gets
  on PATH, and the reason both are scripts rather than `hangar` subcommands is the one
  `hangar-exec-guard` already records: the gate is a `PreToolUse` hook that runs before EVERY Bash
  call, where loading `cli.ts` costs ~0.25s of type stripping against a bare node start, and the
  waypoint is typed often enough for the same argument to hold. They are CommonJS, because the
  hangar root's `package.json` declares no `"type"` — do not "modernise" them to `import`.
  `waypoint` is pre-approved WHOLE, `restore` included, and that rests on two properties together:
  a restore records an undo snapshot before it writes, AND it refuses any path resolving to the
  repo root. The gate is pre-approved only as `status`; `lock`, `release` and `unlock` prompt,
  because an agent that can release its own gate has no gate — and the hook refuses those verbs
  and any command naming its own state file, because a permission rule matches only the START of
  a command string and `hangar-commit-gate status && … release` sails straight past one.
- **`bin/hangar-rewrite`** — amend, fixup, autosquash, rebase and reset, for history that has
  never been published. A blanket "never rewrite" rule is a proxy for the thing that actually
  matters, which is never rewriting what other people already have; this enforces the real rule
  instead of the proxy, by refusing any commit reachable from a remote-tracking ref. Every verb
  records a waypoint first, so all of it is undoable. **It is deliberately absent from
  `personalToolAllows`** — rewriting history should be asked for, never reached for, and absence
  is what makes every call prompt. **A verb that replays commits must never exit with the
  operation stopped**: a repo rule that denies `git rebase` denies `--abort` and `--continue` with
  it, so the verb aborts itself and says so. Arguments naming `origin`, `push` or `remote` are
  refused, which is why `rebase` takes a bare branch name. **Test it in a scratchpad fixture,
  never a clone, and publish by fetching**: `hangar-exec-guard` refuses `git push` even to a bare
  scratch remote, so the fixture fetches the branch into its upstream (`git fetch ../w feat:feat`)
  instead. Edit a scratch copy and `mv` it into `bin/`, because the file is live fleet-wide the
  moment it is saved.
- **`bin/hangar-exec-guard` also refuses publishing**, and the remit widened with `hangar-rewrite`
  rather than before it: a rewritten branch has diverged from its remote, which is the one moment
  a force-push looks like the obvious next step. The capability and the refusal were one decision.
  It covers `push`, `send-pack`, `http-push`, `gh pr create|merge` and hangar's own
  `pr create|update` unless the invocation carries `-n`, token-based so
  `git log --grep=push` and a file called `push.ts` survive. A managed repo may forbid pushing in
  its own rules; this is not per-project, and holds in a fresh clone and in a repo that has no
  such rule.
- **`personal-skills/` is tracked, and is the one thing this repo writes OUTSIDE its own root.**
  `hangar skills sync` links `~/.claude/skills/<name>` at it, which shadows a same-named project
  skill entirely and silently. **It is also the one artifact that cannot carry the hangar id** —
  the directory name is what makes a skill shadow, so `<id>-<name>` would shadow nothing. The
  collision with a second hangar is therefore made INSPECTABLE rather than named away: `sync`
  reads the existing link's target and refuses when it belongs elsewhere. `--adopt` replaces a
  real directory only when its content already matches byte for byte, so the failure mode is a
  refusal and never a discarded edit.
  **A new skill there also needs a row in `personal-skills/manifest.yaml`** — `name`, a
  `divergence` (`standalone` when no tracked skill carries its name) and a `reason` — then
  `hangar skills sync -n`, `sync` and `list` to link it.
- **`.nvmrc` and `app/.nvmrc`** are a pair, both `24`. Move them together.
- **`.claude/skills/**` is tracked, and both skills are artifacts of this package.** A command
  whose flags change is a `hangar-ops/reference/commands.md` edit; a design decision that changes
  is the matching `hangar-internals/reference/*.md`. That edit starts on this side of the
  boundary, which is why it is named here and not only in the skills.
  **A claim corrected in one prose surface is usually stated in another**: grep its key phrase
  across both `CLAUDE.md` files, `.claude/modes/*.md` and both skills before committing. The
  root file's "reach outside this machine" was also in `ops.md`.

**One thing that looks broken and is not: `pnpm --version` differs by directory.** corepack reads
`packageManager` from the NEAREST `package.json` walking up, so inside `app/` it answers the
pinned 11.26.0, while the hangar root — whose `package.json` is scripts only and declares no
`packageManager`, deliberately and permanently — answers corepack's own bundled default. Every
root script is `pnpm --dir app`, so the pin governs every real invocation. `.envrc.hangar` records this beside `hangar_use_pnpm`; do not
"fix" it.

## Do not run project work from the hangar root

**`ng`, `jest`, `playwright`, the project's lint and format and the project skills all require a
clone's root** (or its `angular/` subdirectory) as the working directory, and the repo's
`SessionStart` hooks resolve paths via `git rev-parse --show-toplevel`, which fails here. Start a
session in the clone instead. The CLI's own checks are the exception and are the ones above, from
`app/`.

`.gitignore` here is load-bearing, not leftover: `clone_*/`, `.env.shared`, `node_modules/`,
`plans/`, `app/.claude/plans/`, `tmp/` and `hangar.config.yaml` are the only reason the clones,
the secrets, the CLI's dependencies, the plan archive, developer mode's own plans, the shared
scratch directory and this machine's own config stay out of the hangar repo. Do not remove any of those lines. (`clone_*/`, not `clone_0*/`: the old
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
`reference/*.md`, one subsystem each, which are not loaded until they are read — so take the one
that matches the subsystem you are touching rather than all of them.

**The reason those notes read the way they do:** the test suite is a seed covering the pure core,
so for everything outside it every "this exists because it caught something" paragraph is still the
regression record. When you change behaviour there,
update the note; when you tidy prose, leave them alone.
