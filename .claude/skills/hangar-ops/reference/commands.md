# The command surface

Transcribed from `app/src/cli.ts`. **`report` = touches nothing. `act` = writes files, moves git
state, or opens windows.** The seven marked **[user]** are the ones the hangar's `CLAUDE.md`
reserves for the user at the hangar root — preview them and hand the real command over.

**Every command below is also an MCP tool**, and the next section is the map between the two. The
tool spawns `bin/hangar` with exactly this argv, so the tables here are the truth for both; what
differs is only the spelling. **[user]** is unchanged by any of it — that is governance, and a
permission rule does not encode "hand this one over".

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
| `ports` | `ports` (always `--json`) | — |
| `status` | `status` | — |
| `doctor` | `doctor` | `doctor_fix` |
| `sync` | `sync_preview` | `sync` (`strategy` picks rebase or merge) |
| `checkout-default` | `checkout_default_preview` | `checkout_default` |
| `open` | `open_preview` | `open` |
| `close` | `close_preview` | `close` |
| `reload` | `reload_preview` | `reload` |
| `install` | `install_preview` | `install` |
| `browse` | `browse_preview` | `browse` |
| `pr refresh` | `pr_refresh_preview`, and `pr_refresh` itself | — |
| `resume` | `resume_list` | — |
| `teach-rg` | `teach_rg_preview` | `teach_rg` |
| `setup` | `setup_preview` | `setup` |
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
| `list` | — | — | report |
| `ports` | — | `--json` | report |
| `status` | `[clone]` | `-a, --all` · `-f, --fetch` | report (`--fetch` reaches the network, touches no tree) |
| `sync` | `[clone]` | `-a, --all` · `-n, --dry-run` · `--no-session-notify` · `--include-busy` · `--onto <ref>` · `--strategy <rebase\|merge>` | **act [user]** |
| `merge-default`, `rebase-default` | — | aliases of `sync`, identical options | **act [user]** |
| `checkout-default` (alias `checkout`) | `[clone]` | `-a, --all` · `-n, --dry-run` · `--include-busy` | **act [user]** |
| `open` | `[clones...]` | `--all` · `--no-claude` · `--no-editor` · `-b, --branch <name>` · `--no-checkout` · `--include-busy` · `-n, --dry-run` | **act [user]** |
| `close` | `[clones...]` | `--all` · `--no-editor` · `-y, --yes` · `--force` · `-n, --dry-run` | **act [user]** |
| `reload` | `[clones...]` | `--all` · `--no-shells` · `--no-claude` · `--no-editor` · `-y, --yes` · `-n, --dry-run` | **act [user]** |
| `browse` | `<ticket\|pr> <clone>` | `-n, --dry-run` (print the URL, open nothing) | act (opens a browser; `-n` is report) |
| `pr refresh` | `[clones...]` | `-a, --all` · `--force` · `-q, --quiet` · `-n, --dry-run` | act (writes a cache; the bar spawns it for you) |
| `resume` | `[clone]` (defaults to the clone you are in) | `-n, --limit <count>` (default `20`, `0` = all) | report **for you** — with no tty it prints the list instead of the picker; at a terminal it launches `claude --resume` |
| `add-clone` | — | `--no-install` (+ a hidden `--remote <url>`) | **act [user]**, no `-n` |
| `install` | `[clone]` | `--all` · `-n, --dry-run` | **act [user]** |
| `remove-clone` | `<clone>` | `--delete` · `--force` | **act [user]**, no `-n` |
| `doctor` | `[clone]` (defaults to every clone) | `-a, --all` · `--fix` | report bare; **act [user]** with `--fix` |
| `setup` | — | `-y, --yes` · `--origin <url>` · `--id <name>` · `--preset <name>` · `--force` · `-n, --dry-run` | act |
| `teach-rg` | `<clone>` | `-n, --dry-run` · `-y, --yes` | act |
| `claude` | `[claude-args...]` (passed through untouched) | `-m, --mode <ops\|dev>` (default `ops`) · `--replace` · `--yes` · `--dry-run` | **DENIED to you** — see below |

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
| `ide <kind> sync` (group alias `editor`) | — | `--from <clone>` · `-n, --dry-run` | act |
| `colours sync` (group alias `colors`) | — | `-n, --dry-run` · `--check` | act |
| `colours change` | `<clone> <colour>` | `--force` | **act [user]**, no `-n` |
| `colours list` | — | — | report |

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

