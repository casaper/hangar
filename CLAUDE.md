# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this directory is

`~/code/dvb_gn/` is **not** a clone of the application. It is a container for an arbitrary number
of independent full clones of the same Bitbucket repo
(`git@bitbucket.org:acme/storefront_ui.git`), plus the `hangar` CLI that orchestrates
them. There is no application code here. Everything buildable lives one level down, and the CLI's
own package lives in `app/` — never at this level.

> **Never put a `package.json` (or `node_modules`) in the fleet root itself.** This directory is
> an ancestor of every clone, and Node resolves a file's module type from the nearest
> `package.json` walking up. A clone has no `package.json` at its own root — only in `angular/` —
> so a package here becomes the nearest one for every clone file outside `angular/`. It has
> already broken things once: `"type": "module"` at this level flipped
> `clone_NN/.claude/hooks/*.js` to ESM, so every one of them died with
> `ReferenceError: require is not defined in ES module scope` at session start, and
> `npm pkg get name` run at a clone root answered `dvb-gn-fleet`, meaning an `npm install` there
> would have written to the fleet's package. That is why the CLI is in `app/`.

It _is_ itself a small local-only git repo — branch `main`, no remote — tracking this file,
`bin/hangar`, the CLI package in `app/**`, `.envrc`, `.editorconfig`, the shell helpers,
`colour-assignments.json`, `hangar.config.example.yaml`, `hangar.schema.json`, `.gitignore` and
`.claude/**`. Never the application, and never the two shared directories it now also holds
(`plans/`, `tmp/`).

**`hangar.config.yaml` is the exception, and it is deliberately NOT tracked.** It names this
machine's paths, ports and token variables, so it is gitignored; `hangar.config.example.yaml`
is the committed record, documenting every key, its default and every alternative, and kept a
faithful superset of the live file (identical `hangar config show` output bar the free-text
note). So the recovery from a lost config is `cp hangar.config.example.yaml hangar.config.yaml`,
which is what the error message says — because **every `hangar` command now refuses to run
without that file**: the marker file IS the hangar, and acting without one would mean acting on
schema defaults while looking like a configured run. Two commands are exempt, both because they
have to be: `setup`, which writes the file, and `jira hook`, whose `PreToolUse` contract is
fail-open (a non-zero exit there can block the tool call it exists to accelerate). An *invalid*
config is a different matter and is reported rather than refused — `config validate` and
`doctor` exist to diagnose it, and a gate that parsed the file would stop them before they
could.

Full clones, not `git worktree`: each needs its own `node_modules`, its own dev server, its own
Storybook and its own Playwright run. That is the whole reason the fleet exists.

**This file is a fleet map — who is who, which ports belong to whom, how the clones exchange
commits. It deliberately contains nothing about the application.** All project guidance —
architecture, commands, conventions, agent rules — lives in each clone's own
`CLAUDE.md`, `AGENTS.md`, `.claude/skills/**` and `.claude/agents/**`, is tracked in git, and is
**versioned per branch**. Read it there. Do not copy it up here: content hoisted out of the repo
stops following the branch and silently goes stale.

## The clones

There is **no fixed number of clones and no list of them anywhere.** They are whatever
`clone_NN/` directories exist; everything per-clone is a pure function of the index `N`, so
adding or removing one needs no bookkeeping:

| Derived    | Formula                            |
| ---------- | ---------------------------------- |
| `ng serve` | `4200 + (N-1) * 100`               |
| Storybook  | `6006 + (N-1) * 100`               |
| Playwright | `9323 + (N-1) * 100`               |
| colour     | `PALETTE[N-1]` in `src/palette.ts` |

The colour is the one derived value a human can override — `hangar colours change <clone>
<colour>` — and the only thing in the fleet that needs a file to remember it. See below.

**Run `hangar list` and `hangar ports`; never infer which clones exist from the formula
above, or from anything else in this file.** Clones come and go, and index gaps are normal —
`remove-clone` never renumbers, because renumbering would move another clone's ports out from
under a running server.

A clone is **addressed by its index**: `hangar status 2`, `sync 3`, `open 1` — `clone_02` and
`02` are accepted too. `hangar` prints the index for the same reason (`● 1`), and keeps the
padded `clone_NN` form only where it names a directory you can act on: `status`'s `dir` row, the
sibling remote names, the generated per-clone files, and the messages `sync` types into another
clone's live session.

