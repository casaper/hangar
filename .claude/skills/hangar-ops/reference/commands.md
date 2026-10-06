# The command surface

Transcribed from `app/src/cli.ts`. **`report` = touches nothing. `act` = writes files, moves git
state, or opens windows.** The ones marked **[user]** are those the hangar's `CLAUDE.md` reserves
for the user at the hangar root — preview them and report before the real one runs.

**Every command below is also an MCP tool**, and the next section is the map between the two. The
tool spawns `bin/hangar` with exactly this argv, so the tables here are the truth for both; what
differs is only the spelling. **[user]** is unchanged by any of it — that is governance, and an
`ask` rule does not encode "preview and report before you call this". It is a stronger mark than
`ask`: every **[user]** command's tool asks, but so do plenty that carry no mark.

Global: `--hangar <path>` (the hangar root to operate on; **only `config show` and
`config validate` honour it today** — everything else uses the upward walk from the cwd).

`<clone>` accepts an index (`2`), a padded name (`clone_02`), or `02`.

## The tools, against the commands

One `mcp__hangar__<name>` per row. A tool's parameters are the command's own long flags without
their `--`, plus its positional arguments by name — never a short flag, which is what disposes of
`resume -n`.

**A dry run is a separate tool rather than a parameter, and that is the whole design.** An MCP
permission rule cannot match on arguments — Claude Code skips any `mcp__` rule with parentheses in
it — so a `dry-run` parameter would put the preview and the real run under one rule and
pre-approving the safe one would pre-approve the other. Split in two, the preview is in operator
mode's `allow` list and the act is in `ask`. `doctor` and `doctor_fix` are the same split by
another name.

| Command | preview / report tool | acting tool |
| --- | --- | --- |
| `list` | `list` | — |
| `ports` | `ports` (`json` is a parameter) | — |
| `ports pin` | `ports_pin_preview` | `ports_pin` |
| `ports unpin` | `ports_unpin_preview` | `ports_unpin` |
| `scrub` | `scrub` | — |
| `status` | `status` | — |
| `servers list` | `servers_list` | — |
| `servers start` | `servers_start_preview` | `servers_start` |
| `servers kill` | `servers_kill_preview` | `servers_kill` |
| `servers prune` | `servers_prune_preview` | `servers_prune` |
| `doctor` | `doctor` | `doctor_fix` |
| `sync` | `sync_preview` | `sync` (`strategy` picks rebase or merge) |
| `checkout-default` | `checkout_default_preview` | `checkout_default` |
| `open` | `open_preview` | `open` |
| `edit` | `edit_preview` | `edit` |
| `close` | `close_preview` | `close` |
| `reload` | `reload_preview` | `reload` |
| `install` | `install_preview` | `install` |
| `allow` | `allow_preview` | `allow` |
| `browse` | `browse_preview` | `browse` |
| `pr refresh` | `pr_refresh_preview`, and `pr_refresh` itself | — |
| `pr create` | `pr_create_preview` | `pr_create` (with `--no-describe` fixed — see below) |
| `pr update` | `pr_update_preview` | `pr_update` (same) |
| `resume` | `resume_list` | — |
| `teach-rg` | `teach_rg_preview` | `teach_rg` |
| `setup` | `setup_preview` | `setup` |
| `exec` | — | **none — and the Bash path is denied too** |
| `add-clone` | — | `add_clone` (offers the undocumented `remote`) |
| `remove-clone` | — | `remove_clone` |
| `config show` | `config_show` | — |
| `config validate` | `config_validate` | — |
| `config schema` | `config_schema_check` | `config_schema_write` |
| `colours list` | `colours_list` | — |
| `colours sync` | `colours_check` **and** `colours_sync_preview` | `colours_sync` |
| `colours change` | — | `colours_change` |
| `tmp merge` | `tmp_merge_preview` | `tmp_merge` |
| `plans collect` | `plans_collect_preview` | `plans_collect` |
| `plans stamp` | `plans_stamp_preview` | `plans_stamp` |
| `skills list` | `skills_list` | — |
| `skills sync` | `skills_sync_preview` | `skills_sync` |
| `bookmarks sync` | `bookmarks_sync_preview` | `bookmarks_sync` |
| `ide <kind> sync` | `ide_<kind>_sync_preview` | `ide_<kind>_sync` |