**`colours change`'s `<colour>` is a fixed choice list**, from `src/palette.ts`: `cyan`, `yellow`,
`green`, `orange`, `magenta`, `violet`, `red`, `teal`, `blue`, `lime`, `pink`, `amber`, `purple`,
`indigo`, `crimson`, `silver`. A typo is a usage error listing the real names, not a silent no-op.

## Notes that change what you type

**These are written in the shell spelling**, because that is the form you hand to the user and the
form the flags are named in. Everything here is equally true of the tool that runs it — the map
above says which — with one substitution throughout: where a note says `-n`, the tool is the
separate `<thing>_preview`.


- **The editor commands live under `ide`, aliased `editor`, so the top level carries one entry for
  the editors rather than one per editor.** `colours` is aliased `colors`, and `checkout-default`
  is aliased `checkout`.
- **`sync`, `merge-default` and `rebase-default` are one command.** All three resolve the same
  target — whatever the branch's open pull request points at, which is often *not* the default
  branch — and only the strategy differs. `--strategy` outranks the name.
- **`--onto <ref>` skips the pull-request lookup entirely.** Reach for it only when the user names
  a target; the lookup is usually the right answer and is printed on every run.
- **A `sync` that hits conflicts can be steered while it works, and only from a terminal.** While
  the headless resolver is running, a line typed at the keyboard plus Enter reaches it — "keep
  master's version of that spec" — and comes back as a cyan `→ sent:` line, which is the
  confirmation it was delivered. It is picked up at the resolver's NEXT turn rather than the one
  in flight, so a line typed mid-tool-call lands a few seconds later. There is no flag: the
  channel exists when stdin is a tty and does not when it is not, which means **no agent can use
  it — through the Bash tool or the `sync` tool alike.** A tool call has no terminal either, so
  there is no channel and the run is the fire-and-forget one. This is the user's to type, in the window the sync is running in.
- **A `--continue` during that sync owns the terminal.** If git needs an answer — a GPG passphrase
  for a signed commit, a prompt from one of the repo's own hooks — the question appears on screen
  and waits for it. There is no timeout, so a sync sitting silent after the resolver has finished
  is worth LOOKING at rather than killing: something is asking.
- **`open -n` is worth running before the real thing.** It prints the branch each clone would
  land on (or why it would be left alone), the tmux session and windows it would create or the
  window it would bring forward, the attach line verbatim, and the editors it would launch — and
  changes nothing. `--no-claude`, `--no-editor` and `--no-checkout` still narrow what the real run
  does; `-n` is how you see it first.
- **`remove-clone --force` is the one genuinely unrecoverable flag in this CLI** — its own help says
  uncommitted work is NOT recoverable. Never pass it without the user asking for it in those terms.
- **`add-clone --no-install` leaves the clone unusable** until someone runs `hangar install
  <clone>`. It prints the exact steps it skipped, from `repo.install[]`, each with its `why`.
- **`hangar install` is the user's command, and `-n` first is not optional courtesy.** What it
  runs comes from `repo.install[]`, and this repo's step is `npm ci` — which DELETES
  `node_modules` before refetching it, so a clone with a dev server running loses it mid-request.
  `hangar install <clone> -n` prints every step without spawning anything.
- **`doctor` prints two machine-level rows before the clones, and both are diagnostics rather
  than passes.** `platform` names the OS and what it can do for Hangar, with a note per capability
  it lacks; `claude sessions` says how many live sessions the detector found and how many
  processes it looked at. **Zero sessions on a machine where Claude Code is running is a real
  finding, not a quiet nothing** — it means `sync --all` will not skip busy clones and no
  `SYNC PAUSE` can be delivered. When that happens the row names the command names that mention
  `claude` anyway; report those, they are the whole diagnosis.
