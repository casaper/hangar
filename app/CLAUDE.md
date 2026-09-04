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

> **Never put a `package.json` (or `node_modules`) in the hangar root itself.** That directory is
> an ancestor of every clone, and Node resolves a file's module type from the nearest
> `package.json` walking up. A clone has no `package.json` at its own root — only in `angular/` —
> so a package there becomes the nearest one for every clone file outside `angular/`. It has
> already broken things once: `"type": "module"` at this level flipped
> `clone_NN/.claude/hooks/*.js` to ESM, so every one of them died with
> `ReferenceError: require is not defined in ES module scope` at session start, and
> `npm pkg get name` run at a clone root answered `dvb-gn-fleet`, meaning an `npm install` there
> would have written to the fleet's package. That is why the CLI is in `app/`.

**There is no build step.** Node strips the types and runs `src/cli.ts` directly, so an edit is
live the moment it is saved and there is nothing to rebuild before trying it.

**The package manager is pnpm**, pinned by `packageManager: "pnpm@11.7.0"` in `app/package.json`,
which is the single source of truth for both the shell and CI. Run the CLI's own checks **from
`app/`** — they cover the CLI, not the app:

```bash
cd app && pnpm typecheck && pnpm lint && pnpm format:check
# pnpm lint:fix and pnpm format write; format:check is what a commit gate wants
pnpm golden && git diff --exit-code dev/golden/gated   # the regression net; see below
```

`pnpm` is not assumed to be on PATH: it lives inside an fnm multishell and so moves when the Node
version moves. The hangar root's `.envrc` activates it through `hangar_use_pnpm` (defined in
`.envrc.hangar`), alongside `hangar_use_node .nvmrc`, `hangar_use_gnu`, `PATH_add bin` and
`PATH_add app/node_modules/.bin` — which is how `tsc`, `eslint` and `prettier` are reached. If any
of those commands is not found, the answer is almost always that direnv has not loaded: run
`direnv allow` at the hangar root.

## Two conventions for changing it

Both exist because they caught something, and both apply to every edit under `app/src/**`.

- **There is no test suite, so anything that produces text for a human or an agent gets a PURE
  builder, given its facts and exported.** Every variant can then be printed side by side
  without constructing the state that produces it, which is how `sync`'s eight closing messages
  were checked — and it found two bugs reading the code had not: one froze an agent after a
  SUCCESSFUL sync, the other told it a branch had moved when nothing was integrated.
- **`pnpm golden` is the first convention, mechanised.** It captures every artifact this hangar
  would write — through the same pure builders `doctor` compares against and `add-clone` writes —
  and records each one's **destination** alongside its content, because every path in this CLI is
  a bare `string` and a builder rendering perfect text into the wrong file passes a content-only
  diff. `dev/golden/README.md` has the detail; three things about it are worth knowing before
  relying on it:
  - **`gated/` is a gate and `advisory/` is not.** Advisory output moves with what the clones are
    doing, and that includes `doctor --all`, `status --all` and the `tmp`/`plans` dry runs, so a
    green command diff proves less than it looks like it does. The builder trees are the net.
  - **`gated/fixture/` is the half that certifies anything.** `dev/fixture.config.yaml` disagrees
    with this hangar's config _and_ with every schema default on purpose. While a config agrees
    with the defaults, "read the config file" and "fell into a catch and used the defaults"
    produce identical output — so a capture of this hangar alone cannot tell a wired reader from
    a swallowed error. The manifest also records the discovery `source` and
    `EditorSelection.fellBack` for exactly that reason.
  - **An expected diff is fine; an unenumerated one is the finding.** Making a config key live for
    the first time is _supposed_ to change the fixture half, and that change is the proof. Write
    the expected delta down before making the change.
- **Derive state at the moment you report it; carry a flag only for what git cannot know.** A
  `restored` boolean set beside a `git stash pop` lies whenever the pop fails, which it can — it
  only warns. Ask `inProgressOperation`, `conflictedFiles`, `syncStashes` instead. Whether an
  integration got committed is the one thing git cannot answer, so that one is carried, and a
  carried flag needs guarding for the paths that do nothing (`up-to-date` integrates nothing).

