# Hangar

**A hangar is one directory holding several full clones of the same git repository, plus a CLI
that keeps them in step.** It exists so that you can have three or four branches checked out, each
with its own dev server, its own test run and its own Claude Code session, and never have them
quietly interfere with each other.

```
~/code/dvb_gn/            <- the hangar root
├── clone_01/             <- a full clone. Its own node_modules, its own ports, its own colour
├── clone_02/
├── clone_03/
├── app/                  <- the `hangar` CLI (TypeScript, no build step)
├── bin/hangar            <- the executable, put on PATH by direnv
├── hangar.config.yaml    <- the marker file: this is what makes the directory a hangar
├── plans/  tmp/          <- shared between all clones
└── .env.shared           <- every secret, once, mode 600, outside every clone
```

**Full clones, not `git worktree`.** Worktrees share one `.git` and one set of dependencies. Each
clone here needs its own `node_modules`, its own running dev server, its own Storybook and its own
browser test run — that isolation is the entire reason the fleet exists.

## What it does for you

- **One view of the fleet.** `hangar list`, `hangar ports`, `hangar status --all` — which clone is
  on which branch, which ports belong to whom, which dev servers and Claude sessions are alive.
- **No bookkeeping.** Ports and colour are pure functions of the clone index, and the clone list is
  whatever `clone_NN/` directories exist. There is no registry file to keep up to date, and index
  gaps are normal — removing a clone never renumbers the others, because renumbering would move
  another clone's ports out from under a running server.
- **Bringing a clone up to date correctly.** `hangar sync` stashes, fetches, and integrates onto
  the branch the clone's **pull request targets** — asked of the forge API, not guessed from
  `master` — then puts your work back. Conflicts are handed to a headless Claude Code run inside
  that clone and then verified mechanically; if that fails the whole thing is rolled back rather
  than left half-merged.
- **It talks to the session in the clone.** There is no API for messaging a running interactive
  Claude Code session, so `sync` finds its tty, maps it to the tmux pane on that tty and puts a
  `SYNC PAUSE` line on its input, then exactly one `SYNC FINISHED` or `SYNC ABORTED`. An agent in
  that clone knows to stand still. It goes through tmux because typing at a raw tty is not a
  portable option — VTE exposes no API for it and the generic POSIX route (`TIOCSTI`) has been off
  by default on Linux since 6.2 — and a session in no such pane is reported unreachable rather
  than assumed paused.
- **One window per clone.** `hangar open 1` opens a tab in your terminal attached to clone 1's own
  tmux session — one tmux window per configured role — on a freshly fast-forwarded default branch,
  with the editor opened alongside. Run it again and that window comes to the front; you never get
  a second one, and a clone whose tab you closed reattaches with whatever was still running in it.
  The tmux server is Hangar's own, on a private socket, so none of it disturbs the tmux you
  already run.
- **Colour identity.** Near-identical terminal windows are the fleet's usability problem, so every
  clone gets a hue that shows up in its Claude Code status line, its prompt border, and the
  terminal window itself.
- **A repair command.** `hangar doctor --fix` rebuilds everything that lives *outside* git and so
  cannot be restored by a pull: ports, identity files, hooks, symlinks, sibling remotes, themes.
- **Shared caches.** A Jira ticket fetched in one clone becomes available to all of them; finished
  plans are collected into one archive. Both happen from `SessionEnd` hooks, so it is not something
  to remember.
- **Two Claude Code modes at the hangar root** — one that drives the CLI, one that changes it.

## What every clone gets

Everything in this table is derived from the clone's index. Nothing has to be written down
anywhere, which is why adding or removing a clone needs no edit to any file. This hangar runs three
servers, so it has three roles — bases 4200, 6006 and 9323 at a step of 100, which puts `clone_02`
on 4300 / 6106 / 9423.

| Per clone         | How it is derived                                            |
| ----------------- | ------------------------------------------------------------ |
| a port per server | `base + (N-1) * step`, one entry per role in the config      |
| colour            | `PALETTE[N-1]` — overridable with `hangar colours change`    |
| `CLAUDE.local.md` | generated: names the clone, its colour and its three ports   |
| git remotes       | `origin`, plus every other clone as a remote (`clone_02`, …) |
| Claude Code theme | one generated theme file per clone                           |

Two consequences worth knowing up front:

- **A clone is addressed by its index.** `hangar status 2`, `hangar sync 3`, `hangar open 1`.
  `clone_02` and `02` work too.
- **The sibling remotes are for fetching and cherry-picking only.** Never push to a sibling: git's
  default protection only covers the branch that clone currently has checked out, and a push to any
  of its other branches silently rewrites history someone is about to return to.

## Requirements

`hangar setup` checks all of this for you and refuses to continue if something required is missing.

**Required:** `git`, `direnv`, `jq`, `yq`, `lsof`, and either `fnm` or `nvm` (to resolve the
`.nvmrc` Node version per directory — both are honoured, by direnv at the hangar root and by
`hangar install` inside a clone; fnm is preferred only because it is a real binary and answers
faster). On macOS, Homebrew as well — it is where the GNU userland and every install hint come
from. Node 24 (`.nvmrc`), and `pnpm`, which direnv activates for you.

`lsof` is the one that looks optional and is not: it is how a running process is attributed to a
clone at all — a live Claude Code session by its working directory, a dev server by its listening
port. Without it `hangar sync --all` stops skipping busy clones and `hangar remove-clone` loses
both of its liveness guards, and each of those failures looks exactly like "nothing is running".