The colour is not decoration — it is how the developer tells near-identical terminal windows
apart. It is wired the same way in every clone, and none of it is in git (it cannot be:
`.claude/settings.json` is tracked and shared, so a colour set there would apply to every clone
for every developer). The hues are data in **`src/palette.ts`** and everything else is derived
from them (shimmer = main + 40% toward white, border = main x 0.8, statusline dim = main x 0.6),
so these four files are **generated by `hangar colours sync` — never hand-edit them**:

- `~/.claude/dvb-clone-statusline.sh` — **one script, all clones.** It derives the hue from the
  clone directory in its stdin payload rather than hardcoding one, so every clone runs identical
  code. Shows `● clone_NN · branch · model`.
- `~/.claude/themes/dvb-clone-NN-*.json` — one per clone, structurally identical, differing only
  in hue (`claude`, `claudeShimmer`, `briefLabelClaude`, `promptBorder`, `promptBorderShimmer`).
- `clone-colours.sh` — the hue table for shell consumers. `hangar_dvb_gn_colour <clone>` prints
  `<r;g;b> <xterm-256 index> <name>`. **The function name carries the hangar id** because two
  hangars can be sourced into one shell, and a bare name would have the last one sourced answer
  for both.
- `clone-terminal.sh` — the terminal colour hook, sourced from `~/.zshrc` or `~/.bashrc`.

Not generated, because it holds no per-clone data: each clone's untracked
`.claude/settings.local.json` (`theme` + the shared `statusLine`).

### The terminal colour hook

The same hues colour **the terminal** whenever the shell's `PWD` is inside a clone (any
subdirectory included), via `clone-terminal.sh` here. It is a `chpwd` hook (zsh) or a
`PROMPT_COMMAND` entry (bash), not a direnv hook, deliberately: direnv only fires on entering or
leaving a directory that has an `.envrc`, redirects that file's stdout, and has no notion of
"left the fleet entirely", so escape codes emitted from `.envrc` would be both fragile and
incomplete. direnv owns the environment; the shell owns terminal I/O. The hook resets only what
it set, so a tab coloured by hand is left alone — and so that two hangars sourced into one shell
do not undo each other.

It paints **three independent layers**, because the emulators support wildly different amounts:

| layer  | how                                    | where                                        |
| ------ | -------------------------------------- | -------------------------------------------- |
| chrome | iTerm2's OSC 6 tab colour, at full hue | iTerm2                                       |
| chrome | OSC 11 background, darkened to a tint  | Konsole, GNOME Terminal/VTE, xterm, kitty, … |
| chrome | nothing — `hangar open` paints the tab | Terminal.app, which ignores OSC 11           |
| title  | OSC 0 (plus OSC 30 for Konsole's tab)  | everywhere recognised                        |
| env    | `HANGAR_CLONE*` variables              | everywhere, with no terminal support at all  |

The **env layer is the floor** and the reason this works on terminals nobody has thought about: a
prompt, a starship config or a tmux status line can colour itself from `HANGAR_CLONE_SGR` (a real
escape sequence, 24-bit or 256-colour depending on `$COLORTERM`) with no emulator co-operation.
The others are `HANGAR_CLONE`, `_RGB`, `_HEX`, `_X256`, `_COLOUR` and `HANGAR_ID`.

The background is a **tint** (`terminal.colour.tint`, 16% by default), not the hue: a saturated
colour behind text is unreadable. iTerm2 escapes this because OSC 6 colours the tab in the tab
bar, where full strength is exactly right. Under **tmux** and on an unrecognised terminal the
chrome and title layers are skipped entirely — escapes would need DCS passthrough, and a stray
escape in someone's output is corruption, not colour. If your terminal ignores the OSC 111 reset,
set `HANGAR_TERM_BG` to your real background and the hook restores that instead.

`hangar doctor` reports the detected driver and its capabilities, whether an rc actually sources
the hook, and — the trap worth knowing — **whether an rc names a file under this hangar that no
longer exists.** The idiomatic `[ -r X ] && . X` guard means a renamed artifact fails _silently_:
the colours simply stop, with nothing anywhere to say why.

To change what a hue LOOKS LIKE, edit `src/palette.ts` and run `hangar colours sync`. To give
one clone a different hue, `hangar colours change 4 red` — that is the only per-clone value in
the fleet that is not a pure function of the index, so it is remembered in
`colour-assignments.json` at the fleet root (tracked, sparse: a clone that was never re-coloured
is not in it, which is why `add-clone` and `remove-clone` still need no bookkeeping). The command
rebuilds everything that names the colour, which is the reason it exists rather than being three
manual edits: the four generated artifacts, the clone's `.claude/settings.local.json` (it selects
the theme by NAME, and a theme that no longer exists makes Claude Code fall back to the default
one — the clone then looks like every other clone) and its `CLAUDE.local.md` (which tells the
agent which colour to announce). It also deletes the theme file for the old hue, which is named
after it and would otherwise linger. Picking the hue the index formula would have given clears
the assignment instead of writing one, so going back is the same command; a hue a sibling already
has is refused unless you pass `--force`, and `hangar doctor` reports it if you do.
`hangar colours list` paints the whole palette with who holds what.