**`colours sync` is the one command with two read-only tools**, because `--check` and `-n` answer
different questions: `colours_check` exits non-zero when an artifact is stale, and
`colours_sync_preview` says which one and what would change in it.

**`pr_refresh` is pre-approved even though the table below calls it an act.** Both are right. It
writes a cache file, so it acts; but the clone bar spawns exactly this, detached, every time a
record passes `forge.prCacheTtlSeconds`, and asking you to approve what happens unattended twenty
times a minute would be theatre. The next redraw would rewrite what it wrote.

**Four commands have no tool, and none of them is an oversight.** `claude` refuses whenever
`$CLAUDECODE` is set, so the tool could only ever fail — and it is the escalation boundary.
`dev release` pushes and cuts a version, and its confirmation fails closed, so the only form that
would work as a tool call is the one with `-y`. `dev golden` writes a partial capture that would
read as the gate without being it. `jira hook` reads a `PreToolUse` payload from stdin and has
nothing to do without one. For those, the shell is the only path and its own rules apply.

**No tool offers `--quiet`.** It exists so a `SessionEnd` hook and the status bar's own spawn can
say nothing unless something needs a human; you have the opposite need.

**The shell is not closed.** Every Bash rule this mode had still stands, so anything the tools do
not cover is still reachable by typing it. The tools are the better default door, not a wall —
`hangar doctor --fix` at a shell prompt is still governed by the coarse `Bash(hangar doctor:*)`
rule that cannot tell it from the report.

## Top level

