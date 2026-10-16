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
> clone file outside `angular/` reads. A `"type": "module"` here would break things: it
> flipped `clone_NN/.claude/hooks/*.js` to ESM, so every one of them died with
> `ReferenceError: require is not defined in ES module scope` at session start, and
> `npm pkg get name` run at a clone root answered the fleet's package. That is why the CLI is in
> `app/`.
>
> **There is one file at that level, and it is scripts and nothing else.** The root
> `package.json` exists so `pnpm release` and the other gates can be run from the hangar root
> instead of `cd app` first, and it declares **no `dependencies`, no `devDependencies`, no
> `"type"`, no `workspaces` and no `packageManager`** — which is what keeps the paragraph above
> true rather than merely historical. `app/pnpm-workspace.yaml` stays the workspace root and
> `app/pnpm-lock.yaml` stays the lockfile.
>
> **`dev/scrub-check.sh` enforces that shape, because the obvious guard does not work.** A
> `preinstall` script exiting 1 is measured not to work: **pnpm 10 did not run it** — not
> even with a dependency present to install (probed both ways; `pnpm run preinstall` fires,
> `pnpm install` does not), and npm skipped it too. That probe predates the 12.8.2 pin and has
> not been repeated on it; the gate holds either way. So a stray `pnpm install` here still leaves an
> empty `node_modules`, which resolves nothing and harms nothing. What must never happen is this
> file growing something to put in it, and that is the line the gate holds.
> The same stray install writes an empty `pnpm-lock.yaml` beside it, which is why that path is
> gitignored at the root: `app/pnpm-lock.yaml` is the only lockfile.

**There is no build step.** Node strips the types and runs `src/cli.ts` directly, so an edit is
live the moment it is saved and there is nothing to rebuild before trying it.

**The package manager is pnpm**, pinned by `packageManager: "pnpm@12.8.2"` in `app/package.json`,
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

**`pnpm scan` is two gates and they are not interchangeable**: `scan:secrets` is gitleaks over
the history, `scan:literals` is `dev/scrub-check.sh` over the tree, and gitleaks measurably misses
a low-entropy pasted password that the second one catches (`hangar-internals/reference/release.md`
has the canary). Both also run in `app/.husky/pre-commit` and inside `hangar dev release`.

`pnpm` is not assumed to be on PATH: the hangar root's `.envrc` runs `hangar_use_pnpm` (defined
in `.envrc.hangar`), which has corepack write its shims into the gitignored `.hangar/pnpm-bin/`
and puts that directory on PATH — alongside `hangar_use_node .nvmrc`, `hangar_use_gnu`, `PATH_add bin`,
`PATH_add .local/bin` (the `claude` shim that picks a mode) and `PATH_add app/node_modules/.bin`
— which is how `tsc`, `eslint` and `prettier` are reached. If any of those commands is not found, the answer is
almost always that direnv has not loaded: run `direnv allow` at the hangar root.

**Prefer bullet lists to wide tables in any CLAUDE.md under `app/`.** `format:check` pads every row
to the widest cell, so one long cell inflates the whole table, and a wide
code-by-role table runs to ~14k characters, mostly spaces. Keep table cells short.

**`hangar_use_gnu` puts GNU coreutils first on PATH, so `sed -i` takes no `''` argument.** The
BSD spelling fails partway through a multi-file edit, and a half-edited `src/**` is live at once
— every clone's `SessionEnd` hook runs this working tree.

**Dev-mode Bash runs zsh:** `$VAR` holding `cmd -flag` is not word-split, so call
`/opt/homebrew/bin/tmux -L hangar-<id> …` directly, `type -P` does not exist (use `command -v`),
and an unquoted glob that matches nothing is an error (`--include=*.ts`, `echo ===`), so quote it.

**The exec guard matches `hangar exec` anywhere in a Bash command, heredoc text included** — an
edit script that quotes it as an anchor is refused. Put such a script in a scratchpad file and run
`python3 -I <file>`.