- **Every window Hangar opens is a tmux window, on Hangar's own socket.** `hangar open <n>` opens
  one emulator tab per clone attached to that clone's session, with one tmux window inside it per
  `terminal.tabs[]` role; `--window` puts it in a window of its own. A clone that is already open
  is brought forward and nothing is written to its session, and a clone whose tab was closed
  reattaches to the session it still has — with whatever was running in it. **`--all` is one tab
  per clone, so on a four-clone fleet it opens four**, each with its own session and its own hue;
  name the clones you want if that is not what you meant.
  `tmux -L hangar-<id> ls` lists the fleet's sessions from any shell and
  `tmux -L hangar-<id> attach -t '=<clone>:'` gets you back into one by hand, which is also the
  answer when the emulator cannot bring a window forward (GNOME Terminal). That socket is
  private, so none of this touches the tmux the user runs for their own work — and a bare
  `tmux ls` will not see it. `terminal.kind` names which emulator hosts the window and overrides
  the detection; `terminal.kind: none` opens no window at all and prints the attach line instead,
  which is a mode rather than a failure. `doctor`'s `emulator` and `tmux` rows are where to check
  what it picked and what the server is doing.
- **The clone bar is two lines, and two of its fields are clickable.** Across the top: the tabs,
  then the issue key and the pull request. Along the bottom, on a band of the clone's own hue: the
  clone, where in it the pane is standing, its git state and its branch. A click on the key or on
  `PR#1234` opens it in the browser; a click on a tab still switches to that window, and a click
  on a pane border still marks the pane. What a click runs is `hangar browse ticket|pr <clone>`,
  which is also worth typing directly.

  The git state is glyphs, and there are seven: `✔` nothing to report, `⚑` a half-applied rebase
  or merge, `‼` conflicts, `✚` staged, `✱` changed and not staged, `?` untracked, and `⇡n` / `⇣n`
  ahead of and behind the upstream. They combine, most urgent first — `⚑‼` is a merge you have to
  finish, `✚✱?` is work in three states at once. They are glyphs rather than colours on purpose:
  the footer sits on the clone's hue, and a red mark on the red clone would be invisible.

  **The pull request says what it is doing, not just its number.** `✎#862 ✗ ≈` is draft, build
  failing, changes requested. Three axes, one glyph each:

  | | |
  | --- | --- |
  | pull request | `✎` draft · *(nothing)* open and ready · `✔` merged · `✖` declined |
  | build | `✓` pass · `✗` fail · `◌` running · *(nothing)* no build reported |
  | review | `+` approved · `≈` changes requested · `·` nobody has reviewed yet |

  A merged or declined one shows its glyph and number alone — the build and the reviews are
  settled. The build glyph is the one coloured thing on the bar, and it is green or red *as well
  as* a different shape, so the line reads correctly in monochrome or with colour-blindness.
  `≈` beats `+`: one outstanding change request blocks the merge however many approvals sit
  beside it, so the bar shows the blocking half of a mixed answer.

  **It keeps itself current, and nothing ever waits for the network to draw a bar.** The bar
  prints what it last knew and, when that is older than `forge.prCacheTtlSeconds` (90 by default),
  spawns a `hangar pr refresh` in the background whose answer appears a few seconds later. So a
  brand-new branch shows a bare `PR` for one refresh and then the real number, with nobody having
  asked. A hangar nobody is looking at makes no requests at all. `hangar pr refresh <clone>` is
  the same thing by hand, and prints what it found — worth running when the bar says something
  surprising and you want to see the answer come back. **That is also the diagnostic when the
  field never changes at all:** the background refresh writes its errors to `/dev/null`, so a
  tmux server started in a shell direnv never touched (no `node` on PATH) leaves the bar looking
  merely stale. Typed by hand, the same command says what is wrong.

  Three things to know when a field is blank rather than wrong:
  **the ticket key comes from the branch name** (a branch without one shows nothing, and there is
  no fallback to commit subjects here — `hangar status` does that);
  **a bare `PR`** means either nobody has asked yet or the branch genuinely has none — either way
  it links to that branch's pull requests, so it is worth clicking;
  and **the bar refreshes every few seconds**, so a branch you have just switched — or a file you
  have just saved — takes a moment to show up on either line.
  A blank field is never an error message — everything behind the bar exits quietly, because a
  status line is no place to report one.
