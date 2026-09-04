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
| `open` | `[clones...]` | `--all` · `--no-claude` · `--no-editor` · `-b, --branch <name>` · `--no-checkout` · `--include-busy` | **act [user]**, no `-n` |
| `resume` | `[clone]` (defaults to the clone you are in) | `-n, --limit <count>` (default `20`, `0` = all) | report **for you** — with no tty it prints the list instead of the picker; at a terminal it launches `claude --resume` |
| `add-clone` | — | `--no-install` (+ a hidden `--remote <url>`) | **act [user]**, no `-n` |
| `remove-clone` | `<clone>` | `--delete` · `--force` | **act [user]**, no `-n` |
| `doctor` | `[clone]` (defaults to every clone) | `-a, --all` · `--fix` | report bare; **act [user]** with `--fix` |
| `setup` | — | `-y, --yes` · `--force` · `-n, --dry-run` | act |
| `teach-rg` | `<clone>` | `-n, --dry-run` · `-y, --yes` | act |

## Groups

| Command | Args | Options | |
| --- | --- | --- | --- |
| `config show` | — | — | report |
| `config validate` | — | — | report |
| `config schema` | — | `--check` · `--out <path>` | act (writes `hangar.schema.json`; `--check` is the read-only form) |
| `jira hook` | — | `--ttl <minutes>` (default `60`) · `-n, --dry-run` · `--explain` | act (a `PreToolUse` hook; you do not call this by hand) |
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
- **`open` has no `-n`.** `--no-claude`, `--no-editor` and `--no-checkout` narrow what it does;
  there is no way to preview it.
- **`remove-clone --force` is the one genuinely unrecoverable flag in this CLI** — its own help says
  uncommitted work is NOT recoverable. Never pass it without the user asking for it in those terms.
- **`add-clone --no-install` leaves the clone unable to serve, test or build** until someone runs
  the install by hand.
- **`doctor` with no clone argument already checks every clone**, so `-a` is only needed to be
  explicit.
- **`resume -n` is `--limit`.** Everywhere else `-n` is `--dry-run`.
- **`-q, --quiet` on `plans collect` and `tmp merge` exists for the `SessionEnd` hooks.** They flush
  on opposite criteria — `plans collect` prints when something MOVED, `tmp merge` when something
  WARNED — so silence from either is the normal outcome, not a failure.