**Search a clone with `git -C <clone> grep`, never `grep -r`**: a clone carries `node_modules`
and a multi-GB `tmp/`, and `grep -r` over one runs past the Bash timeout.

**Probe git behaviour with a script file in the scratchpad** (`sh probe.sh`, its repo under
`mktemp -d`): a long one-line probe that creates commits is refused permission.

**Probe Claude Code permissions with `claude -p … --permission-mode acceptEdits < /dev/null`** in
a `mktemp -d` project with its own `.claude/settings.local.json` — `default` mode refuses every
write, inside the project too, so it cannot tell a rule from no rule. One measured answer: a
file-write deny is an `Edit(...)` rule, and `Write(...)` deny rules are never matched.

**Probe a command's file I/O in a throwaway hangar, never the live fleet**: a scratchpad `.ts` that
imports `test/fixture.ts`'s `syntheticHangar({ root: mkdtempSync(…), configText })` and `src/**` by
absolute path, `git init`s each `cloneAt(hangar, i).path`, and runs with `node probe.ts` from `app/`.

**Run a generated script against the live fleet without installing it**: after `pnpm golden`,
`sed 's#%HANGAR%#<root>#g' dev/golden/advisory/hangar/normalised/artifacts/<file>` into the
scratchpad and run that copy — e.g. `sh <copy> footer clone_01 <root>/clone_01` renders the real
footer before `colours sync` has been run.

**`advisory/` moves with the live fleet** (process counts, the PR cache, new commits), so prove
a change left this hangar alone by copying `dev/golden/advisory` to the scratchpad BEFORE the
edit and diffing after; only `artifacts/` and `builders/` count.

**Test a `scrub-check.sh` pattern with a canary in a TRACKED file** — it is `git grep` over the
working tree, so an untracked file is never scanned: back the file up, append the canary, run
`sh dev/scrub-check.sh`, restore it and check `git diff --quiet` before anything is committed.

**Stage part of a file without `git add -p`** (interactive, unsupported here): filter the hunks
of `git diff -U3 -- <file>` in a scratchpad script and pipe them to `git apply --cached --recount -`.

**A palette or ink change is invisible to `pnpm golden` outside six hues**: both fixtures have
three clones, `fixture` on built-in slots 6–8 (`palette.rotate: 5`) and `fixture-vscode` on its own
`palette.hues`, so `test/contrast.test.ts` is the only net for every other built-in hue — a
comment-only golden diff there is expected, not proof of no change.

**Measure a VS Code extension from its bundle**,
`~/.vscode/extensions/<publisher.name>-<ver>/dist/*.js`: slice around a match with `python3 -I`
(`s.find(…)`), because `grep -oE` refuses a `{0,300}` context. Its workspace-scoped state is SQLite
at `~/Library/Application Support/Code/User/workspaceStorage/<hash>/state.vscdb`
(`workspace.json` beside it names the workspace); open it with `sqlite3 'file:…?mode=ro'`.

## Two conventions for changing it, and the two nets behind them

Both conventions exist because they caught something, and both apply to every edit under
`app/src/**`.

- **Anything that produces text for a human or an agent gets a PURE builder, given its facts and
  exported.** Every variant can then be printed side by side without constructing the state that
  produces it, which is how `sync`'s eight closing messages were checked — and it found two bugs
  reading the code had not: one froze an agent after a SUCCESSFUL sync, the other told it a
  branch had moved when nothing was integrated. This convention predates the test suite and is
  what made one possible at all: every assertion in `test/` is a call to a pure builder.
- **Derive state at the moment you report it; carry a flag only for what git cannot know.** A
  `restored` boolean set beside a `git stash pop` lies whenever the pop fails, which it can — it
  only warns. Ask `inProgressOperation`, `conflictedFiles`, `syncStashes` instead. Whether an
  integration got committed is the one thing git cannot answer, so that one is carried, and a
  carried flag needs guarding for the paths that do nothing (`up-to-date` integrates nothing).