**Claude Code takes arbitrary 24-bit hex in a custom theme** — the generated
`~/.claude/themes/dvb-clone-NN-*.json` files already do exactly that for `claude`,
`claudeShimmer`, `briefLabelClaude`, `promptBorder` and `promptBorderShimmer` — so the palette is
limited by what a human can tell apart at a glance, not by anything Claude Code enforces. It
holds 16 hues; the last four fill the gaps left by the first twelve and are the least
distinguishable, so low indices stay the good ones.

Two consumers cannot source
`clone-colours.sh` and carry their own copy — the theme JSONs (static JSON) and the statusline
script (self-contained so it can never fail) — but both are generated from the same data, so
they cannot drift. A theme change needs a Claude Code restart in that clone to show up.

The **status line** is the reliable signal: it shows the clone colour in every permission mode.
The theme's input-box border only does so in Manual mode, because `promptBorder` is mode-specific
(auto mode uses `warning`, plan mode `planMode`, accept-edits `autoAccept`) and those are
deliberately left alone — permission mode is safety information and must stay readable.

Each clone also carries an untracked `CLAUDE.local.md` at its root naming itself, its colour and
its three ports, so a session knows which clone it is without being told. It holds only what is
true of that SESSION rather than of the fleet — this file is already in its context, so nothing
here is repeated there: the identity, the `SYNC PAUSE` protocol from the receiving end, that
`tmp/` is shared out from under it, and that `hangar sync <its own index>` would stash the tree
it is working in.

**One builder renders it, and `doctor` holds every clone to it.** `add-clone`, `doctor --fix` and
`colours change` all write `claudeLocalMdContent(clone)`, and `doctor` compares each file against
that same render — so the four cannot drift apart, and improving the text is one edit plus
`doctor --all --fix`. It takes the clone and nothing else: an earlier version listed the siblings
by name, which would have made `doctor` red on every surviving clone after each `add-clone` or
`remove-clone` until someone re-ran `--fix`. Which clones exist stays underived from any file,
here included. That file is excluded
via the clone's `.git/info/exclude` (not the tracked `.gitignore`), so it never commits and never
travels to a sibling. Because that exclude line lives inside `.git/`, **a re-clone loses both the
identity file and its exclusion** — recreate the pair together, or `CLAUDE.local.md` shows up as
untracked noise in a clean tree and eventually gets committed into every branch. An agent
that does not know which clone it is in is the failure this fleet is most prone to.

The clones are **interchangeable and equal in rank** — none is a primary. Each has whatever branch
it has checked out at the moment; never infer a clone's branch, task or freshness from its number
or from anything in this file. `hangar list`, or `git -C clone_NN branch --show-current`, is the
only answer.

Ports come from each clone's untracked `.env.local` (`NG_DEV_SERVER_PORT`,
`STORYBOOK_DEV_SERVER_PORT`, `PLAYWRIGHT_REPORT_PORT`) and are resolved in code by
`dev/ports.mjs`. The formula above is what writes them; **`node dev/ports.mjs` inside a clone is
the source of truth** (from the fleet root, use `hangar ports`), and the clone's own `CLAUDE.md` states the rule that matters: never hard-code a
port, never assume a server on a default port is yours.

## The `hangar` CLI

