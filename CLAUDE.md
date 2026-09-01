# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this directory is

`~/code/dvb_gn/` is **not** a clone of the application. It is a container for three independent
full clones of the same Bitbucket repo (`git@bitbucket.org:acme/storefront_ui.git`).
There is no application code here, no `package.json`, no build. Everything buildable lives one
level down.

It *is* itself a small local-only git repo — branch `main`, no remote — tracking only this file,
the three shell helpers, `.gitignore` and `.claude/settings.local.json`. Never the application.

Full clones, not `git worktree`: each needs its own `node_modules`, its own dev server, its own
Storybook and its own Playwright run. That is the whole reason the fleet exists.

**This file is a fleet map — who is who, which ports belong to whom, how the clones exchange
commits. It deliberately contains nothing about the application.** All project guidance —
architecture, commands, conventions, agent rules — lives in each clone's own
`CLAUDE.md`, `AGENTS.md`, `.claude/skills/**` and `.claude/agents/**`, is tracked in git, and is
**versioned per branch**. Read it there. Do not copy it up here: content hoisted out of the repo
stops following the branch and silently goes stale.

## The three clones

| Clone      | Colour | `ng serve` | Storybook | Playwright report |
| ---------- | ------ | ---------- | --------- | ----------------- |
| `clone_01` | cyan   | 4200       | 6006      | 9323              |
| `clone_02` | yellow | 4300       | 6106      | 9423              |
| `clone_03` | green  | 4400       | 6206      | 9523              |

The colour is not decoration — it is how the developer tells three near-identical terminal windows
apart. It is wired the same way in every clone, and none of it is in git (it cannot be:
`.claude/settings.json` is tracked and shared, so a colour set there would apply to all three
clones for every developer):

- `~/.claude/dvb-clone-statusline.sh` — **one script, all three clones.** It derives the hue from
  the clone directory in its stdin payload rather than hardcoding one, so every clone runs
  identical code. Shows `● clone_0X · branch · model`.
- `~/.claude/themes/dvb-clone-0{1,2,3}-*.json` — one per clone, structurally identical, differing
  only in hue (`claude`, `claudeShimmer`, `briefLabelClaude`, `promptBorder`,
  `promptBorderShimmer`).
- each clone's untracked `.claude/settings.local.json` — `theme` + the shared `statusLine`.

The same three hues also colour the **iTerm2 tab** whenever the shell's `PWD` is inside a clone
(any subdirectory included), via `dvb-clone-iterm.zsh` here, sourced from `~/.zshrc`. It is a
`chpwd` hook, not a direnv hook, deliberately: direnv only fires on entering or leaving a directory
that has an `.envrc`, redirects that file's stdout, and has no notion of "left the fleet entirely",
so escape codes emitted from `.envrc` would be both fragile and incomplete. direnv owns the
environment; the shell owns terminal I/O. The hook resets the tab colour only if it set it, so a
tab coloured by hand is left alone, and it is a no-op outside iTerm2.

`clone-colours.sh` here is the canonical hue table for shell consumers. Two places cannot source
it and carry their own copy — the theme JSONs (static JSON) and the Claude statusline script
(self-contained so it can never fail). Changing a hue means changing all three.

The **status line** is the reliable signal: it shows the clone colour in every permission mode.
The theme's input-box border only does so in Manual mode, because `promptBorder` is mode-specific
(auto mode uses `warning`, plan mode `planMode`, accept-edits `autoAccept`) and those are
deliberately left alone — permission mode is safety information and must stay readable.

Each clone also carries an untracked `CLAUDE.local.md` at its root naming itself, its colour and
its three ports, so a session knows which clone it is without being told. That file is excluded
via the clone's `.git/info/exclude` (not the tracked `.gitignore`), so it never commits and never
travels to a sibling. Because that exclude line lives inside `.git/`, **a re-clone loses both the
identity file and its exclusion** — recreate the pair together, or `CLAUDE.local.md` shows up as
untracked noise in a clean tree and eventually gets committed into all three branches. An agent
that does not know which clone it is in is the failure this fleet is most prone to.