- **A per-hangar value handed to a pure helper is a REQUIRED parameter, never one defaulted to
  the built-in.** A default compiles at every call site and silently answers for the wrong
  hangar; a required one makes `tsc` name each caller (that is how `colourFor`'s six were found).

The two nets:

- **`pnpm golden` is the first convention, mechanised.** It captures every artifact this hangar
  would write — through the same pure builders `doctor` compares against and `add-clone` writes —
  and records each one's **destination** alongside its content, because every path in this CLI is
  a bare `string` and a builder rendering perfect text into the wrong file passes a content-only
  diff. `gated/` renders from the two checked-in fixtures and is expected to diff for NOBODY, on
  any machine — the platform rows of each `manifest.txt` are the one legitimate exception.
  `advisory/` is never a gate. **Adding a kind or a key means asking which of the two fixtures
  should carry it**, and **an unenumerated diff is the finding**: write the expected delta down
  before making the change. `dev/golden/README.md` has why each of those holds.
- **`pnpm test` covers what a capture structurally cannot, and nothing else.** `app/test/`, run by
  `node --test` with no flags — Node 24 strips the types, and `test/**/*.ts` is in the tsconfig
  include so the suite is checked under the same strict flags as `src/`. Four things live there
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
    bytes are; only this says what they may never contain — and three of the six (`clone_NN`
    and `clone_0`, from the default `clone_` prefix, and `.env.local`) follow from schema
    defaults, so a fixture agreeing with a default could not have shown them. `hangar-internals/reference/doctor.md` has the table.

  Everything runs against a synthetic root and a synthetic `~/.claude`, and that is a requirement:
  `makeClone` reads `.hangar/colour-assignments.json` under the hangar root and caches it per
  root, so a test aimed at this hangar would read one developer's own `colours change` history.
  `namesNoMachinePath` in `test/fixture.ts` is the standing guard.

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

Three consequences worth knowing before editing the files they touch:

- **`hangar.config.example.yaml` is a superset of the live config EXCEPT for five keys.**
  `displayName`, `profile`, `forge.originUrl`, `forge.webBaseUrl` and `tracker.baseUrl` are
  placeholders, and `configDrift` in `config/drift.ts` excludes exactly those from the
  example-vs-live comparison. Everything else is still held equal — `forge.defaultBranch`
  included, which is the line that comparison was written for after the pair silently drifted.
- **The live config's `keyPrefixes` value never appears as a literal in the tree.** The guards
  that forbid it import `THIS_REPOS_TICKET_PREFIX` from `test/fixture.ts`, which builds it by
  concatenation, and `dev/scrub-check.sh` refuses the prefix with or without a digit after it, so
  a placeholder key is caught too. It is the **bare prefix** rather than a whole key, twice over:
  it forbids every ticket rather than one, and a whole key is exactly what a bulk
  find-and-replace over the tree would rewrite — leaving a guard that guards nothing while every
  check stays green. `dev/scrub-check.sh` writes each pattern so it cannot match itself
  (`datav[a]ult`, `__D[V]B_`, `D[N]-`) for the same reason, and needs no allow-list at all as a
  result.
- **A config key that names a repo's own skill or prompt is optional with NO default**
  (`forge.prDescriptionPrompt`, `tracker.planPrompt`): absent means the command refuses and names
  the key, because a default would put one repo's skill name into every hangar.

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

**Types** are `@commitlint/config-conventional`'s. What they mean here — `feat` adds a command, a
flag, a seam, a driver or a generated artifact; `fix` corrects behaviour that was wrong; `docs` is `CLAUDE.md`,
the README or the skills and nothing else.

**Scopes** are the subsystem: `sync` `checkout-default` `doctor` `open` `close` `reload` `edit`
`browse` `tmp` `plans` `pr` `jira` `jira-plan` `colours` `config` `editor` `terminal` `platform`
`setup` `add-clone` `remove-clone` `install` `resume` `ide` `status` `list` `golden` `cli` `fleet`
`ports` `bookmarks` `modes` `exec` `servers` `allow` `waypoint` `commit-gate` `rewrite` `skills`
`scrub` `teach-rg` `test` `mcp` `release` `deps` — `modes` covering `hangar up`/`down` and the
shim, `release` being `hangar dev release`, and also the scope semantic-release gives its own
`chore(release)` commits. That list is documented and deliberately
**not** enforced — a `scope-enum` rule goes red the first time somebody adds a subsystem, and this
repo already knows what a check that is red in normal operation is worth.

**commitlint differs from `config-conventional` twice**: `header-max-length` is 120 and
`subject-case` is off, because the defaults reject this repo's own Sentence-case history.
`body-max-line-length` stays at the default 100 and `footer-leading-blank` is left warning.
A body line that starts with `word:` is parsed as a footer and trips that warning — rewrap so no
line begins with a lone word and a colon.
`hangar-internals/reference/release.md` has why each is set the way it is.

**No `!` and no `BREAKING CHANGE:` footer while the CLI is 0.x.** Several changes here are
breaking by content, and marking them would cut a 1.0.0 nobody decided on. `hangar dev release`
refuses such a commit rather than escalating, and names it.

**The hooks are `pnpm hooks`, once per clone of this repo, by hand** — `pnpm-workspace.yaml` sets
`ignoreScripts: true`, so husky's `prepare` never runs. `commit-msg` is commitlint; `pre-commit`
is `pnpm scan` on what is STAGED, and skips gitleaks with a message when it is not installed. They
are fast feedback only: **`hangar dev release` is the enforcement** — every gate, `commitlint`
over the range since the last tag, and a missing gitleaks is an error there. Its
`--skip-checks` skips the gates (for a run straight after doing them by hand) and nothing else:
the preflight, the breaking-marker refusal and the confirmation still run. There is no CI.

**`pnpm release` cuts one, from a terminal and never from CI.** `-n` changes nothing and is the
first thing to run. **Read `hangar-internals/reference/release.md` before editing
`.releaserc.json`, `app/changelog.preset.ts`, `dev/changelog.sh` or the release command**, and
before rewriting history: a root rebase cannot run in a live hangar.

## The code, by role

**`commands/doctor.ts` and `commands/sync.ts` are the two worth reading in full before changing
either** — they are the two largest files here, and the two whose mistakes reach a live working
tree. Files are named here without sizing them on purpose, this pair included: a
count here goes stale on the next commit and nothing checks it, so run `wc -l` when you want one.

The layout under `src/` is what `ls` shows; only what a listing cannot say is kept here:

- **`cli.ts`** — every command, option and alias is registered here, plus the `preAction` config
  gate and the `configureHelp` that prints all of a command's aliases.
  A name that must stay out of `--help` is a second `program.command(name, { hidden: true })`
  registration, never an `.alias()`.
- **`commands/dev.ts` and `commands/release.ts`** — `hangar dev golden`, the capture behind
  `pnpm golden`, and `hangar dev release`, the gates and preflight in front of semantic-release
  (`release/commits.ts` reads the range). **Both are hidden in `cli.ts`, and that is their interface
  contract**: nothing about either is promised to an operator, so neither gets a row in
  `hangar-ops/reference/commands.md`. `dev` is deliberately NOT in `NEEDS_NO_CONFIG` — a capture, or
  a release, derived from a hangar with no config would be derived from the schema defaults, the one
  output neither may be mistaken for.
- **`config/`** — `schema.ts` is the zod authority; `load.ts` is discovery and precedence;
  `drift.ts` is the example-vs-live comparison `config validate` runs; `presets.ts` is what `setup`
  SUGGESTS for the two questions no checkout can answer.
- **`clone-config.ts`** — the byte-compared builders `doctor` holds every clone to.
  **`hangar-files.ts`** is its pair for the files a hangar writes into its OWN root; every one of
  them names this machine's home directory, which is what puts them on the untracked side of the
  inventory below.
- **`generate/index.ts`** — the dry-run-aware writer every generator goes through.
- **`git.ts`'s `git` / `gitOut` / `gitTry` are how anything that CHANGES a clone runs git.** They
  set no editor AND `GIT_REFLOG_ACTION=hangar`, which is how `jira-plan` tells hangar's own branch
  moves from a person's; a raw `run('git', …)` skips both without anything noticing. The few raw
  calls left (`config/derive.ts`, `commands/plans.ts`) only read.
- **`commands/vscode.ts`** — despite the name, the generic `editorSync` behind every
  `ide <kind> sync`, not only VS Code's.
- **`exec.ts`** — `run`, `runCaptured` and `CliError`, the subprocess wrappers; **`template.ts`**
  — the `{token}` renderer every configurable path and URL goes through.
- **`bitbucket.ts`** — the forge client; `pr-cache.ts` is the bar's on-disk pull-request record;
  `pr-description.ts` FINDS the description the repo's own agent wrote, never writes one.
- **`jira.ts`** — issue keys, URLs and inferring a branch's ticket; `jira-records.ts` — the
  shared record store and its names. The hook itself is `commands/jira.ts`.
- **`procs.ts`** — live Claude Code processes and dev-server listeners; `sessions.ts` — which
  plan files a live agent holds; `claude-sessions.ts` — the transcripts `resume` picks from.
- **`bookmarks/`** — the browser bookmark drivers behind `bookmarks sync`; **`release/`** — commit
  parsing for `hangar dev release`; **`platform/`** — the platform seam below.
- **`mcp/`** — `tools.ts` (which commands are exposed, and the schema read off the commander
  registry) and `server.ts` (the stdio JSON-RPC loop). **Nothing here may import `ui.ts`**: stdout
  is the protocol.
- **`terminal/`** — one window-opener per emulator. Everything a window CONTAINS is `tmux.ts`.

`app/test/` (beside `src/`, not in it) is run by `pnpm test`; `test/fixture.ts` builds the
synthetic hangar they all use.

**Five seams**, each a capability record plus a driver interface rather than a pretence that the
implementations are equivalent. Adding a kind means implementing the interface and registering it;
callers degrade one capability at a time instead of branching on a product name:

- `editor/types.ts` — `EditorCapabilities` / `EditorDriver`; the kind is declared in
  `editor/kinds.ts` and dispatched to its driver in `editor/index.ts`'s `driverFor`
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

**A platform assumption fails silently rather than loudly**: this fleet runs on macOS, and three
`darwin`-only paths returned plausible wrong answers instead of errors — one of them opened a
second window on an open workspace, which is how two Claude Code sessions end up in one clone.
`hangar-internals/reference/terminal-and-sessions.md` has the capability table and the one open
question the seam does not answer.

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
tmux session**. The emulator only opens a window and raises one; everything inside is
`src/tmux.ts`. Three rules hold everywhere:

- **The server is Hangar's own, `tmux -L hangar-<id>`** — the options Claude Code needs are
  server-wide, and never written onto somebody else's server. A bare `tmux ls` does not see it.
- **Identity is the session NAME**, so "is this clone open" is `has-session` — the check that
  keeps a clone from getting two Claude Code sessions, this fleet's worst failure.
- **Nothing is ever typed at a raw tty**; tmux is the only portable mechanism.

`hangar-internals/reference/terminal-and-sessions.md` has the rest: the emulator table, the tmux
layer, the colour hook, the bar, the contrast proof and the pull-request cache.

## What operator mode reaches instead of a shell

`hangar mcp` serves one MCP tool per command over stdio, and `hangar up` hands both modes
`.claude/modes/mcp.json` as `--mcp-config`. **It exists for a permission reason:** an MCP rule has
no arguments to widen across, so `doctor` and `doctor_fix` are two names with two rules, and so is
every `<thing>_preview` against the command it previews.

- **A tool call spawns `bin/hangar`; it never calls the command in-process**, and **nothing under
  `src/mcp/` may import `ui.ts`** — stdout is the protocol.
- **Anything `server.ts` puts in a spawned child's env (`NO_COLOR`) reaches whatever that child
  starts and outlives it**, a tmux server most of all. Scrub at the spawn site (`tmux.ts`'s
  `scrubbedEnv`).
- **`src/mcp/tools.ts` is the table and the commander registry is the schema**, so a flag is
  declared once.
- **Adding a command means adding an exposure AND a rule in `ops.settings.json`** — `ask` for
  anything that acts unless it says `preapproved: true`. `test/mcp-tools.test.ts` holds the two
  together, and `hangar mcp` names any command it found no tool for on stderr.
- **A command operator mode must not run needs a `Bash(hangar <name>)` + `Bash(hangar <name>:*)`
  deny pair for EVERY name it answers to, hidden ones included** — a rule matches only the start
  of the string, so renaming `up` without its pair reopens the escalation with every gate green.
- **`exec` is never exposed, and no agent may run it at all.** `bin/hangar-exec-guard` refuses it
  from a `PreToolUse` hook however it is spelled; the `Bash(hangar exec)` deny entries are the
  weaker half, because a rule matches only the START of a command string.

`hangar-internals/reference/modes.md` has the rest — which commands are not tools and why, the
measured separation, why a call is a subprocess, and why the Bash path stays open.

## What `colours sync` generates

**What a hangar writes OUTSIDE its own root carries its id; what it writes inside does not** —
except shell FUNCTION names, because two hangars can be sourced into one shell. Renaming any of
them is a three-phase operation rather than an edit (`hangar-internals/reference/doctor.md`).

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

`hangar-internals/reference/colours.md` has what each file carries and why.

## What is tracked at the hangar root, and what is generated

**This inventory is here rather than in the root `CLAUDE.md`** because every clone session pays
for that file and none can act on this; a session editing `app/src/**` is the only one that needs
it — the same reason the rest of this file is here.

One rule decides every entry: _a tracked file that a `hangar` command rewrites is a merge conflict
on every `git pull` from a published upstream._

Not tracked, and what writes each:

- `hangar.config.yaml` — **the marker file** — `hangar setup`
- `CLAUDE.local.md` — this hangar's identity — `setup`, `doctor --fix`
- `.claude/settings.json` — `setup`, `doctor --fix`
- `clone-colours.sh`, `clone-terminal.sh`, `clone-tmux.conf`, `clone-tmux-status.sh` —
  `hangar colours sync`
- `.hangar/colour-assignments.json` — **INPUT** — `hangar colours change`, nothing else
- `.hangar/port-pins.json` — **INPUT** — `hangar ports pin` / `unpin`, nothing else
- `.hangar/claude-tmux.conf` — `hangar up`, every run
- `.hangar/pnpm-bin/` — corepack's pnpm shims — direnv, through `hangar_use_pnpm`
- `app/.claude/plans/`, `.remember/` — developer-mode session state, not a `hangar` command's

Tracked: this file, the root `CLAUDE.md`, `README.md`, `bin/**`, `.local/bin/**`, `app/**`,
`.envrc`, `.envrc.hangar`, `.nvmrc`, `.editorconfig`, `.gitleaks.toml`,
`hangar.config.example.yaml`, `hangar.schema.json`, `.gitignore`, `CHANGELOG.md`,
`package.json` (scripts and nothing else — see the top of this file), `.releaserc.json`,
`personal-skills/**` (the overrides `hangar skills sync` links into `~/.claude/skills`, tracked so
a shadow that goes stale is a diff rather than a silence), `.claude/**` except the
generated `settings.json`, and the two `.gitkeep` files under `plans/` and `tmp/`. Never the
application.

Five of those look like exceptions and are not:

- **`.hangar/claude-tmux.conf`** gets no `doctor` row: `hangar up` rewrites it immediately before
  starting the server that reads it, so stale is not a state it can reach
  (`hangar-internals/reference/modes.md`).
- **The two `.hangar/` INPUT files** are the only untracked files here that nothing regenerates,
  which is why each has its own `.gitignore` line, with its reason, rather than riding on the
  safe-to-delete `.hangar/` one. `colour-assignments.json` is also read from its old root-level
  path, permanently.
- **`.claude/modes/{ops,dev}.settings.json`** stay tracked despite naming an absolute path: a
  generated copy would let operator mode rewrite its own permission list through `doctor --fix`.
  `hangar-internals/reference/modes.md` has the three alternatives that were rejected.
- **`CHANGELOG.md`** is generated AND tracked because its content is the same in every hangar
  (`hangar-internals/reference/release.md`).
- **`dev/golden/gated/`** is tracked and portable; the capture of THIS hangar lands in the
  gitignored `advisory/`, never in a gitignored path inside `gated/` (`dev/golden/README.md`).

## The hangar root files this package owns

The code is in `app/`, but files one level up are generated out of it — so changing their source
and not regenerating them leaves a hangar that contradicts itself. Nothing catches that: there is
no hook in `.git/hooks`.

Each entry is the source in `app/src/**`, the command that regenerates, and what it rewrites:

- `config/schema.ts` → `hangar config schema` → `hangar.schema.json` (**tracked**)
- `palette.ts` and `generate/*.ts` → `hangar colours sync` → the four root shell/tmux files
  listed under **What `colours sync` generates** (gitignored)
- any new config key → by hand → `hangar.config.example.yaml` (**tracked**)

- **`hangar config schema --check` after touching `config/schema.ts` — and when `zod` moves.**
  A stale committed schema silently validates every editor against last week's shape;
  `hangar-internals/reference/config.md` has why the library is the second input.
- **`hangar colours sync -n` after a palette change.** The shell helpers are gitignored, so
  nothing in git records that they are stale and that dry run is the only check there is.
- **A new schema key goes into `hangar.config.example.yaml` too** — with its default, and any
  alternative as a **comment** beside the one live choice, because `superRefine` rejects two
  uncommented alternatives. `config validate` compares the example with the live file whenever
  the two share an `id`, and `config show` on each must differ only in the free-text `_` note.

More root files are hand-maintained and belong to this package rather than to the fleet:

- **`bin/hangar`** — a short `sh` entry point that resolves the hangar root from **its own
  location**, never `$PWD`, and checks for `node` and `app/node_modules` before Node runs. A Node
  flag is edited here rather than in `app/`. It uses `${0%/*}` rather than `dirname`, and
  **`jira hook` exits 0 silently** there, because a non-zero `PreToolUse` exit blocks the tool
  call. `hangar-internals/reference/config.md` has why each holds.
- **`.envrc.hangar`** — `hangar_use_node`, `hangar_use_pnpm`, `hangar_use_gnu`. **Functions only,
  no side effects**, and its Homebrew lookup moves in step with `environment.ts`'s
  `resolveBrewPrefix`; `hangar-internals/reference/root-tools.md` has why.
- **`.local/bin/claude` and `bin/hangar-statusline`, plus the six files in `.claude/modes/`** —
  `ops.md`, `dev.md`, a `*.settings.json` beside each, the shared `mcp.json`, and `statusline.sh`.
  **The shim is the one way into either mode**: a bare `claude` at the hangar root is operator
  mode and one in `app/` is developer mode, exactly those two directories, and it writes each
  mode's four flags in the one place they exist. `hangar up` (`src/commands/up.ts`) runs it in
  two tmux tabs beside a shell, and `hangar down` (`down.ts`) is the way out. `dev`'s working
  directory is `app/` so that THIS file loads from its first turn — which is also why
  `app/.claude/settings.json` exists, for `plansDirectory`.
  - **The shim cannot move into `bin/`**: every clone puts `bin/` on PATH, so a `claude` there
    would replace each clone's own session command.
  - **The shim is live the moment it is saved**: every `claude` typed at the root or in `app/`,
    and both `hangar up` tabs, run it. Edit a scratch copy, run `test/claude-shim.test.ts`
    against it (the test copies the file into a temp hangar with a fake `claude`), then `mv` it
    into place.
  - **The mode settings name `hangar-statusline` and `hangar-exec-guard` by bare name**, because
    a tracked file cannot name one machine's home; a clone's untracked settings name the guard
    absolutely.
  - **All eight are hand-maintained** — no derivation-table row, no `--check`. Only the
    `mcp__hangar__*` half of `ops.settings.json` is derived, held to `src/mcp/tools.ts` by
    `test/mcp-tools.test.ts` rather than by a writer, so operator mode cannot rewrite its own
    permission list.
  - **Operator mode is denied writes to `app/**`, `.claude/skills/**` and `.claude/modes/**`, and
    `hangar up`/`down` themselves**, so developer mode is the only one that can improve its instructions.
  - **The rest is in `hangar-internals/reference/modes.md`** — the shim's PATH rules, the badge,
    the socket and singleton rules, and the probes that answered wrongly; `doctor.md` has the
    `plansDirectory` measurement.
- **`bin/hangar-waypoint`, `bin/hangar-commit-gate`, `bin/hangar-rewrite`, `bin/hangar-exec-guard`
  and `personal-skills/`** — scripts rather than `hangar` subcommands, because the gate runs before
  EVERY Bash call and `cli.ts` costs ~0.25s to load. They are CommonJS, so do not "modernise" them
  to `import`. **Edit a scratch copy and `mv` it into `bin/`: each is live fleet-wide the moment it
  is saved.** Keep the copy's own name in a scratch DIRECTORY (`node --check` refuses `*.new`),
  and probe the gate from a copy under a temp hangar root: it works out where its lock file
  lives from its own location. `test/personal-tools.test.ts` bans this repo's own names (its
  `THIS_REPOS_OWN`) anywhere in waypoint and the gate, comments included.
  `hangar-internals/reference/root-tools.md` has what each refuses and why,
  including `hangar-rewrite`'s published-commit rule, the `personal-skills/` manifest row a new
  skill needs, and how to test any of them.