**Node is a requirement of the tool, not of your repository.** Hangar is a TypeScript program that
Node runs directly, so Node 24, direnv and fnm have to be on the machine whatever the repo you
point it at is written in — SQL, Go, Ruby, anything. What your clones need in order to build is a
separate question, and one you answer in the config (`repo.install[]`) rather than here.

`hangar setup` reports the pinned Node version rather than merely that `node` exists: the CLI runs
under whatever Node comes first on PATH, and a shell where direnv has not loaded is the wrong one.

**Recommended:** `ripgrep`, `ripgrep-all`, `tree`, `git-lfs`, `git-extras`, `git-filter-repo`.

**Platform:** macOS is the platform this has actually been run on. What builds a clone's windows
is tmux on a private socket — the same program on Linux, and what carries a `SYNC PAUSE` into a
live session — so the only thing that differs between the two platforms is which emulator hosts
the window. The iTerm2 and Terminal.app window-openers are exercised here; the Konsole and GNOME
Terminal ones are written from documentation and have not been run against live terminals, and
GNOME Terminal cannot bring a window it opened to the front. VS Code is the only editor that
is exercised; the other eight kinds are best effort. `hangar doctor` prints a platform row and a
session-detection row on every OS — read those first.

## Getting a hangar onto your machine

### 1. Get the hangar repo

The hangar root is itself a small git repo — branch `main` — tracking the CLI, the fleet map, the
shell helpers and the config example. The clones, the secrets and `node_modules` are gitignored, so
what you copy is small.

```bash
git clone git@github.com:casaper/hangar.git ~/code/my_fleet
```

That is the published remote. If you cannot reach it — it is a personal account rather than an
org one, so access is not automatic — copy the repo from any hangar you can reach instead:

```bash
git clone /path/to/existing/hangar ~/code/my_fleet     # over a filesystem or ssh path
# or, with no reachable path at all:
git -C /path/to/existing/hangar bundle create /tmp/hangar.bundle --all
git clone /tmp/hangar.bundle ~/code/my_fleet
```

`hangar.config.yaml` is **not** in that repo — it names one machine's paths, ports and token
variables, so it is gitignored. `hangar.config.example.yaml` is the committed record of it and is
kept a faithful superset, which is also the fastest recovery from a lost config
(`cp hangar.config.example.yaml hangar.config.yaml`).

### 2. `direnv allow`

```bash
cd ~/code/my_fleet
direnv allow
```

**This is the step everything else depends on.** The hangar's `.envrc` is the only thing that puts
its own `bin/` on PATH, activates the pinned Node and pnpm, and puts `tsc`/`eslint`/`prettier`
within reach. There is deliberately no global install: the `hangar` on your PATH is always the one
belonging to the hangar you are standing in, so several hangars can coexist. If `hangar` is "command
not found", direnv has not loaded.

Install the CLI's dependencies once:

```bash
cd app && pnpm install --frozen-lockfile && cd ..
```

There is no build step — Node strips the TypeScript and runs `app/src/cli.ts` directly. `pnpm`
itself comes from corepack, which ships with Node; direnv installs the shim into the gitignored
`.hangar/` on its first load, so a fresh clone needs nothing extra.

Skip either of those two steps and `hangar` says so — which of the two, and the command to fix it —
rather than failing with a Node stack trace. The one exception is `hangar jira hook`, which stays
silent and exits zero even unbootstrapped: it runs as a Claude Code `PreToolUse` hook, where a
non-zero exit would block the tool call it was only meant to observe.

### 3. The config: copy it, or answer for it

**Joining a fleet for a repo somebody has already configured? Copy the example and stop.**

```bash
cp hangar.config.example.yaml hangar.config.yaml
hangar config validate
```

`hangar.config.example.yaml` is committed and is kept a faithful superset of the live file, so
for the repo it was written against it is already the complete, correct answer — including the
things `setup` cannot observe and therefore leaves out: the symlinks a clone needs, the command
that reports the repo's ports, the tracker's cache scripts. Change `id` only if another hangar on
your machine already uses it. `hangar config validate` compares the two files whenever they share
an `id` and reports any line that has drifted, which is what keeps the copy trustworthy.

**Setting up a hangar for a repo nobody has configured yet?** Then `setup` is the way in, and the
rest of this section is about it.

```bash
hangar setup                                   # interactive
hangar setup -n                                # print what it would write, and stop
hangar setup --preset sql-postgrest             # start from a preset
hangar setup -y --origin git@host:acme/repo.git # unattended
hangar setup --force                           # rewrite an existing config
```

Three jobs, in this order: prove the machine has the tooling, then write `hangar.config.yaml` and
`hangar.schema.json`, then create the secrets file it names (mode 600, every variable commented
out — filling it in is your one manual step). It is re-runnable against a hangar that already has
clones and running servers, so every question arrives with an answer already derived from disk.

**What it derives, it derives from an existing clone — so on a fresh machine it derives nothing.**
That is not a defect but it is worth knowing before you read the result: in an empty directory
`appDir`, the port roles, the install steps, the symlinks and the VS Code path keys all come out
empty or absent, because there is no checkout to read them off. Either fill them in by hand
against `hangar.config.example.yaml`, or add your first clone and use that as the reference. Do
not reach for `setup --force` to re-derive: it rewrites the live config, hand edits included.