The clones are **interchangeable and equal in rank** — none is a primary. Each has whatever branch
it has checked out at the moment; never infer a clone's branch, task or freshness from its number
or from this table. `git -C clone_0X branch --show-current` is the only answer.

Ports come from each clone's untracked `.env.local` / `.envrc.private` (`NG_DEV_SERVER_PORT`,
`STORYBOOK_DEV_SERVER_PORT`, `PLAYWRIGHT_REPORT_PORT`) and are resolved in code by
`dev/ports.mjs`. The table above is a human reference; **`node dev/ports.mjs` inside a clone is the
source of truth**, and the clone's own `CLAUDE.md` states the rule that matters: never hard-code a
port, never assume a server on a default port is yours.

## Staying in your own clone

A session belongs to exactly one clone: the one it was started in. Everything else in this tree is
another agent's live working directory.

- **Never write, edit, stage, commit, checkout, stash or reset anything outside your own clone.**
  A sibling very likely has uncommitted work and a running dev server.
- **Never start, restart or kill a server, Storybook or Playwright run in a sibling clone**, and
  never point your own test run at a sibling's port — that verifies the wrong code, silently.
- Reading a sibling is fine and often useful (comparing an implementation, checking what a branch
  did). Read-only means read-only: `git -C ../clone_0X show`, `log`, `diff`, `grep`, `cat`.
- **Say which clone you are** when a message could be read as being about the fleet, and use
  absolute or `../clone_0X/`-prefixed paths whenever you refer to anything outside your own root —
  a bare relative path is the most common way this gets confused.
- If a task genuinely needs work done in another clone, **tell the user which clone it belongs in**
  and let the agent there do it. Do not reach across.

## Environment & secrets

Secrets are **not** duplicated per clone. They live in one file at the fleet root and are layered
under each clone's own values:

**Every** secret lives in one file: `.env.shared` here in the fleet root (mode 600). It holds
`ATLASSIAN_USER_EMAIL`, `ATLASSIAN_API_TOKEN`, `JIRA_API_TOKEN`, `JIRA_USERNAME`,
`CONTEXT7_API_KEY`, `USER_READWRITE_PASSWORD`, `CERTSPOTTER_TOKEN` and `SENTRY_AUTH_TOKEN`.

| File | Scope | Holds |
| --- | --- | --- |
| `.env.shared` (here, mode 600) | all three clones | every credential, plus account identity |
| `clone_0X/.env.local` | one clone | `PROJECT_GIT_ROOT_PATH` + the three ports — nothing else |
| `clone_0X/.envrc.private` | one clone | **no variables at all**; it only loads `.env.shared` |
| `clone_0X/tests/playwright-regression-tests/.env.local` | one clone | a **symlink** to `.env.shared` |

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
  it *after* `.envrc.private`, so the placeholder would wipe the shared value. The symlink reloads
  `.env.shared` at that later point to win. Delete it and Playwright's login breaks with an empty
  password — verify with `node dev/ports.mjs` style checks, not by assuming.

## Shared Jira ticket cache

The per-ticket Jira cache is shared across all three clones. `~/.claude/dvb-gn-jira/<KEY>/` is the
real directory; each clone's `tmp/<KEY>` is a symlink into it, so a ticket fetched or refreshed in
one clone is immediately there for the other two. `jira-cache-link.sh` here adopts and links
(no arguments = every ticket dir found anywhere; a key = link just that one; `--dry-run` to preview).
It is idempotent and never deletes a differing file — a conflicting copy is kept as
`<name>.from-clone_0X` and reported.