## The code, by role

68 files, ~15k lines. **`commands/sync.ts` (882 lines) and `commands/doctor.ts` (777) are the two
worth reading in full before changing either** — they are also the two whose mistakes reach a live
working tree. The rest of the table names files without sizing them on purpose: a count here goes
stale on the next commit and nothing checks it, so run `wc -l` when you want one.

| Role                  | Files                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| entry point           | `cli.ts` — every command, option and alias is registered here, plus the `preAction` config gate and the `configureHelp` that prints all of a command's aliases                                                                                                                                                                                                                                                                       |
| maintainer            | `commands/dev.ts` — `hangar dev golden`, the capture behind `pnpm golden`. **Hidden in `cli.ts`, and that is its interface contract**: nothing about it is promised to an operator, so it gets no row in `hangar-ops/reference/commands.md`. It is deliberately NOT in `NEEDS_NO_CONFIG` — a capture of a hangar with no config would be a capture of the schema defaults, the one output this net must never mistake for a real one |
| commands              | `commands/*.ts`, one per command: `sync`, `doctor`, `tmp`, `jira`, `setup`, `open`, `checkout-default`, `vscode`, `plans`, `add-clone`, `resume`, `colours`, `status`, `remove-clone`, `teach-rg`, `config`, `ports`, `list`, `install`                                                                                                                                                                                              |
| config                | `config/schema.ts` (the zod authority), `default-branch.ts`, `load.ts` (discovery + precedence), `derive.ts`, `json-schema.ts`                                                                                                                                                                                                                                                                                                       |
| per-clone artifacts   | `clone-config.ts` — the byte-compared builders `doctor` holds every clone to; `colour-assignments.ts`; `ports.ts`                                                                                                                                                                                                                                                                                                                    |
| generators            | `generate/` — `terminal-sh.ts`, `statusline-sh.ts`, `colours-sh.ts`, `theme-json.ts`, `index.ts` (the dry-run-aware writer)                                                                                                                                                                                                                                                                                                          |
| editor drivers        | `editor/` — `vscode.ts`, `jetbrains.ts`, `index.ts`, `kinds.ts`, `types.ts`, `launch-only.ts`, `emacs.ts`, `vim.ts`, `zed.ts`                                                                                                                                                                                                                                                                                                        |
| terminal drivers      | `terminal/` — `apple-terminal.ts`, `konsole.ts`, `iterm2.ts`, `index.ts`, `types.ts`, `gnome-terminal.ts`, `applescript.ts`, `none.ts`                                                                                                                                                                                                                                                                                               |
| git / forge / tracker | `git.ts`, `bitbucket.ts`, `jira-records.ts`, `jira.ts`                                                                                                                                                                                                                                                                                                                                                                               |
| fleet                 | `fleet.ts` — clone discovery, and everything per-clone derived from the index                                                                                                                                                                                                                                                                                                                                                        |
| shared                | `dedupe.ts`, `claude-sessions.ts`, `resolve-conflicts.ts`, `procs.ts`, `plans.ts`, `environment.ts`, `install.ts`, `tui.ts`, `palette.ts`, `tmp.ts`, `sessions.ts`, `adopt.ts`, `ui.ts`, `paths.ts`, `exec.ts`                                                                                                                                                                                                                       |

**Four seams**, each a capability record plus a driver interface rather than a pretence that the
implementations are equivalent. Adding a kind means implementing the interface and registering it;
callers degrade one capability at a time instead of branching on a product name:

- `editor/types.ts` — `EditorCapabilities` / `EditorDriver`; registered in `editor/kinds.ts`
- `terminal/types.ts` — `TerminalCapabilities` / `TerminalDriver`; registered in `terminal/index.ts`
- `generate/index.ts` — every generated artifact is a pure function of the clone plus a path
- `fleet.ts` — clone discovery is filesystem-only; there is no list of clones in any file