- **`.nvmrc` and `app/.nvmrc`** are a pair, both `24`. Move them together.
- **`.claude/skills/**` is tracked, and both skills are artifacts of this package.** A command
  whose flags change is a `hangar-ops/reference/commands.md` edit (the tables and tool map; the
  per-command traps are in `command-notes.md`); a design decision that changes
  is the matching `hangar-internals/reference/*.md`. That edit starts on this side of the
  boundary, which is why it is named here and not only in the skills.
  **A claim corrected in one prose surface is usually stated in another**: grep its key phrase
  across both `CLAUDE.md` files, `.claude/modes/*.md` and both skills before committing. The
  root file's "reach outside this machine" was also in `ops.md`.

**One thing that looks broken and is not: `pnpm --version` differs by directory** — corepack
reads the nearest `packageManager`, and the root `package.json` declares none. Do not "fix" it;
`.envrc.hangar` has why, beside `hangar_use_pnpm`.

## The root `.gitignore`

`.gitignore` here is load-bearing, not leftover, and its comments carry the reasons — read them
before touching a line. Three things about it are easy to break:

- **The clones, the secrets file, the two shared directories and the stray lockfile are ANCHORED**
  (`/clone_*/`, `/.env.shared`, `/plans/`, `/tmp/*`, `/pnpm-lock.yaml`). An unanchored `clone_*/`
  matched a directory of that name anywhere in the tree and silently dropped 15 of the 136 files
  golden captured at the time. `node_modules/` stays unanchored on purpose.
- **`/tmp/*`, never `/tmp/`**: git does not descend into an excluded directory, so a `!`
  exception for a file under `tmp/` only works under the `*` form.
- **The secrets entries are `/.env.shared`, `.env.local` and `/.env`** — the last has no file and
  is listed because `.envrc` would load one. `hangar.schema.json` stays TRACKED.

## Where the rationale is

Everything about _why_ each command is built the way it is lives in the **`hangar-internals`**
skill. Load it before editing anything here. Its `SKILL.md` is a short index; the depth is in
`reference/*.md`, one subsystem each, which are not loaded until they are read — so take the one
that matches the subsystem you are touching rather than all of them.

**The reason those notes read the way they do:** the test suite is a seed covering the pure core,
so for everything outside it every "this exists because it caught something" paragraph is still the
regression record. When you change behaviour there,
update the note; when you tidy prose, leave them alone.