This needs **no change to the tracked tooling**: `.claude/skills/jira-scope/jira-cache.mjs`
hardcodes `<git toplevel>/tmp/<KEY>` with no configuration, but only ever does
`mkdirSync(..., {recursive: true})` on it, which follows a symlink.

> **`tmp/` itself is NEVER shared, and must stay a real per-clone directory.** It also holds the
> dev-server PID files, and `dev/run-with-pid.mjs` refuses a name that is already live — so a
> shared `tmp/` would let only one clone run a dev server at a time, and would let
> `node dev/pids.mjs --kill ng_serve` reach into another clone and kill its server. Only the
> per-ticket `tmp/<KEY>` directories are linked. When adding a new key, link the key, never `tmp/`.

**Nothing enforces the linking.** `jira-scope` creates `tmp/<KEY>` as a real directory whenever a
clone fetches a ticket the fleet has not linked yet, so when `ls -la clone_0*/tmp` shows a real
directory among the symlinks, re-run `./jira-cache-link.sh` (`--dry-run` first) — it adopts them in
place, from the fleet root, for all three clones.

`ticket_<KEY>.md`, its relation variants and Jira attachments are clone- and branch-independent,
which is the point. **`pr_description_<KEY>.md` is not** — it is derived from the working-tree diff,
so it is shared as a side effect and is last-writer-wins when two clones work one ticket at once.
One ticket normally belongs to one clone, so this is bounded, but do not trust a PR description you
did not just generate in this clone.

## Claude Code settings layering

Only two things differ per clone: **`theme`** and the **Storybook health-check port** in
`permissions.allow`. Everything else in `.claude/settings.local.json` is byte-identical across all
three (verify with `jq -S 'del(.theme)|del(.permissions.allow)' … | shasum`).

- `~/.claude/settings.json` (user) holds the genuinely global preferences —
  `skillListingBudgetFraction`, `prefersReducedMotion`, the `Explore` and `mcp__dash-api__*`
  allows, the `Read(~/.ssh/**)` deny. Do **not** move fleet-scoped keys up here: this machine has
  other projects, and `autoMemoryDirectory`, `plansDirectory`, `statusLine` and
  `enabledMcpjsonServers` would leak the fleet onto them.
- `clone_0X/.claude/settings.local.json` (untracked) holds the fleet-scoped keys, identical in all
  three: the shared memory and plans directories, the shared statusline, the six MCP servers
  (`playwright`, `jira`, `yfiles-api`, `angular-cli`, `primeng`, `ag-mcp`), the `frontend-design`
  plugin off, the `.env.shared` deny, and the two iTerm2 keys (`terminal.explorerKind`,
  `terminal.external.osxExec`).
- `.claude/settings.json` is **tracked and shared** — never put a per-clone or personal value there.

Plans are shared too: all three point `plansDirectory` at `~/.claude/dvb-gn-plans` (157 files,
deduplicated — clone_03's 149 were byte-identical copies of clone_01's). Plan files are
individually named random word-triples and the directory holds no index or manifest, so unlike a
shared `MEMORY.md` there is nothing for concurrent sessions to clobber.

**The absolute path there is correct — do not "fix" it.** The settings-reference documents
`{"plansDirectory": "/path/to/plans"}`; the JSON *schema* still describes the key as "relative to
project root" and is simply stale (the settings docs warn the schema can lag the CLI). Changing it
back to a relative path would silently re-fragment plans across the three clones.

## Git topology

Every clone has `origin` (Bitbucket) **plus the other two clones as named remotes** (`clone_01`,
`clone_02`, `clone_03` → `../clone_0X`), so commits can move between clones without going through
Bitbucket:

```bash
git fetch clone_02                      # from inside another clone
git log --oneline clone_02/<branch>
git cherry-pick <sha>
```