Two things in here are known and deliberate rather than waiting to be found: `paths.ts` still falls
back to `import.meta.dirname` for the hangar root, which is the discovery bug the genericisation
plan's Track B fixes; and `resolve-conflicts.ts` reads `ORCH_UTIL_RESOLVE_TIMEOUT_MS`, the last
`ORCH_UTIL_` name left in the CLI.

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

| kind                                                                      | launch                                              | Hangar syncs                       |
| ------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `vscode` `cursor` `windsurf` `vscodium` `code-insiders` `positron` `trae` | the workspace copy it already has open              | `.vscode/*` + the workspace pair   |
| `jetbrains` (`product:` idea, webstorm, pycharm, …)                       | the clone directory                                 | the shareable half of `.idea/`     |
| `zed`                                                                     | the clone directory                                 | `.zed/settings.json`, `tasks.json` |
| `emacs`                                                                   | `emacsclient -n`, else fresh `emacs`                | `.dir-locals.el`                   |
| `vim`                                                                     | `mvim`/`gvim --remote-silent`, else **a clone tab** | nothing                            |
| `xcode` `eclipse`                                                         | the clone directory                                 | nothing                            |

Four things in that table are decisions rather than gaps:

- **Only the VS Code family needs `rootPathKeys`.** A handful of its settings take an absolute
  path into the checkout and it resolves them against nothing, so those values must differ per
  clone — which is what makes `ide vscode sync` a text transform. Everyone else escapes it:
  JetBrains has `$PROJECT_DIR$`, Zed resolves from the project root itself. So the config's
  cross-check asks "is there a kind that CONSUMES these keys", not "is an editor configured".
- **Only the VS Code family needs deduplicating.** It identifies a workspace by its config
  file's URI, so a clone's two byte-identical `*.code-workspace` twins are two different
  workspaces to it and it has to be handed the copy it already has open. Every other editor here
  keys on the project DIRECTORY and focuses its own window; `focusExisting: false` means "the
  editor handles it", not "expect duplicates". **A fork has its own window-state file**
  (`Cursor`, `Windsurf`, `Code - Insiders`, …) — reading the wrong one answers about another
  application's windows.
- **`vim` may not be a window at all.** With `mvim` or `gvim` it behaves like any other editor.
  With only `nvim`/`vim` it gets **an extra terminal tab in the clone**, built alongside the
  other three so it lands in the fleet window in clone order. Launching terminal vim as a
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

## Which terminal it drives

`open` and `sync`'s `SYNC PAUSE` go through a **terminal driver**, picked from the environment
(`ITERM_SESSION_ID`, `TERM_PROGRAM`, `KONSOLE_VERSION`, `VTE_VERSION`, …), then from what is
running, and overridden by `terminal.kind` in `hangar.config.yaml`. Drivers declare
**capabilities** rather than pretending to be equivalent, and every caller degrades one
capability at a time:

| driver         | tabs | list         | tag                | type into a live tab |
| -------------- | ---- | ------------ | ------------------ | -------------------- |
| iTerm2         | yes  | yes          | yes                | yes                  |
| Terminal.app   | yes  | yes          | via `custom title` | yes                  |
| Konsole        | yes  | with `qdbus` | with `qdbus`       | with `qdbus`         |
| GNOME Terminal | yes  | no           | no                 | **no**               |

