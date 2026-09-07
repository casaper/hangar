# The command surface

Transcribed from `app/src/cli.ts`. **`report` = touches nothing. `act` = writes files, moves git
state, or opens windows.** The seven marked **[user]** are the ones the hangar's `CLAUDE.md`
reserves for the user at the hangar root — dry-run them and hand the real command over.

Global: `--hangar <path>` (the hangar root to operate on; **only `config show` and
`config validate` honour it today** — everything else uses the upward walk from the cwd).

`<clone>` accepts an index (`2`), a padded name (`clone_02`), or `02`.

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
| `resume` | `[clone]` (defaults to the clone you are in) | `-n, --limit <count>` (default `20`, `0` = all) | report **for you** — with no tty it prints the list instead of the picker; at a terminal it launches `claude --resume` |
| `add-clone` | — | `--no-install` (+ a hidden `--remote <url>`) | **act [user]**, no `-n` |
| `install` | `[clone]` | `--all` · `-n, --dry-run` | **act [user]** |
| `remove-clone` | `<clone>` | `--delete` · `--force` | **act [user]**, no `-n` |
| `doctor` | `[clone]` (defaults to every clone) | `-a, --all` · `--fix` | report bare; **act [user]** with `--fix` |
| `setup` | — | `-y, --yes` · `--origin <url>` · `--id <name>` · `--preset <name>` · `--force` · `-n, --dry-run` | act |
| `teach-rg` | `<clone>` | `-n, --dry-run` · `-y, --yes` | act |

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

- **The editor commands live under `ide`, aliased `editor`, so the top level carries one entry for
  the editors rather than one per editor.** `colours` is aliased `colors`, and `checkout-default`
  is aliased `checkout`.
- **`sync`, `merge-default` and `rebase-default` are one command.** All three resolve the same
  target — whatever the branch's open pull request points at, which is often *not* the default
  branch — and only the strategy differs. `--strategy` outranks the name.
- **`--onto <ref>` skips the pull-request lookup entirely.** Reach for it only when the user names
  a target; the lookup is usually the right answer and is printed on every run.
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
- **`status`'s `servers` row now finds a server two ways** — a `*.pid` file, or something
  listening on one of the clone's ports. A port-found server is shown as
  `<role> (pid N, listening on P)`. `no pid file — ports not checked (no lsof)` is **not** "nothing
  is running": it means `lsof` is missing, so nobody could ask. Install it.
- **`remove-clone` refuses when `lsof` is missing and the clone has no pid file.** A guard that
  could not run is not a guard that passed — without `lsof` nothing can tell whether the clone is
  still serving. Check its ports by hand, or install `lsof`; `--force` overrides, and on a
  `--delete` that is unrecoverable.
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