Sibling remotes are for **fetching and cherry-picking only — never push to a sibling.** Git's
default `receive.denyCurrentBranch=refuse` (unset in all three, so in effect) only protects the
branch that sibling currently has *checked out*; a push to any of its **other** branches succeeds
and rewrites history the other agent is about to return to, with no warning. `origin` is the only
push target, and each clone's own `CLAUDE.md` governs whether pushing there is allowed at all (it
generally is not, without the user asking).

Cherry-picking pulls from a sibling's **committed** state only. A sibling's uncommitted work is
invisible to `git fetch`; if you need it, ask the user to have that clone's agent commit or stash
it — do not go read its working tree and reconstruct the change.

## Parent-session scope

A session started here, in `~/code/dvb_gn/`, is for fleet-level work only: comparing clones,
looking at the layout, editing this file. No project skills, agents, hooks or permission rules
load — the parent's `.claude/` holds nothing but `settings.local.json`, and everything else lives
in the clones. That one file is tracked, and it is not empty: it points `autoMemoryDirectory` at
the shared fleet memory.

Because the parent is its own repo, `git log` here and in a clone are unrelated histories. And
`.gitignore` here is load-bearing, not leftover: `clone_0*/` and `.env.shared` are the only reason
the clones and the secrets stay out of the parent repo. Do not remove either line.

**Do not run project work from here.** `npm`, `ng`, `jest`, `playwright`, lint, format and the
project skills all require a clone's root (or its `angular/` subdirectory) as the working
directory, and the repo's `SessionStart` hooks resolve paths via `git rev-parse --show-toplevel`,
which fails here. Start a session in the clone instead.

**The specific trap:** the clones get their per-clone ports from direnv, which the repo wires up in
a `SessionStart` hook (`.claude/hooks/direnv-load.sh` — it appends a `direnv export` plus a `cd`
wrapper to `CLAUDE_ENV_FILE`, so every Bash call in a clone session, and every `cd` inside one,
re-evaluates the environment). **A parent session has no such hook**, so `.env.local` is never
loaded and `(cd clone_0X && node dev/ports.mjs)` reports the fallbacks `4200 / 6006 / 9323` for
**all three clones** — it does not error, it just answers wrong (the tell is the `(default)` marker
it prints beside each number). Never read a clone's ports from a parent session; read the clone's
`CLAUDE.local.md`, or `grep` its `.env.local`.

Session history and memory are keyed differently, which is worth knowing before you go looking for
either:

- **Transcripts** are keyed to the **working directory** a session was started in — a session
  started in `clone_01/angular/` lands in `~/.claude/projects/-Users-kaspi-code-dvb-gn-clone-01-angular/`
  and will **not** appear in a `/resume` run from `clone_01/`.
- **File-based memory** is keyed to the **git repository root**, so every session in a clone —
  including ones started in `angular/` — shares that clone's one memory directory. The three
  clones are three separate repos, so they get three separate memory directories unless
  `autoMemoryDirectory` is pointed at a shared path.

A parent session has its own transcript directory, so it sees no clone's history in `/resume`. It
**does** see the shared memory — the parent's tracked `.claude/settings.local.json` points
`autoMemoryDirectory` at the same `~/.claude/dvb-gn-memory` all three clones use. A memory written
from the parent is immediately visible in every clone and vice versa; `MEMORY.md` is one shared
index with no locking, so append a line to it, never rewrite it wholesale.

## How this file reaches the clone sessions

Claude Code loads `CLAUDE.md` (then `CLAUDE.local.md`) from the working directory **and every
directory above it**, ordered filesystem-root-down. There is no repository boundary. So this file
is prepended to the context of every session started in a clone, whether or not anyone asked for
it — which is exactly why it stays short and says nothing about the application. Every line here
is paid for three times over and cannot be branch-specific.

Note that this ancestor walk is specific to `CLAUDE.md`. It does **not** apply to
`.claude/settings.json`, `.mcp.json`, hooks, agents or skills — those come from the clone's own
repo root (skills walk up only as far as it), so the parent's `.claude/` carries nothing but the
one settings file described above.