- **Claude Code's own status line in a clone shows the context, the model and the session id.**
  `● 233k/1M · 23% · Opus 5 (1M context) · df714160` — the `●` is the clone's hue, and the last
  field is the first eight characters of the session id, which is what `claude --resume` takes.
  The clone's name and branch are not repeated there: the tmux footer has them. Three things it
  cannot show, and each is Claude Code's rather than a gap here — **the task list** (not in the
  status-line payload, and the on-disk format is documented as internal and version-fragile),
  **the active plan's name or file** (not in the payload; the label in the input box is Claude
  Code's own), and the raw **`NNNNNN tokens` badge**, which is a built-in footer row with no
  setting to hide or reformat. The humanised figure is beside that badge, not instead of it, and
  it counts the same tokens with the window size and percentage added.
  **A theme or status-line change needs Claude Code restarted in that clone.**
- **`hangar close <clone>` is the other end of `open`, and it kills a live Claude Code session.**
  The editor window is closed, the clone's tmux session goes with every window in it, and the
  plans that session cannot collect for itself are collected — a killed Claude Code process skips
  its `SessionEnd` hook, so this command does that work instead.
  **There is one tmux server per hangar, not one per clone**, so it kills the clone's SESSION;
  `kill-server` would end every other clone in the fleet. The server exits on its own once its
  last session closes, which is what makes the next `hangar open` read a fresh conf.
  It **refuses** to close the clone whose own session you typed the command in — that kills the
  terminal mid-command — and `--force` is the way past. Everything else worth knowing (a live
  session, a dev server that dies with it) is named in one confirmation, which `-y` skips.
- **`hangar reload <clone>` puts an open clone back on current config without closing it**, and
  it is the answer for the settings `colours sync` cannot reach: `source-file` re-executes the
  whole conf on the live server, SERVER options included. `extended-keys` and `focus-events` are
  negotiated when a client attaches, so those two still want the tab reopened.
  Each **idle shell** is restarted so it re-runs direnv and picks up the current PATH and prompt.
  A pane running anything else — a dev server, a test run — is left alone and **named**.
  **Claude Code is restarted into the same conversation** with `--resume <session-id>`, because
  its process is what holds the settings and `CLAUDE.md` read once at start-up. With two sessions
  in one clone the id is a best guess, so it is printed before anything is killed and
  `--no-claude` declines the whole step; `--no-shells` declines the other half.
  A workspace file that differs from its builder is **reported, never written** — that belongs to
  `hangar doctor --fix`.
- **Closing an editor window needs macOS and Accessibility, and the grant is not just your
  terminal.** hangar's commands run inside its own tmux server, which is reparented to launchd —
  so the chain is detached from the terminal, and macOS attributes the request to the tmux binary
  instead. Allow **both**, in System Settings → Privacy & Security → Accessibility: the terminal
  you run `hangar` from, and tmux's REAL path — `readlink -f "$(command -v tmux)"`, because the
  one on PATH is a symlink and TCC records the target, which makes the symlink the one path that
  will not work. In the `+` file picker, Cmd-Shift-G takes a path; `/opt` is hidden and cannot be
  browsed to. Then **restart the tmux server**: one that has already been refused keeps that
  answer until it does. Homebrew's target carries the version, so `brew upgrade tmux` moves it and
  the grant has to be made again.
  Without all of that — or on Linux — the window stays open, `hangar close` prints these steps and
  does everything else. Reloading a window is not possible at all: VS Code's `Reload Window` has
  no default keybinding outside a development build, and VS Code applies a settings change live
  anyway.
- **A clone's shells inside hangar's tmux get a short prompt, and only there.** One `❯` in the
  clone's hue — red instead when the last command failed — with no user, host, path, git state or
  time, because the footer two lines down is already saying all five. It is gated on the tmux
  SOCKET rather than on the directory, so a plain terminal in the same clone, and the hangar-root
  modes tabs, both keep your own prompt. `HANGAR_KEEP_PROMPT=1` in your rc turns it off
  everywhere. Your `PROMPT` and `RPROMPT` are saved on the way into a clone and put back on the
  way out — which works for a theme that sets those two, and is defeated by one that paints from
  `precmd_functions`. **A running shell never picks this up**: it comes from `clone-terminal.sh`
  at shell start, so it arrives in the next tab `hangar open` makes.