The fleet is orchestrated by one TypeScript commander CLI. The executable is `bin/hangar`; the
package it runs is `app/` (`app/src/**`, `app/package.json`, `app/node_modules`), kept out of
the fleet root for the ancestor reason above. The fleet root's tracked `.envrc` does `PATH_add
bin`, so inside the fleet root you just type `hangar`. **Every clone gets the same directory on
PATH from its own untracked `.envrc.private`**, so `hangar` also works from inside a clone —
which is where you usually are. There is no build step: Node strips the types and runs `src/cli.ts`
directly, and the CLI's own `npm run lint`, `npm run typecheck` and `npm run format` run **from
`app/`** (they cover the CLI, not the app).

| Command                             | What it does                                                          |
| ----------------------------------- | --------------------------------------------------------------------- |
| `hangar list`                       | every clone, its branch and last commit                               |
| `hangar ports [--json]`             | the whole port map, and any `.env.local` that disagrees with it       |
| `hangar status <clone>\|--all`      | branch, sync vs origin, Jira link, PR link, ports, servers, sessions  |
| `hangar sync <clone>\|--all`        | stash, fetch, rebase-or-merge onto its PR's target branch, restore    |
| `hangar open <clone>\|--all`        | each clone's tabs in one terminal window + every configured editor    |
| `hangar resume [clone]`             | pick one of a clone's past Claude Code sessions and resume it         |
| `hangar add-clone`                  | create the next clone and wire it in completely                       |
| `hangar remove-clone <clone>`       | detach it (`--delete` also removes the directory, guarded)            |
| `hangar doctor [--fix]`             | verify/repair every untracked per-clone artifact                      |
| `hangar plans collect`              | gather every clone's finished plans into the shared `plans/`          |
| `hangar plans stamp`                | date-prefix the plans in `plans/`, skipping any a live agent is using |
| `hangar tmp merge`                  | pool every clone's `tmp/` cache in `tmp/`, a symlink per entry back   |
| `hangar jira hook`                  | `PreToolUse`: serve a cached ticket instead of re-fetching it         |
| `hangar ide vscode sync`            | one VS Code setup everywhere, per-clone paths still per clone         |
| `hangar ide <kind> sync`            | the same for `jetbrains`, `zed` or `emacs`, if this hangar lists one  |
| `hangar colours sync`               | regenerate the palette-derived artifacts                              |
| `hangar colours change`             | give one clone another hue, and rebuild everything that names it      |
| `hangar colours list`               | the palette, painted, and which clone holds each hue                  |

The editor commands live under **`ide`**, aliased **`editor`**, so the top level carries one
entry for the editors rather than one per editor. `colours` is aliased **`colors`**.

**Read freely; do not integrate.** `list`, `ports`, `status`, `colours list` and a bare `doctor`
only report, and every `-n` is a dry run — a clone session is welcome to all of them, and
`plans collect` and `tmp merge --quiet` already run there from `SessionEnd` hooks. The ones that
move git state, files between clones or terminal windows are the **user's, from the fleet root**:
`sync`, `open`, `add-clone`, `remove-clone`, `colours change` and `doctor --fix`.

**`hangar sync <clone>` starts with a `git stash push --include-untracked`**, and the
busy-clone skip applies only to `--all` — so naming a clone explicitly does not protect it, and a
clone session naming its OWN index would stash the tree it is working in. It also **refuses to
start on a clone that is already mid-rebase or mid-merge**: finish or abort that first, or the
half-applied state gets buried in a stash nobody thinks to look in.

**A `SYNC PAUSE` line in your input is real, and it is not the user typing.** There is no CLI
mechanism to message a running interactive session, so `sync` finds the session's tty and writes
into it: `SYNC PAUSE`, then **exactly one** `SYNC FINISHED` or `SYNC ABORTED` reporting the state
it left the working tree in. Stop on the pause and wait — while it runs, a headless `claude -p`
may be resolving conflicts in that very tree, and two agents editing one file is the failure the
pause exists to prevent. **That resolver takes one to three minutes and streams a dim line per
tool call; let it run, and do not resolve the same files by hand while it is working.** If the
closing line never comes, or describes a tree that does not match what you find, tell the user
rather than resuming.

### Which editors it opens

`editor.kinds` in `hangar.config.yaml` is a **list**, because a clone can be open in more than one
editor at once — their project files are different files. `hangar open` opens every one of them;
`hangar <kind> sync` keeps one editor's shareable project files in step.

**VS Code is the default and the only editor that has to work; every other kind is best effort.**
That is a rank, not a disclaimer, and it is enforced rather than hoped for: `DEFAULT_EDITOR_KIND`
in `app/src/editor/kinds.ts` is the one place that names it (the schema default reads it, and the
fallback for a config that will not parse goes through that same default, so the two cannot
disagree). `editors()` builds each configured driver in a loop with a per-kind catch, and `open`
and `doctor` isolate each one again around `isAvailable`/`launch` — so a clone configured
`[zed, vscode]` cannot lose VS Code to Zed's launcher, which listing order alone would have done.
`hangar <kind> sync` is the deliberate exception: there the developer named the editor, so its
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

### Which terminal it drives

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

**Everything else about this CLI is rationale, and it lives in the `hangar-internals` skill** —
why `sync` asks Bitbucket for a branch's PR target instead of guessing `master`, how `tmp merge`
collapses a ticket's many cached names onto one inode, what `ide vscode sync` rewrites per clone and
what it refuses to write, what `doctor` checks and the two rules for anything generated into a
clone, the Jira hook's fail-open design, and the two conventions for changing the CLI (a pure
exported builder for anything a human or an agent reads; derive state at the moment you report it).
Load it before editing `app/src/**` or debugging one of these commands.

## Staying in your own clone

A session belongs to exactly one clone: the one it was started in. Everything else in this tree is
another agent's live working directory.

- **Never write, edit, stage, commit, checkout, stash or reset anything outside your own clone.**
  A sibling very likely has uncommitted work and a running dev server.
- **Never start, restart or kill a server, Storybook or Playwright run in a sibling clone**, and
  never point your own test run at a sibling's port — that verifies the wrong code, silently.
- Reading a sibling is fine and often useful (comparing an implementation, checking what a branch
  did). Read-only means read-only: `git -C ../clone_NN show`, `log`, `diff`, `grep`, `cat`.
- **Say which clone you are** when a message could be read as being about the fleet, and use
  absolute or `../clone_NN/`-prefixed paths whenever you refer to anything outside your own root —
  a bare relative path is the most common way this gets confused.
- If a task genuinely needs work done in another clone, **tell the user which clone it belongs in**
  and let the agent there do it. Do not reach across.

## Environment & secrets

Secrets are **not** duplicated per clone. They live in one file at the fleet root and are layered
under each clone's own values:

**Every** secret lives in one file: `.env.shared` here in the fleet root (mode 600). It holds
`ATLASSIAN_USER_EMAIL`, `ATLASSIAN_API_TOKEN`, `BITBUCKET_TOKEN` (which `hangar sync` uses to
read a branch's PR target), `JIRA_API_TOKEN`, `JIRA_USERNAME`, `CONTEXT7_API_KEY`,
`USER_READWRITE_PASSWORD`, `CERTSPOTTER_TOKEN` and `SENTRY_AUTH_TOKEN`.

| File                                                    | Scope       | Holds                                                    |
| ------------------------------------------------------- | ----------- | -------------------------------------------------------- |
| `.env.shared` (here, mode 600)                          | every clone | every credential, plus account identity                  |
| `clone_NN/.env.local`                                   | one clone   | `PROJECT_GIT_ROOT_PATH` + the three ports — nothing else |
| `clone_NN/.envrc.private`                               | one clone   | **no variables at all**; it only loads `.env.shared`     |
| `clone_NN/tests/playwright-regression-tests/.env.local` | one clone   | a **symlink** to `.env.shared`                           |

`angular/.envrc.private` no longer exists in any clone — its two tokens moved to `.env.shared`, so
clone_03 now has them too (it never did before).

direnv load order puts `.envrc.private` (and so `.env.shared`) **before** the clone's `.env.local`,
so a clone can still override any shared value locally. `.env.shared` sits outside every clone, so
no clone can commit it — and for the same reason no `Read(./**/.env*.local)` deny rule reaches it;
it is denied by absolute path in each clone's `.claude/settings.local.json`.

Two things to know before editing any of this:

- **The absolute path in `.envrc.private` is load-bearing.** `angular/.envrc` sources it via
  `load_and_watch_envrc_private ../`, so a relative `../.env.shared` would resolve against
  `angular/` and `dotenv_if_exists` would silently no-op. Do not "simplify" it.
- **That playwright symlink is not redundant.** The tracked
  `tests/playwright-regression-tests/.env` sets `USER_READWRITE_PASSWORD=` (empty) and direnv loads
  it _after_ `.envrc.private`, so the placeholder would wipe the shared value. The symlink reloads
  `.env.shared` at that later point to win. Delete it and Playwright's login breaks with an empty
  password — verify with `node dev/ports.mjs` style checks, not by assuming.

## Shared `tmp/`

Every clone **keeps its own `tmp/` directory, and `tmp/` itself is never a symlink.** What is
shared is the content in it that belongs to no clone in particular — the per-ticket Jira cache, the
PR descriptions, whatever else the skills leave there — which lives in `~/code/dvb_gn/tmp/<name>`
with `clone_NN/tmp/<name>` a **symlink per entry** in every clone. A ticket fetched in one clone
reaches the others at the next `hangar tmp merge`, which every clone runs from a `SessionEnd`
hook. `tmp merge` is idempotent and never overwrites: anything that differs is kept beside the
winner as `<name>.from-clone_NN`, so run it again rather than forcing it.

**The dev-server PID files are why `tmp/` is a real directory and not a link.**
`dev/run-with-pid.mjs` refuses a name that is already live and `node dev/pids.mjs --kill <name>`
finds a server by that file, so a shared `tmp/` would let the first clone to start a dev server
block the others and let a kill reach into a sibling. With the links one level down, **`tmp merge`
never moves, links or even reads a PID file** — a running dev server is no obstacle to sharing.

**Never hand-edit a file under `tmp/`.** Each cached Jira record is normally a **hard link** to one
file the whole fleet shares, so an in-place edit can rewrite every clone's copy of it, and nothing
inside the clone shows you that. Read them, regenerate them with the skill, and leave the links
alone. **A ticket fetched in the last hour is not fetched again**: `hangar jira hook` is a
`PreToolUse` hook that links the cached records into place and **denies** the fetch, telling you
what it gave you instead. `JIRA_SYNC_NO_CACHE=1` in front of the command bypasses it — an env var
and not a flag, because `sync.mjs` dies on an unknown flag.

**The last issue key in a cached filename is what the file contains**; the keys before it only say
how it was reached. `ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md` **is ABC-1323**, and
`ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png` is ABC-1191's attachment.

`ticket_<KEY>.md`, its relation variants and Jira attachments are clone- and branch-independent,
which is the point. **A PR description is not** — it is derived from the working-tree diff, so it
is shared as a side effect and is last-writer-wins when two clones work one ticket at once. One
ticket normally belongs to one clone, so this is bounded, but do not trust a PR description you did
not just generate in this clone.

`tmp/` is gitignored by the tracked `tmp/` rule, which matches the real directory and everything
under it — the per-entry links included. So nothing about `tmp` belongs in `.git/info/exclude`;
that file is back to hiding `/CLAUDE.local.md` alone. **How the store is built** — one record per
ticket and why it cannot carry `relation:` frontmatter, the `jdupes` hard-linking pass for
attachments, the freshness ranking, and the Jira hook's five design properties — is in the
`hangar-internals` skill.

## Claude Code settings layering

Only two things differ per clone: **`theme`** and the **Storybook health-check port** in
`permissions.allow`. Everything else in `.claude/settings.local.json` is byte-identical across
every clone (verify with `jq -S 'del(.theme)|del(.permissions.allow)' … | shasum`).

- `~/.claude/settings.json` (user) holds the genuinely global preferences —
  `skillListingBudgetFraction`, `prefersReducedMotion`, the `Explore` and `mcp__dash-api__*`
  allows, the `Read(~/.ssh/**)` deny. Do **not** move fleet-scoped keys up here: this machine has
  other projects, and `autoMemoryDirectory`, `plansDirectory`, `statusLine` and
  `enabledMcpjsonServers` would leak the fleet onto them.
- `clone_NN/.claude/settings.local.json` (untracked) holds the fleet-scoped keys, identical in
  every clone: the shared memory directory, the two `SessionEnd` hooks (one collects plans, see
  below; the other runs `tmp merge --quiet` so this clone's new Jira cache entries reach the store),
  the `PreToolUse` hook that serves a cached Jira ticket from the record store (additive — Claude
  Code merges it with the repo's own tracked `PreToolUse` guard rather than replacing it), the
  shared statusline, the six MCP servers
  (`playwright`, `jira`, `yfiles-api`, `angular-cli`, `primeng`, `ag-mcp`), the `frontend-design`
  plugin off, the `.env.shared` deny, and the two iTerm2 keys (`terminal.explorerKind`,
  `terminal.external.osxExec`).
- `.claude/settings.json` is **tracked and shared** — never put a per-clone or personal value there.

**A running session never sees a change to this file**, and the same is true of `CLAUDE.local.md`
next to it. Claude Code reads both once at startup, so a hook wired in by `doctor --fix`, a theme
swapped by `colours change` or an improved identity text reaches that clone at its **next**
session. In particular a session that started before a `SessionEnd` hook was added does not run it
on exit — `doctor` checks what is on disk, and a green report says nothing about what the open
sessions are running.

**Plans cannot be shared by a setting.** Claude Code resolves `plansDirectory` against the project
root and then requires the result to be **inside** that root — a string-prefix test on the resolved
path, with symlinks followed. Anything outside is rejected with `plansDirectory must be within
project root` and the CLI **silently falls back to `~/.claude/plans`**, mixed in with this machine's
other projects. That is not a check to work around: `../plans`, an absolute
`~/code/dvb_gn/plans`, and a `.claude/plans` symlink pointing at the fleet root all fail it the same
way. An absolute `~/.claude/dvb-gn-plans` was configured in all three clones and did exactly that,
unnoticed, for a day.

So the value stays the repo's own tracked `"plansDirectory": ".claude/plans"` — each clone writes
into its own directory, and the per-clone settings carry no copy of it — and the sharing is
**`hangar plans collect`**, which moves finished plans into `~/code/dvb_gn/plans`, collapses
byte-identical copies and puts the plan's date in front of the name. It is not something to
remember: each clone's untracked `.claude/settings.local.json` runs it from a **`SessionEnd` hook**,
so a session's plan reaches the archive the moment that session ends — which is also the first
moment it is safe to move, because nothing can rewrite it any more. **A plan stays in its own clone
while its session is alive; that is the guarantee, not a delay.** `hangar plans stamp` dates
anything that arrives unstamped, and `hangar doctor` checks both the effective `plansDirectory`
and the hook. A fleet-root session needs neither: its project root _is_ the fleet root, so
`"plansDirectory": "plans"` in `.claude/settings.json` writes into the archive directly.

Dates come from the filename, then the file's own birthtime/mtime, then the first transcript that
mentions it. **`stat` alone is not trustworthy here:** an earlier consolidation copied 157 plans
without preserving times, so they all carry one identical second, and Claude Code's atomic rewrite
resets birthtime on a plan it is still editing. `plans collect` detects a bulk-copy timestamp (many
files, same second, birthtime == mtime) and refuses to use it, then writes the date it resolved
back as the file's mtime so it survives.

One consequence to expect: `/resume` on an older session will not find its plan file where it left
it. Claude Code logs `Plan file missing during resume` and reconstructs the plan from the message
history, so it degrades rather than breaks.

## Git topology

Every clone has `origin` (Bitbucket) **plus every other clone as a named remote** (`clone_01`,
`clone_02`, … → `../clone_NN`), so commits can move between clones without going through
Bitbucket:

```bash
git fetch clone_02                      # from inside another clone
git log --oneline clone_02/<branch>
git cherry-pick <sha>
```

Because a branch usually exists on more than one of those remotes, every clone sets
**`checkout.defaultRemote=origin`** locally (`add-clone` writes it, `doctor --fix` repairs it).
Without it `git checkout <branch>` refuses with _"matched multiple remote tracking branches"_ —
the more clones the fleet has, the more often that is any branch worth checking out.

Sibling remotes are for **fetching and cherry-picking only — never push to a sibling.** Git's
default `receive.denyCurrentBranch=refuse` (unset everywhere, so in effect) only protects the
branch that sibling currently has _checked out_; a push to any of its **other** branches succeeds
and rewrites history the other agent is about to return to, with no warning. `origin` is the only
push target, and each clone's own `CLAUDE.md` governs whether pushing there is allowed at all (it
generally is not, without the user asking).

Cherry-picking pulls from a sibling's **committed** state only. A sibling's uncommitted work is
invisible to `git fetch`; if you need it, ask the user to have that clone's agent commit or stash
it — do not go read its working tree and reconstruct the change.

## Parent-session scope

A session started here, in `~/code/dvb_gn/`, is for fleet-level work only: running `hangar`,
comparing clones, looking at the layout, editing this file. No project agents, hooks or
permission rules load, and the only skill is `hangar-internals` — everything else lives in
the clones. So the parent's `.claude/` holds exactly two things. `settings.json` is tracked and
committed (it holds no personal values, which is why it is not a `.local.json`): it points
`autoMemoryDirectory` at the shared fleet memory and `plansDirectory` at `plans/`, so a
fleet-root session writes straight into the shared archive. The skill is the rationale half of
what this file used to say about the CLI, moved out of the ancestor walk so the four clone
sessions stop paying for it — see **The `hangar` CLI** above.

Because the parent is its own repo, `git log` here and in a clone are unrelated histories. And
There is now an `.envrc` here too, and its only job is `PATH_add bin`. It does **not** reach the
clones — direnv loads the nearest `.envrc` only, and every clone has its own — which is why each
clone repeats the same `PATH_add` in its untracked `.envrc.private`.

`.gitignore` here is load-bearing, not leftover: `clone_*/`, `.env.shared`, `node_modules/`,
`plans/`, `tmp/` and `hangar.config.yaml` are the only reason the clones, the secrets, the CLI's
dependencies, the plan archive, the shared scratch directory and this machine's own config stay
out of the parent repo. Do not remove any of those lines. (`clone_*/`, not `clone_0*/`: the old
glob stopped matching at `clone_10`. And `hangar.schema.json` stays TRACKED — it is generated
from the zod schema, and both YAML files point at it for editor validation.)

**Do not run project work from here.** `ng`, `jest`, `playwright`, the project's lint and format
and the project skills all require a clone's root (or its `angular/` subdirectory) as the working
directory, and the repo's `SessionStart` hooks resolve paths via `git rev-parse --show-toplevel`,
which fails here. Start a session in the clone instead. The CLI's own `npm run lint`,
`npm run typecheck` and `npm run format` must be run **from `app/`**, and they cover the CLI, not
the app.

**The specific trap:** the clones get their per-clone ports from direnv, which the repo wires up in
a `SessionStart` hook (`.claude/hooks/direnv-load.sh` — it appends a `direnv export` plus a `cd`
wrapper to `CLAUDE_ENV_FILE`, so every Bash call in a clone session, and every `cd` inside one,
re-evaluates the environment). **A parent session has no such hook**, so `.env.local` is never
loaded and `(cd clone_NN && node dev/ports.mjs)` reports the fallbacks `4200 / 6006 / 9323` for
**every clone** — it does not error, it just answers wrong (the tell is the `(default)` marker
it prints beside each number). Never read a clone's ports from a parent session; read the clone's
`CLAUDE.local.md`, or `grep` its `.env.local`.

Session history and memory are keyed differently, which is worth knowing before you go looking for
either:

- **Transcripts** are keyed to the **working directory** a session was started in — a session
  started in `clone_01/angular/` lands in `~/.claude/projects/-Users-kaspi-code-dvb-gn-clone-01-angular/`
  and will **not** appear in a `/resume` run from `clone_01/`. `hangar resume <clone>` lists
  every one of a clone's transcript directories in one picker, which is what it is for.
- **File-based memory** is keyed to the **git repository root**, so every session in a clone —
  including ones started in `angular/` — shares that clone's one memory directory. The clones
  are separate repos, so each gets its own memory directory unless `autoMemoryDirectory` is
  pointed at a shared path.

A parent session has its own transcript directory, so it sees no clone's history in `/resume`. It
**does** see the shared memory — the parent's tracked `.claude/settings.json` points
`autoMemoryDirectory` at the same `~/.claude/dvb-gn-memory` every clone uses. A memory written
from the parent is immediately visible in every clone and vice versa; `MEMORY.md` is one shared
index with no locking, so append a line to it, never rewrite it wholesale.

## How this file reaches the clone sessions

Claude Code loads `CLAUDE.md` (then `CLAUDE.local.md`) from the working directory **and every
directory above it**, ordered filesystem-root-down. There is no repository boundary. So this file
is prepended to the context of every session started in a clone, whether or not anyone asked for
it — which is exactly why it stays short and says nothing about the application. Every line here
is paid for once per clone and cannot be branch-specific.

Note that this ancestor walk is specific to `CLAUDE.md`. It does **not** apply to
`.claude/settings.json`, `.mcp.json`, hooks, agents or skills — those come from the clone's own
repo root (skills walk up only as far as it). So neither the parent's settings file nor its one
skill reaches a clone session.