**It writes only what it could observe in your repository, or was told.** `appDir`, the package
manager, the directories that get a direnv file, the default branch, the issue-key prefix and the
VS Code settings holding absolute paths are all read off an existing clone. Anything it could not
observe — the symlinks a clone needs, the command that reports your repo's ports, the tracker host
— is **left out**, with a comment saying what the key would do. An absent key is a hangar that
does one less thing; a guessed one is a hangar that checks the wrong port or links the wrong file.

Two answers no checkout can supply are what the `--preset` flag is for: the **port roles** (what
your repo runs, on which port, under which environment variable) and the **per-clone environment
variables** beyond the ports. A preset is a template that writes plain config and is never read
again — `profile:` in the result is a label, and no code consults it.

| Preset          | What it declares                                                        |
| --------------- | ----------------------------------------------------------------------- |
| `generic`       | no ports, no per-clone variables — declare what you need afterwards      |
| `node-web`      | one dev server on 3000, with a health check                              |
| `sql-postgrest` | PostgREST on 3000 and Postgres on 5432, plus `PGDATABASE` and `COMPOSE_PROJECT_NAME` per clone |

`--origin <url>` is what makes `-y` work in a fresh checkout: it is the one field with no
derivable default, so with neither the flag nor a terminal to ask on, setup refuses and names the
flag. It asks for:

| Question              | What it is                                                          |
| --------------------- | ------------------------------------------------------------------- |
| hangar id             | 2–24 chars, `[a-z0-9_]`, starts with a letter. Namespaces everything the hangar writes outside its own root — no dashes, because `-` separates the parts of those generated names |
| display name          | how the hangar is titled in output                                   |
| git origin URL        | what `add-clone` clones from. The one field with no sensible default |
| default branch        | leave it blank and the first command that needs it detects it and writes the line for you. Undetectable means abort, never `master` |
| app subdirectory      | `''` if your repo is buildable at its root                           |
| package manager       | for the install step in a new clone                                  |
| issue tracker base URL + key prefix | ticket links and the shared ticket cache. Blank switches it off |
| port offset           | `0` keeps the ports the existing clones are already serving on       |
| preset                | the port roles and per-clone variables — the two answers nothing can derive |

Then:

```bash
hangar config validate    # every problem at once, not just the first
hangar config show        # the same file with every default applied
```

`hangar.config.yaml` is the **marker file**: its presence is what makes a directory a hangar, and
every command except `setup` and `jira hook` refuses to run without it. Existence is checked, not
validity — so `config validate` and `doctor` can still tell you what is wrong with a broken one.

### 4. Point it at your repository

`hangar.config.example.yaml` documents every key, every alternative and the reason each one exists;
it is worth reading once, straight through. The groups that matter when you are adapting it:

| Group      | What you will change                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| `clones`   | directory `prefix` and index `pad`                                                |
| `forge`    | `kind` (`bitbucketCloud` or `none`), `originUrl`, `defaultBranch`, `tokenEnvKey`  |
| `tracker`  | `kind` (`jira` or `none`), `baseUrl`, key prefixes, cache scripts                 |
| `repo`     | `appDir`, which directories get a direnv file, the clone's own env file, symlinks it needs, the install step, the command that reports its ports |
| `ports`    | `step`, `offset`, and one `roles` entry per server your repo runs                 |
| `terminal` | which tmux windows `hangar open` creates per clone, where each starts, and which emulator hosts them |
| `editor`   | `kinds` (a list — a clone can be open in several at once), workspace file naming, and `rootPathKeys` for the VS Code settings that take an absolute path into the checkout |
| `secrets`  | the shared secrets file and its mode                                              |

Two rules the schema enforces, so that a mistake is loud rather than silent: **every object is
strict** — an unknown key is an error, because `orgin_url` would otherwise leave the hangar cloning
nothing and say so nowhere; and **you cannot uncomment two alternatives** — the cross-field checks
reject two port roles whose clones would collide, an install step naming both a manager and a
command, `rootPathKeys` with no editor that reads them, and a tracker with no base URL.

Keep a value that pins state already on disk or already running (clone directory names, port
arithmetic under live servers) even when it equals the default — a future change to a default must
not move them. Delete anything that only configures a feature you do not use.

#### If you do not use VS Code

VS Code is the default and the only kind that is exercised, but `editor.kinds` is a list and
`hangar open` opens every entry in it. Two shapes work, and the difference matters:

```yaml
editor:
  kinds: ['vscode', 'jetbrains']   # both — nothing else to change
  kinds: ['jetbrains']             # JetBrains only — then also DELETE `rootPathKeys`
```

**Dropping the VS Code family means deleting `editor.rootPathKeys`.** Only that family resolves a
settings path against nothing and so needs one rewritten per clone; JetBrains has `$PROJECT_DIR$`
and Zed resolves from the project root. Leaving the table behind is a hard validation error, not a
no-op — deliberately, because silently ignoring it is the same bug — and it fails in the gate every
command runs, so nothing works until it goes. `hangar doctor` still runs and still says what is
wrong. The three `workspace*` keys are then inert too, and can go with it.

**JetBrains, specifically.** `editor.jetbrains.product` picks the IDE (`idea` is the default, and
is IntelliJ IDEA). Hangar finds it by its launcher on PATH, so in **JetBrains Toolbox enable
"Generate shell scripts"** — failing that it asks macOS for the application by name, and
`editor.jetbrains.launcher` names one explicitly. `hangar doctor` prints which of those answered.