- **`hangar colours sync` is what puts a bar change onto a server that is already running.** The
  generated conf is read once, when the server starts, so it reaches only sessions opened after
  it was written; `colours sync` writes the same settings straight onto the live server and
  repaints each session, with nothing restarted. `doctor` reports both generated files —
  `clone-tmux.conf` and `clone-tmux-status.sh` — against their builders, and never offers
  `kill-server` as the fix.
- **`status`'s `servers` row now finds a server two ways** — a `*.pid` file, or something
  listening on one of the clone's ports. A port-found server is shown as
  `<role> (pid N, listening on P)`. `no pid file — ports not checked (no lsof)` is **not** "nothing
  is running": it means `lsof` is missing, so nobody could ask. Install it.
- **`remove-clone` refuses when `lsof` is missing and the clone has no pid file.** A guard that
  could not run is not a guard that passed — without `lsof` nothing can tell whether the clone is
  still serving. Check its ports by hand, or install `lsof`; `--force` overrides, and on a
  `--delete` that is unrecoverable.
- **A clone's `*.code-workspace` is compared by content, and `--fix` rewrites it.** Everything in
  it is generated — the folder label, the clone path, and the per-clone settings that put the clone
  name and its branch in the VS Code title bar and its hue on the activity bar. So it is hand-edit-
  at-your-peril like `CLAUDE.local.md`, and a hangar whose generated settings change reaches every
  existing clone through `hangar doctor --all --fix` rather than only new ones.
- **`doctor` never runs an install step; it only checks the declaration.** A green install row
  means the directory exists and the manager's marker is there. A **dim** row (rather than green)
  means the manager leaves nothing inside the clone to look at — maven, go, cargo, pip, poetry,
  gradle, deno, bundler — so there is genuinely no answer, which it says rather than guessing.
- **`hangar setup --force` is the one command that destroys live untracked state.** The config is
  gitignored, so git cannot restore it — back it up before running `--force` anywhere that already
  has a config. `-n` is safe: it validates the render in memory and writes nothing.
- **`setup -y` needs `--origin <url>` in a fresh checkout.** The origin URL is the one field with
  no derivable default. With neither the flag nor a terminal to ask on, setup refuses and names the
  flag rather than exiting quietly.
- **`--id <name>` overrides deriving the id from the directory basename**, which is what `-y`
  does. Only needed when the directory is not named what the hangar should be called.
- **`setup --preset <name>` supplies the two answers no checkout can:** the port roles and the
  per-clone environment variables. `generic`, `node-web`, `sql-postgrest`. A preset writes plain
  config and is never read again; `profile:` in the result is a label no code consults.
- **`--hangar <path>` means "the directory to set up"** for `setup`, since there is no config yet
  to resolve. Every other command resolves it as the hangar to act on.
- **`doctor` with no clone argument already checks every clone**, so `-a` is only needed to be
  explicit.
- **`resume -n` is `--limit`.** Everywhere else `-n` is `--dry-run`.
- **`-q, --quiet` on `plans collect` and `tmp merge` exists for the `SessionEnd` hooks.** They flush
  on opposite criteria — `plans collect` prints when something MOVED, `tmp merge` when something
  WARNED — so silence from either is the normal outcome, not a failure.

## `config validate` also checks the committed example

The live `hangar.config.yaml` is gitignored; `hangar.config.example.yaml` is the only committed
record of it, and the file a colleague copies to join the fleet. So `config validate` compares
the two — as parsed configs with every default applied, not as text — and reports each line that
has drifted, by dotted path with both values.

It only compares when the two files declare the **same `id`**. A different id means the example
is the shipped template for some other repo, where drift is expected and a permanent warning
would be noise; you get one dim line saying it was skipped.

Drift is never fatal and never blocks anything. What it costs is recoverability: a stale example
is a config nobody can rebuild. If you see it, the fix is a hand edit to the example — nothing
generates it.