iTerm2 is the reference because it is the only one with scriptable per-session **user variables**
— everything `open` does safely (find the fleet window, notice a clone is already open, refuse to
adopt another hangar's window) rests on tagging a tab and reading the tag back. Terminal.app and
Konsole approximate that with a title; GNOME Terminal cannot do it at all, so there `open` says
so once and only appends.

Two consequences worth knowing before debugging either:

- **GNOME Terminal cannot receive a `SYNC PAUSE`.** Not an omission — VTE has no API for it, and
  the generic POSIX route (`TIOCSTI`) has been disabled by default since Linux 6.2. `sync` reports
  every session as missed and asks before touching the clone, which is the right question.
- **Terminal.app needs Accessibility permission** for the terminal you run `hangar` from: its
  `tabs` element is read-only in AppleScript, so a new tab can only be made by sending Cmd-T
  through System Events. `open` checks the tab count actually grew and says what to allow if not.
  It is also the one driver that paints the tab itself (AppleScript at creation), because it
  ignores the escape sequence the shell hook uses — so a Terminal.app tab opened by hand in a
  clone stays uncoloured.

The Linux drivers are written from Konsole's documented D-Bus interface and gnome-terminal's
documented command line, and have **not been exercised against live ones** — macOS is the
platform this fleet runs on. `hangar doctor` prints the detected driver and its capabilities,
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
  `<r;g;b> <xterm-256 index> <name>`. **The function name carries the hangar id** because two
  hangars can be sourced into one shell, and a bare name would have the last one sourced answer
  for both.
- `clone-terminal.sh` — the terminal colour hook, sourced from `~/.zshrc` or `~/.bashrc`.

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

## The hangar root files this package owns

The code is in `app/`, but **three tracked files one level up are generated out of it** — so
changing their source and not regenerating them commits a repo that contradicts itself. Nothing
catches that: there is no hook in `.git/hooks`.

| Change this in `app/src/**`                                       | Regenerate with        | Which rewrites                                 |
| ----------------------------------------------------------------- | ---------------------- | ---------------------------------------------- |
| `config/schema.ts`                                                | `hangar config schema` | `hangar.schema.json`                           |
| `palette.ts`, `generate/colours-sh.ts`, `generate/terminal-sh.ts` | `hangar colours sync`  | `clone-colours.sh` **and** `clone-terminal.sh` |
| any new config key                                                | by hand                | `hangar.config.example.yaml`                   |

- **`hangar config schema --check` fails instead of writing**, which makes it the fourth thing to
  run after touching `config/schema.ts`. Both YAML files open with
  `# yaml-language-server: $schema=./hangar.schema.json`, so a stale committed schema silently
  validates every editor against last week's shape — invisible until someone opens the file.
- **`clone-colours.sh` and `clone-terminal.sh` are tracked**, unlike the artifacts under
  `~/.claude/` (one statusline plus one theme per clone), so a `palette.ts` edit puts two
  hangar-root files into your commit. Both are headed
  `GENERATED by hangar colours sync -- do not edit by hand`, and `hangar colours sync -n` reports
  whether they are current.
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
  becomes the second at B7.
- **`bin/hangar-mode` plus `bin/hangar-ops` / `bin/hangar-dev`, and the five files in
  `.claude/modes/`** — `ops.md`, `dev.md`, a `*.settings.json` beside each, and `statusline.sh`.
  A mode is `--settings` + `--append-system-prompt-file` + `-n`, read once at startup, and `dev`'s
  working directory is `app/` so that THIS file is loaded from its first turn. **`statusline.sh`
  badges the window `OPS` / `DEV` / a red `NO MODE`**, taking the mode from its own argv or
  from `$HANGAR_MODE` — which `bin/hangar-mode` exports and nothing else may, since from `.envrc`
  it would reach every shell in the hangar and make the badge meaningless.
  **The launchers are scripts in `bin/` and cannot be shell functions in `.envrc.hangar`**:
  direnv exports an environment diff, and a function is not an environment variable —
  `PATH_add bin` is what actually reaches the shell. All five are **hand-maintained, so they add
  no row to the derivation table above and need no `--check`** — nothing derives them from
  `app/src/**`. Operator mode is denied writes to `app/**`, `.claude/skills/**` and
  `.claude/modes/**`, which means **developer mode is the only one that can improve operator
  mode's instructions**; that asymmetry is the reason the pair exists.
  `hangar-internals/reference/modes.md` has the rationale, including why the root `CLAUDE.md`
  cannot be suppressed for either of them and four probes that answered wrongly.
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

**The reason those notes read the way they do:** the fleet has no test suite, so every "this exists
because it caught something" paragraph is the regression record. When you change behaviour there,
update the note; when you tidy prose, leave them alone.