| Command | Args | Options | |
| --- | --- | --- | --- |
| `list` | — | `--no-refresh` | report (asks Bitbucket for stale pull requests, ≤3s; writes only the bar's PR cache) |
| `ports` | — | `--json` | report |
| `scrub` | — | `--recent [hours]` (default `24`; pass a big number for the whole store) · `-q, --quiet` | report |
| `status` | `[clone]` (defaults to every clone) | `-a, --all` · `-f, --fetch` | report (`--fetch` reaches the network, touches no tree) |
| `sync` | `[clone]` | `-a, --all` · `-n, --dry-run` · `--no-session-notify` · `--include-busy` · `--onto <ref>` · `--strategy <rebase\|merge>` | **act [user]** |
| `merge-default`, `rebase-default` | — | aliases of `sync`, identical options | **act [user]** |
| `checkout-default` (alias `checkout`) | `[clone]` | `-a, --all` · `-n, --dry-run` · `--include-busy` | **act [user]** |
| `open` | `[clones...]` | `--all` · `--no-claude` · `-e, --editor` · `-b, --branch <name>` · `--no-checkout` · `--include-busy` · `-n, --dry-run` | **act [user]** |
| `edit` | `[clones...]` | `--all` · `-n, --dry-run` | **act [user]** |
| `close` | `[clones...]` | `--all` · `--no-editor` · `-y, --yes` · `--force` · `-n, --dry-run` | **act [user]** |
| `reload` | `[clones...]` | `--all` · `--no-shells` · `--no-claude` · `--no-editor` · `-y, --yes` · `-n, --dry-run` | **act [user]** |
| `browse` | `<ticket\|pr> <clone>` | `-n, --dry-run` (print the URL, open nothing) | act (opens a browser; `-n` is report) |
| `pr refresh` | `[clones...]` | `-a, --all` · `--force` · `-q, --quiet` · `-n, --dry-run` | act (writes a cache; the bar spawns it for you) |
| `pr create` | `[clone]` (defaults to the clone you are in; naming ANOTHER is refused) | `--onto <branch>` · `--title <text>` · `--file <path>` · `--ready` · `--no-describe` · `--include-busy` · `-y, --yes` · `-n, --dry-run` | **act — writes to the forge.** Opens a DRAFT unless `--ready` |
| `pr update` | `[clone]` (same rule) | `--title <text>` · `--file <path>` · `--keep-title` · `--keep-body` · `--draft` \| `--ready` · `--no-describe` · `--include-busy` · `-y, --yes` · `-n, --dry-run` | **act — writes to the forge.** Only on pull requests you opened |
| `resume` | `[clone]` (defaults to the clone you are in) | `-n, --limit <count>` (default `20`, `0` = all) | report **for you** — with no tty it prints the list instead of the picker; at a terminal it launches `claude --resume` |
| `add-clone` | — | `--no-install` (+ a hidden `--remote <url>`) | **act [user]**, no `-n` |
| `install` | `[clone]` | `--all` · `-n, --dry-run` | **act [user]** |
| `allow` | `[clone]` (defaults to the clone you are in) | `--all` · `-n, --dry-run` | act — runs `direnv allow`, touches no tree |
| `exec` | `[clones...] -- <snippet>` | `-a, --all` · `-n, --dry-run` · `--no-direnv` · `--serial` · `-j, --jobs <n>` | **[user] ONLY — denied to you, hook-enforced** |
| `remove-clone` | `<clone>` | `--delete` · `--force` | **act [user]**, no `-n` |
| `doctor` | `[clone]` (defaults to every clone) | `-a, --all` · `--fix` | report bare; **act [user]** with `--fix` |
| `setup` | — | `-y, --yes` · `--origin <url>` · `--id <name>` · `--preset <name>` · `--force` · `-n, --dry-run` | act |
| `teach-rg` | `<clone>` | `-n, --dry-run` · `-y, --yes` | act |
| `claude` | `[claude-args...]` (passed through untouched) | `-m, --mode <ops\|dev>` (default `ops`) · `--replace` · `--yes` · `--dry-run` | **DENIED to you** — see below |
| `mcp` | — | — | serves the tools; the server itself touches nothing, each call spawns `bin/hangar` |

**`claude` is the one command in this table you cannot run**, and the denial is deliberate rather
than an oversight in the permission list. It opens the two hangar-root sessions as tabs of one
tmux window — plus a third tab that is only a shell — and it passes every other argument straight
through, so `hangar claude -m dev -p '…'`
would start a session under developer mode's rules, with the writes to `app/**` that this mode is
denied. `ops.settings.json` denies both `Bash(hangar claude)` and `Bash(hangar claude:*)`, and the
command refuses a second time on its own when `$CLAUDECODE` is set, so it will not run from here
even if a settings file says otherwise.

What that means in practice: when a task needs the CLI changed, **name the file and stop** — do
not try to open the developer tab. It is already the next window of the session you are in, and
`C-b n` is how the user reaches it.

**`--dry-run` is spelled out and `-n` is not available**, because `-n` is claude's own `--name`
and everything but hangar's four flags belongs to claude. This is the second exception to "every
`-n` in this CLI is a dry run", after `resume`'s `--limit`.

**`mcp` is where the tools in the mapping above come from, and you will not normally type it.**
`hangar claude` names `.claude/modes/mcp.json` as `--mcp-config`, so a mode session starts one of
these for itself and speaks the protocol to it on stdin and stdout. Run by hand it looks hung: with
no client it waits, which is correct rather than a fault.

**What it is good for by hand is a probe, and that is the first thing to run when `/mcp` says the
hangar server failed to start.**

```
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
               '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | hangar mcp
```

Two lines of valid JSON out and nothing on stderr means the server is fine and the problem is at
Claude Code's end — reconnect it rather than reporting a broken CLI. Every tool named in the
mapping table above should appear in the second line; one that does not, or a command named on
stderr as having no tool at all, is the developer tab's to fix, not yours.

## Groups

| Command | Args | Options | |
| --- | --- | --- | --- |
| `config show` | — | — | report |
| `config validate` | — | — | report (also compares `hangar.config.example.yaml` with the live file when both declare the same `id`) |
| `config schema` | — | `--check` · `--out <path>` | act (writes `hangar.schema.json`; `--check` is the read-only form) |
| `jira hook` | — | `--ttl <minutes>` (overrides `tracker.cache.ttlMinutes`, which is the default) · `-n, --dry-run` · `--explain` | act (a `PreToolUse` hook; you do not call this by hand) |
| `plans collect` | — | `-n, --dry-run` · `-q, --quiet` · `--no-transcript-scan` · `--in-use-window <minutes>` | act (runs from each clone's `SessionEnd` hook) |
| `plans stamp` | — | `-n, --dry-run` · `--no-transcript-scan` · `--in-use-window <minutes>` | act |
| `tmp merge` | — | `-n, --dry-run` · `-q, --quiet` | act (runs from each clone's `SessionEnd` hook) |
| `skills list` | — | — | report (each personal skill: whether it is linked, and whether the tracked original moved under it) |
| `skills sync` | — | `-n, --dry-run` · `--adopt` | **act [user]** — writes OUTSIDE the hangar, into `~/.claude/skills` |
| `bookmarks sync` | — | `-n, --dry-run` · `--profile <dir>` (default `Default`; Firefox: its installation's own) · `--browser <all\|brave\|chrome\|firefox>` (default `all`) | **act [user]** — writes the Bookmarks bar of Brave, Chrome and Firefox in one run: one folder per `ports.roles[].bookmark`, one `clone N - <label>` link per clone, anything else in that folder removed. A browser that is not installed is skipped. **Refuses while any browser that has changes is running** (it would overwrite the file from memory) and then writes to none; `-n` works regardless |
| `ide <kind> sync` (group alias `editor`) | — | `--from <clone>` · `-n, --dry-run` | act |
| `colours sync` (group alias `colors`) | — | `-n, --dry-run` · `--check` | act |
| `colours change` | `<clone> <colour>` | `--force` | **act [user]**, no `-n` |
| `colours list` | — | — | report |
| `ports pin` | `[clones...]` | `-a, --all` · `-n, --dry-run` | **act [user]** — holds clones on the ports their `.env.local` names now |
| `ports unpin` | `<clone>` | `-n, --dry-run` | **act [user]** — releases one clone to the formula; `doctor <clone> --fix` then moves it |
| `servers list` | `[clones...]` (defaults to every clone) | `-a, --all` · `--stale` · `--roles` | report |
| `servers start` | `[clones...]` | `-a, --all` · `--role <id...>` · `-n, --dry-run` | **act [user]** (needs the clone to have a tmux session) |
| `servers kill` | `[clones...]` | `-a, --all` · `--role <id...>` · `--name <stem...>` · `--pid <pid...>` · `--force` · `-n, --dry-run` · `-y, --yes` | **act [user]** |
| `servers prune` | `[clones...]` (defaults to every clone) | `-a, --all` · `-n, --dry-run` | act |

**`ide` always registers all four editor families that have a shareable setup** — `vscode`,
`jetbrains`, `zed`, `emacs` — regardless of what `editor.kinds` says. `editor.kinds` decides which
editors `hangar open` launches and which ones `doctor` reports on, **not** which `ide` subcommands
exist. Naming one this hangar does not use is refused rather than half-done:

```
$ hangar ide jetbrains sync -n
error: jetbrains is not one of this hangar's editors
       Add it to `editor.kinds` in hangar.config.yaml.
```

This hangar lists `['vscode']`, so `hangar ide vscode sync` is the only one that will run here.
The other nine kinds (`cursor`, `windsurf`, `vscodium`, `code-insiders`, `positron`, `trae`,
`vim`, `xcode`, `eclipse`) have no `sync` subcommand at all — there is nothing shareable to sync.

**`ports pin` and `ports unpin` are how a port layout change reaches a busy fleet one clone at a
time.** Pin every clone (`ports pin --all`), change `ports` in `hangar.config.yaml`, and every
command still derives exactly the ports each clone's `.env.local` names — `doctor`, `servers`, the
health-check allow, the identity file. Then, per clone and when it is idle: `ports unpin <clone>`,
`doctor <clone> --fix` (which rewrites the `.env.local`, the health-check allow and
`CLAUDE.local.md` together), restart its servers, and `reload <clone>` so its session reads the new
ports. `unpin` refuses when the formula would put the clone on a port a still-pinned sibling holds
and names the sibling to release first. Between `unpin` and `doctor --fix` the clone's derived ports
and its `.env.local` disagree, so run the two together.

**`colours change`'s `<colour>` is a fixed choice list**, from `src/palette.ts`: `cyan`, `yellow`,
`green`, `orange`, `magenta`, `violet`, `red`, `teal`, `blue`, `lime`, `pink`, `amber`, `purple`,
`indigo`, `crimson`, `silver`. A typo is a usage error listing the real names, not a silent no-op.

**Per-command notes** — the traps, the flags that mean something unusual, `scrub` and
`config validate` — are in `command-notes.md`. Read the section for the command you are about to
run; you do not need the file for a routine `list`, `open` or `sync`.