**Hangar never creates `.idea/` — the IDE does.** Open a clone in it once and the directory
appears; from then on `hangar ide jetbrains sync` keeps the nine shareable files identical across
the fleet (code styles, inspections, linters, `modules.xml`, `vcs.xml`) and never touches
`workspace.xml`, which is per-user window state. Run before any clone has been opened, it says so
rather than inventing files.

### 5. The first clone, and every one after

```bash
hangar add-clone              # creates the next free index and wires it in completely
hangar add-clone --no-install # skip repo.install[]; it prints the steps it skipped
hangar install 2 -n           # what the install steps would run, without running them
hangar install 2              # run them
```

`add-clone` clones the repo, writes the ports, the identity file and its git exclusion, the direnv
files, the symlinks, the Claude Code settings and hooks, the theme, the sibling remotes in both
directions, and the local git config the sibling remotes make necessary — the list is exhaustive on
purpose, because every item on it lives outside git and nothing else would recreate it.

Then it runs `repo.install[]`. Those steps are the only thing Hangar runs inside a clone that can
destroy work — `npm ci` deletes `node_modules` before refetching it — so `hangar doctor` never runs
one. It checks the declaration instead (does the directory exist, is the manager's marker there)
and names `hangar install` when something is missing. A manager that installs into a cache outside
the clone — maven, go, cargo, pip, poetry — gets a dim *cannot verify* row rather than a red one,
because there is genuinely nothing per-clone to look at.

**The first clone is no different from the rest.** `add-clone` prefers an existing sibling's
`.claude/settings.local.json` as its template — a new clone should inherit the MCP servers and
editor keys a developer has enabled, and no generator can invent those — but with no sibling it
derives what a hangar can: the read allow for the hangar root, the deny for the secrets file, one
health-check permission per port role that declares one, the three hooks, the statusline, the
shared memory directory and the theme. Then finish with:

```bash
hangar doctor --all --fix
```

### How far the genericisation goes

The config surface above describes the whole tool, and all of it is wired: ports, port roles and
their env keys, the per-hangar port offset, clone directory naming, the per-clone dotenv and its
extra variables, symlinks, the secrets file **and the variables a repo needs out of it**, the
install steps (any of fourteen package managers or an explicit command, in any directory, Node or
not, under either version manager), workspace naming and directories, VS Code's per-clone path keys
in both directions, theme and statusline naming, the forge and tracker identity, the first clone of
a fresh hangar, the tracker's two cache scripts with their TTL and the env var that bypasses them,
and which hangar a command acts on (`--hangar`, then the walk up from your working directory, then
`HANGAR_ROOT`). The VS Code window-state path, `open -a` and the install hints go through a
platform seam with a `darwin` and a `linux` implementation.

**What a config key cannot move is the argv contract.** `tracker.syncScript` and
`tracker.namerScript` name your own scripts, and Hangar calls them with the arguments the cache
hook expects — so honouring the key is the tool's half, and matching that contract is the script's.
`tracker.cache.bypassEnvKey` is set in front of the command rather than passed as a flag, because
a repo's own sync script tends to die on an unknown one.

**Two Linux details are unverified, and both are reported rather than assumed.**

- **Whether `ps` under procps names a Claude Code process `claude`.** Everything the fleet does
  about live sessions rests on it — the busy-clone skip, and delivering a `SYNC PAUSE` before a
  rebase — and if the answer is `node`, a Linux hangar finds zero sessions and says nothing,
  because zero sessions is also what an idle machine looks like. So `hangar doctor` prints a
  `claude sessions` row saying how many processes it looked at, how many matched, and when none
  did, which command names mention `claude` anyway. Your first `doctor` answers this in a line;
  please report what it says.
- **The Konsole and GNOME Terminal window-openers have never run against a live terminal.** They
  are written from Konsole's documented D-Bus interface and gnome-terminal's documented command
  line, and each is one command line plus, for Konsole, a D-Bus call to bring a window forward.
  Everything inside the window is tmux, which is the same program here and was exercised here — so
  what is unverified on Linux is which emulator comes up, not what happens in it. GNOME Terminal
  cannot bring a window it opened to the front, and `doctor` says so by name rather than leaving a
  capability quietly false.

### What `doctor` checks about the hangar itself

The per-clone rows are the visible half. These are the hangar-level ones, and the reason they
exist is that `hangar setup` is not the only way in: the fastest route for somebody joining a
configured fleet is to copy the example config and stop, which routes around `setup` entirely.

- **The shared secrets file.** `doctor` reports its absence and `--fix` creates the commented-out
  scaffold. Clones load it with `dotenv_if_exists`, so an absent one loads nothing and says
  nothing — which is why nothing else would tell you.
- **All four credentials this fleet uses.** The forge token and the Atlassian pair are derived
  from `forge` and `tracker` rather than waiting to be declared, and `forge.tokenEnvKey` is
  honoured by the adapter that reads the token.
- **The machine's tooling**, one green line or a named list. Its Homebrew probe asks
  `brew --prefix` last and only when `/opt/homebrew` is absent, so an Intel Mac — where
  `brew shellenv` is not in the install instructions and `HOMEBREW_PREFIX` is therefore unset — is
  read correctly rather than told it has no Homebrew. `.envrc.hangar` resolves it the same three
  ways in the same order, deliberately.
- **The whole derived half of each clone's `.claude/settings.local.json`.** The builder overlays
  all of it and keeps the personal keys — a wholesale rewrite would delete a developer's MCP
  servers to fix a theme — and `doctor` compares all of it. That matters most when a hangar is
  renamed or moved, where a partial check cannot help: the `settings targets` row asks only
  whether the named path exists, and an existence check cannot notice a rename it is standing in
  the middle of.
- **VS Code path keys declared for a file no clone has.** `.vscode/settings.json` is untracked, so
  a fresh fleet has none of it and `ide vscode sync` has nothing to seed from — leaving the keys
  correctly declared and completely inert, with every symptom appearing inside the editor. Nothing
  generates that file: its contents are yours.
- **A hook matcher naming a binary or a root that is not there.** A hook is recognised as this
  hangar's by the shape `<root>/bin/<binary> --hangar <path> <subcommand>` — the hangar's own
  `bin/` plus the subcommand, not the exact current command string — so renaming the binary or
  moving the root replaces the matcher instead of appending a second one beside it. Two
  `SessionEnd` collectors is untidy; two `PreToolUse` Jira hooks, one of them a dead path, can
  block every Bash call in that clone, and the Jira hook fails open, so it would never say a word.
- **The terminal-hook row, on the resolved absolute path.** `clone-terminal.sh` is the same
  filename in every hangar, so a basename match would let a second hangar report the hook sourced
  on the strength of the first one's line in `.zshrc` while its own colours did nothing.
- **A symlink is judged on where it points**, not on whether `realpathSync` resolves — it throws
  on a link whose target does not exist yet, which is the normal state of the secrets link before
  the file is created. And one failed repair does not end the run, so a later clone's ports,
  hooks, remotes and theme are still visited.

**`doctor`'s summary counts both halves** — the hangar's own state and the clones' — and says
which is which. The exit code is 0 either way: in this CLI a `--check` flag is the gate and a
report is a report, so read the summary line, never `$?`.

### What `doctor` cannot check, so it is written down here

- **Which kind of Bitbucket credential the token has to be.** Bearer auth means an access token;
  an App Password is Basic-only and 401s — see *Secrets* above. Nothing can tell the two apart
  from the value, so this is written down rather than discovered at the first `sync`.
- **The two `.claude/modes/*.settings.json` files need a hand edit.** They carry operator mode's
  permission list, which is its security boundary — generating them would let a command operator
  mode is allowed to run (`doctor --fix`) rewrite the list that constrains it. So `doctor` reports
  a stale `statusLine.command`, prints the exact shell line that fixes it, and does not repair it.
  **Expect that edit to stay in `git status` and to conflict on a pull** — they are tracked files
  a hangar command must never write, so there is no version of this that is free.
  `hangar-internals/reference/modes.md` has the three alternatives that were considered and why
  each is worse.
- **Whether the example config still agrees with the live one.** That one is checked, but by
  `hangar config validate` rather than `doctor`, and only while the two files share an `id` —
  which means changing the `id` for a second hangar on the machine is also the moment the check
  goes quiet. It holds `forge.defaultBranch` in particular: an example pointing at a branch the
  repo does not have aims `checkout-default`, `open`'s fast-forward and `sync`'s fallback at
  nothing.

The repository is yours rather than this hangar's. `CLAUDE.md` is generic and the machine-specific
half is a generated, gitignored `CLAUDE.local.md` beside it; `.claude/settings.json` is generated
by `hangar setup` and repaired by `doctor`; `colour-assignments.json` lives in the gitignored
`.hangar/`, with a fallback read of the old root-level path so a `git pull` cannot lose your
assignments.

## Starting Claude Code in operator mode

```bash
hangar-ops                      # start a session in operator mode
hangar-ops --resume <id>        # resume one, keeping the mode
```

That is it — no arguments, from anywhere in the hangar. `hangar-ops` is a small script in `bin/`,
which direnv has already put on your PATH.

**Operator mode is for driving the fleet.** The session runs `hangar` on your behalf and reads its
output: what the clones are doing, why `doctor` is red, syncing a clone, opening a window,
recolouring one. It loads the `hangar-ops` skill, which is the full command surface — so it looks
flags up rather than recalling them.

**What it cannot do is change the CLI.** Writes to `app/**`, `.claude/skills/**` and
`.claude/modes/**` are denied by that session's permission rules — including the file holding its own
instructions, so it cannot rewrite its own remit. Reading all of them is allowed and is usually the
right answer. If a task genuinely needs the CLI changed, it will name the file and stop.

Three things about how a mode works, because they are not obvious:

- **A mode is three launch flags** — `--settings`, `--append-system-prompt-file` and a session name
  — and Claude Code reads all three **once, at startup**. So neither you nor the session can switch
  modes without restarting. That is the point of it, not a limitation.
- **`hangar-ops --resume <id>` resumes *into* operator mode.** A bare `claude --resume` of the same
  session comes back with none of its rules.
- **The window is badged.** The status line is built to show a blue `OPS`, an amber `DEV`, or a red
  `NO MODE` for a session launched as a plain `claude` — which is the tell that a resumed session
  lost its rules. This part is newly added and not yet confirmed by eye; see **Troubleshooting**.

The commands that move git state or files between live working trees — `sync`, `checkout-default`,
`open`, `add-clone`, `remove-clone`, `colours change`, `doctor --fix` — stay yours by default. An
operator session runs the dry run, reports it, and hands you a copy-pasteable line; tell it to go
ahead and it will run them.

## Developer mode, and what it is for

```bash
hangar-dev
```

**Developer mode is for changing the `hangar` CLI itself** — the TypeScript in `app/src/**`, the
config schema, the generated artifacts, the skills, and the operator mode's own instructions. It
starts with its working directory in `app/`, so `app/CLAUDE.md` — the package layout, the two
conventions the code follows, the code map and the four extension seams — is loaded from the first
turn instead of lazily.

Use it when the answer to a question is "the CLI needs to do something different", and operator mode
when the answer is "run the CLI". The split is enforced rather than suggested: **developer mode is
the only one that can improve operator mode's instructions**, because operator mode is denied writes
to them. That asymmetry is why there are two modes rather than one.

After any change, from `app/`:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
hangar config schema --check     # only if you touched config/schema.ts
pnpm golden && git diff --exit-code dev/golden/gated
```

**That last line is expected to produce no diff, in your hangar as much as in the one it was
recorded in.** Everything under `dev/golden/gated/` is rendered from two checked-in fixture
configs in temp directories, with `%HANGAR%`/`%HOME%` normalised away, so a diff on your first
run is a finding rather than a formality. The capture of this hangar's own tree runs too, into
the gitignored `dev/golden/advisory/`, where it is worth reading and never diffed — a capture of
one developer's machine inside the gate would open everybody else's first run with a 120-file
diff that looks like a broken tool.

The one thing that legitimately differs is the **platform**: each fixture's `manifest.txt`
carries the platform driver's own answers — the kind and application-support directory, the
capability flags, and the VS Code window-state path — recorded here on macOS. A Linux run diffs
those rows and nothing else. They are captured rather than normalised away on purpose — every platform difference in this CLI was invisible until it was published for someone
else to run, and this is the line that shows one. `dev/golden/README.md` has the rest, including
why there are two fixtures rather than one.

**Commit messages are Conventional Commits, and a hook enforces it.** `type(scope): subject` —
`fix(editor): Let a hangar whose editor is not VS Code actually be one`. The subject keeps the
house style; the body keeps doing the work it always did. Install the hook once per clone of this
repo:

```bash
pnpm hooks
```

It is a manual step and cannot be otherwise — `pnpm-workspace.yaml` sets `ignoreScripts: true`, so
husky's `prepare` never runs on install. Until you run it, the only thing checking your message is
the `commitlint` job in CI, after the push. That matters more than tidiness: semantic-release reads
these types on `main` to pick the next version and write `CHANGELOG.md`, so a wrong type is a wrong
release. `app/CLAUDE.md`'s **Commit messages** section has the vocabularies and the three
commitlint rules this repo's own history forced.

**The test suite is a seed, not a safety net**, and knowing what it does and does not cover is the
point of saying so. `app/test/` holds the things a capture structurally cannot express — two
hangars rendered in ONE process (the golden capture runs the binary once per hangar, so a cache keyed on
nothing passes it every time), what happens to input that is wrong rather than to input that is
right, and that `pathsFor` is frozen and pure. It asserts properties, never whole expected text:
byte-exactness belongs to `pnpm golden`, and a second copy of it here would be a second oracle to
update on every prose edit.

Two older conventions carry the rest, and both exist because they caught a real bug: anything that
produces text for a human or an agent gets a pure, exported builder so every variant can be printed
side by side; and state is derived at the moment it is reported rather than carried in a flag that
can go stale. `.claude/skills/hangar-internals` records why each command is built the way it is —
those "this exists because it caught something" notes are the only surviving record of the bugs
they prevent.

## Using the CLI by hand

No agent required. From the hangar root, or from inside any clone.

### Look before you touch

These only report. They are the right first move, and they are safe at any time:

```bash
hangar list                 # every clone, its branch, its last commit
hangar ports                # the whole port map, and any env file that disagrees with it
hangar ports --json
hangar status 2             # branch, sync vs origin, ticket, PR, ports, servers, sessions
hangar status --all
hangar status 2 --fetch     # fetch first, so the "behind by N" answer is authoritative
hangar doctor               # what is broken, changing nothing
hangar doctor --all
hangar colours list         # the palette, painted, and which clone holds each hue
hangar config show
hangar config validate
```

### The commands that act

Most of these take `-n` / `--dry-run`, and running it first is the habit — it prints every decision
the real run would make. The three that have no dry run are `add-clone`, `remove-clone` and
`colours change`; each asks before it acts instead. `open` has one, and it is worth running,
because it moves a branch in every clone it touches.

```bash
hangar sync 2 -n            # resolved target branch and chosen strategy, no changes
hangar sync 2
hangar sync --all           # skips clones with a live Claude session
hangar sync --all --include-busy
hangar sync 2 --onto release9      # skip the pull-request lookup
hangar sync 2 --strategy merge     # or rebase
hangar merge-default 2      # same command; the NAME picks the default strategy
hangar rebase-default 2

hangar checkout-default 2   # fetch, check out the repo's default branch, fast-forward it
hangar checkout 2           # alias

hangar open 1 -n            # the branch, windows and editors it would touch, changing nothing
hangar open 1               # a tab attached to this clone's tmux session, plus its editor
hangar open --all
hangar open 2 -b feature/x  # check out this branch instead of the default one
hangar open 2 --no-checkout --no-claude --no-editor

hangar add-clone
hangar remove-clone 4                 # detach it from the fleet, keep the directory
hangar remove-clone 4 --delete        # also delete it (guarded)

hangar doctor --all --fix   # repair everything derivable from the clone index
hangar colours change 2 teal
hangar colours sync         # regenerate the palette-derived artifacts (-n, --check)
hangar ide vscode sync      # one editor setup across the fleet, per-clone paths still per clone
hangar tmp merge            # pool the clones' shared cache
hangar plans collect        # gather finished plans into plans/
```

**Three traps in that list.** `hangar resume`'s `-n` is `--limit`, not `--dry-run` — the one place
in this CLI where `-n` does not mean "change nothing". `hangar sync <clone>` starts with a
`git stash push --include-untracked`, and the busy-clone skip applies only to `--all`, so naming a
clone explicitly does not protect it. And `remove-clone --delete --force` deletes despite the
guards, which means uncommitted work in that clone is gone.

`hangar sync` and its conflict resolver take **one to three minutes** and stream a dim line per
step. Let it run; killing it leaves a rebase stopped mid-pick.

### Resuming a session

```bash
hangar resume 2             # pick from all of clone_02's past sessions
hangar resume 2 -n 50       # list 50 instead of 20 (0 = all)
```

Claude Code's own `--resume` list is scoped to the directory the session started in, so a session
started in a subdirectory of a clone is invisible from the clone root. This picker reads every
transcript directory the clone owns, shows each session's title and what it was asked first and
last, and marks a clone that already has a live session — resuming into that would put two Claude
Code sessions in one clone.

### Anything else

```bash
hangar --help
hangar <command> --help     # every alias a command answers to is listed
```

## `hangar doctor`

Its own section because it is the command you will reach for most.

`doctor` is the regression net for **everything that lives outside git and so cannot be restored by
a pull**: the ports in each clone's env file, the identity file and its git exclusion, the direnv
private file, the test symlink, the theme, the Claude Code hooks, that `tmp/` is the clone's own
directory, the sibling remotes in both directions, and the git config those remotes require.

It compares generated files **by content, not by presence** — an existence check is a check that
lets the content rot. `--fix` repairs everything derivable from the clone index. Run it after any
re-clone: a fresh clone loses its identity file *and* the exclusion that hid it, and without both
the file eventually gets committed into every branch.

One thing a green report does **not** tell you: what the currently open sessions are running. Claude
Code reads its settings and hooks once at startup, so a hook `doctor --fix` just wired in reaches
that clone at its *next* session.

## Secrets

**Every credential lives in exactly one file:** `.env.shared` at the hangar root, mode 600. It sits
*outside* every clone, which is the design: no clone can commit what is not inside it.

Each clone reaches it through its own untracked direnv file, which holds no variables at all and
only loads the shared one — layered *before* the clone's own values, so a clone can still override
anything locally. Nothing is duplicated per clone, so rotating a token is one edit.

The config never holds a token, only the **name of the variable** that does (`forge.tokenEnvKey`).
The config example is committed; the secrets file is not.

**Which KIND of credential is a thing `doctor` structurally cannot check, so it is written down
instead of discovered.** The bitbucketCloud adapter sends `Authorization: Bearer <token>`, so the
variable named by `forge.tokenEnvKey` has to hold a Bitbucket **access token** — repository,
project or workspace scoped, with at least `pullrequest:read`, made under that repository's or
workspace's *Security → Access tokens*. An **App Password** is Basic auth only and 401s under
Bearer, and it is the more familiar Bitbucket credential, which is what makes it the likely
mistake. A Jira `ATLASSIAN_API_TOKEN` is made at
`id.atlassian.com/manage-profile/security/api-tokens` and pairs with `ATLASSIAN_USER_EMAIL`; the
Jira half is read by your repo's own sync script rather than by Hangar. `doctor` reports set /
empty / absent and never calls either API — so the wrong kind of token reads as configured right
up until the first `sync`, which is also the moment it has just stashed your tree. `sync` does
print the status it got back, so the answer is in that run rather than nowhere.

**Hangar's own credentials come free; declare what your REPO needs.** The forge token named by
`forge.tokenEnvKey` and the Atlassian pair follow from `forge` and `tracker`, so `doctor` derives
a row for each without being told — asking you to restate your own config was the gap that let
this fleet's own `doctor` stay silent about three of the four credentials it uses. Everything your
own tooling reads is invisible from up here, and an undeclared credential fails in the worst
available way:

```yaml
secrets:
  variables:
    - name: USER_READWRITE_PASSWORD
      why: the tracked tests/.env sets it empty; Playwright logs in with no password without it
      optional: false # true renders doctor's row dim rather than red
```

`hangar doctor` then prints a row per expected variable — derived and declared alike — and tells
**absent** apart from the worse **set but empty**, which reads as configured to everything
downstream. A declared entry with the same name overrides the derived one, which is how you make
a forge token red rather than dim. It never repairs a credential — that is the one thing in the
fleet that cannot be derived from a clone index, which is exactly why it is worth a row of its
own. The `why` is required, for the same reason `repo.symlinks[].why` is: a variable name explains
what breaks without it no better than a symlink does.

**The FILE, unlike its contents, `doctor --fix` does create** — mode 600, with every line
commented out, exactly as `setup` writes it. That matters because copying the example config never
runs `setup`, which was the only thing that had ever created it: each clone loads the file with
`dotenv_if_exists`, so an absent one loads nothing and reports nothing.

This is the gap that swallows a new hangar whole, and it is why `doctor` checks the VARIABLES a
repo needs and not just the file. The Playwright symlink above exists *because* the tracked test
`.env` blanks that password — its `why` says so — but a link to a shared file that does not name
the variable creates itself happily: the symlink is correct, the file is there, and the suite logs
in with an empty password.

## The two shared directories

**`plans/`** — the plan archive. Claude Code requires its plans directory to resolve inside the
project root, so each clone writes to its own and `hangar plans collect` moves finished plans here,
collapsing identical copies and putting each plan's date in front of its name. Every clone runs it
from a `SessionEnd` hook: a plan stays in its own clone while its session is alive — which is the
guarantee, not a delay — and moves the moment nothing can rewrite it.

**`tmp/`** — the shared ticket cache and per-clone scratch. Each clone keeps its own real `tmp/`
directory, and what is shared is linked into it **one entry at a time**. That level matters: `tmp/`
also holds dev-server PID files, and a wholly shared `tmp/` would let the first clone to start a
server block the others and let a kill reach into a sibling. `hangar tmp merge` (also a `SessionEnd`
hook) pools the rest, is idempotent, and **never overwrites** — anything that differs is kept beside
the winner as `<name>.from-clone_NN`, so you run it again rather than forcing it.

**Never hand-edit a file under `tmp/`.** Each cached ticket is a symlink into one record store the
whole fleet shares, so an in-place edit writes every clone's copy of it, and nothing inside the
clone shows you that.

## Colours

Every clone has a hue, and it is not decoration — it is how you tell near-identical terminal windows
apart. The hues are data in `app/src/palette.ts`; everything else is derived from them (the shimmer
is the hue 40% toward white, the border is the hue times 0.8, and so on).

```bash
hangar colours list
hangar colours change 2 teal    # --force to reuse a hue a sibling already has
hangar colours sync             # rebuild the generated artifacts; -n or --check to look first
```

The generated files — one status line script shared by all clones, one theme per clone, and the two
shell helpers at the hangar root that colour the terminal itself — **must never be hand-edited**;
`colours change` is the only way to change a hue and it rebuilds everything that names it. A theme
change needs a Claude Code restart in that clone to show up.

For the terminal window colour, source the generated hook from your shell profile:

```bash
echo 'source ~/code/my_fleet/clone-terminal.sh' >> ~/.zshrc
```

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `hangar: command not found`                                    | direnv has not loaded. `direnv allow` at the hangar root. Same answer for a missing `tsc`, `eslint`, `prettier` or `pnpm`. |
| `no hangar.config.yaml … so this is not a hangar`              | `hangar setup`, or `cp hangar.config.example.yaml hangar.config.yaml`                                                |
| Every clone reports ports 4200 / 6006 / 9323                   | You ran the repo's own port script from the hangar root, where the clone's env file is never loaded. It does not error, it answers wrong — the tell is a `(default)` marker. Use `hangar ports`. |
| A red `NO MODE` badge in a window you started with `hangar-ops` | Either the session was resumed with a bare `claude --resume` (which drops the mode), or the badge wiring is at fault — see below. |
| `git checkout <branch>` refuses, "matched multiple remote tracking branches" | The sibling remotes all have that branch. `hangar doctor --fix` restores the `checkout.defaultRemote=origin` that resolves it. |
| `hangar sync` refuses to start                                 | The clone is mid-rebase or mid-merge. Finish or abort that first — step one is a stash, and it would bury the half-applied state. |
| An editor never opens                                          | `hangar doctor` prints a row per configured editor with whether it can actually be launched. A `code` command that was never installed into PATH means `hangar open` silently opens no editor. |
| `hangar open` opened a window where you asked for a tab (Terminal.app) | A Terminal.app TAB can only be made by sending Cmd-T through System Events, which needs Accessibility permission for the terminal you ran `hangar` from. `open` checks the tab count actually grew, falls back to a window, and says what to allow. |
| `hangar open` opened a window but it is not in front | GNOME Terminal cannot raise a window it opened. The window is there — `tmux -L hangar-<id> attach -t '=<clone>:'` from any shell, or `tmux -L hangar-<id> ls` to see the fleet's sessions. |

**Known gap, stated plainly:** the mode badge is new. It takes the mode from three independent
channels — the status line's own arguments, an environment variable set only by the launcher, and
otherwise the red fallback — precisely because none of them could be verified from outside a live
session, and **it has not yet been confirmed by eye in a freshly launched window.** Any one channel
working shows the right badge; all three failing shows the red warning rather than a confident wrong
answer. If `hangar-ops` gives you `NO MODE`, that is the bug.

## Where the rest is written down

| Read this                                    | For                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `CLAUDE.md` (hangar root)                    | the fleet map — who is who, the ports, how the clones exchange commits. Loaded into every session in every clone, which is why it is short |
| `app/CLAUDE.md`                              | changing the CLI: package layout, conventions, the code map, the five seams |
| `hangar.config.example.yaml`                 | every config key, every alternative, and why each exists                  |
| `.claude/skills/hangar-ops/`                 | the full command surface — every flag and default                         |
| `.claude/skills/hangar-internals/`           | why each command is built the way it is. Six reference files, one subsystem each |
| each clone's own `CLAUDE.md` / `CLAUDE.local.md` | the application, and which clone you are in                            |

The hangar root deliberately says **nothing** about the application it clones. All project guidance
lives inside the clones, is tracked in git, and is versioned per branch — hoisting it up here would
stop it following the branch and silently go stale.
