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
  Claude Code session, so `sync` finds its terminal and types a `SYNC PAUSE` line into it, then
  exactly one `SYNC FINISHED` or `SYNC ABORTED`. An agent in that clone knows to stand still.
- **One window for the whole fleet.** `hangar open` puts every clone's tabs in a single terminal
  window, on a freshly fast-forwarded default branch, with the editor opened alongside — and reuses
  whatever is already open instead of starting a second session in a clone.
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

**Required:** `git`, `direnv`, `jq`, `yq`, and either `fnm` or `nvm` (to resolve the `.nvmrc` Node
version per directory). On macOS, Homebrew as well — it is where the GNU userland and every install
hint come from. Node 24 (`.nvmrc`), and `pnpm`, which direnv activates for you.

**Node is a requirement of the tool, not of your repository.** Hangar is a TypeScript program that
Node runs directly, so Node 24, direnv and fnm have to be on the machine whatever the repo you
point it at is written in — SQL, Go, Ruby, anything. What your clones need in order to build is a
separate question, and one you answer in the config (`repo.install[]`) rather than here.

`hangar setup` reports the pinned Node version rather than merely that `node` exists: the CLI runs
under whatever Node comes first on PATH, and a shell where direnv has not loaded is the wrong one.

**Recommended:** `ripgrep`, `ripgrep-all`, `tree`, `git-lfs`, `git-extras`, `git-filter-repo`.

**Platform:** macOS is the platform this has actually been run on. The Linux terminal drivers
(Konsole, GNOME Terminal) are written from documentation and have not been exercised against live
ones. VS Code is the only editor that is exercised; the other eight kinds are best effort.

## Getting a hangar onto your machine

### 1. Get the hangar repo

The hangar root is itself a small git repo — branch `main` — tracking the CLI, the fleet map, the
shell helpers and the config example. The clones, the secrets and `node_modules` are gitignored, so
what you copy is small.

**There is no published remote yet.** Copy it from wherever this one is reachable:

```bash
git clone /path/to/existing/hangar ~/code/my_fleet     # over a filesystem or ssh path
# or, to move it without a reachable path:
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

### 3. `hangar setup`

```bash
hangar setup          # interactive
hangar setup -y       # take every derived default
hangar setup -n       # print what it would write, and stop
hangar setup --force  # rewrite an existing config
```

Two jobs, in this order: prove the machine has the tooling, then write `hangar.config.yaml` and
`hangar.schema.json`. It is re-runnable against a hangar that already has clones and running
servers, so every question arrives with an answer already derived from disk. It asks for:

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
| `terminal` | which tabs `hangar open` creates per clone, and where each one starts             |
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

### 5. The first clone, and every one after

```bash
hangar add-clone              # creates the next free index and wires it in completely
hangar add-clone --no-install # skip the dependency install
```

`add-clone` clones the repo, writes the ports, the identity file and its git exclusion, the direnv
files, the symlinks, the Claude Code settings and hooks, the theme, the sibling remotes in both
directions, and the local git config the sibling remotes make necessary — the list is exhaustive on
purpose, because every item on it lives outside git and nothing else would recreate it.

**It cannot create the *first* clone**, though: it copies `.claude/settings.local.json` from an
existing sibling as its template, and a hangar with no clones has none. Clone the repo into
`clone_01/` by hand (or drop a settings file into place), then let `add-clone` do every one after
that, and finish with:

```bash
hangar doctor --all --fix
```

### How far the genericisation goes today

The config surface above describes the whole tool, and most of it is now wired. If you are
evaluating this for your own repository, these are the gaps that remain, in the order they will
bite:

1. **`hangar setup` cannot yet ask about your ports.** It writes a valid config, but with an empty
   `ports.roles: []` — because a role is a decision about your repo (what it runs, on which port,
   under which environment variable) and nothing in a checkout answers it. Add the roles by hand
   after setup, or wait for `setup` to learn the question.
2. **`add-clone` cannot bootstrap the *first* clone.** It copies an existing sibling's
   `.claude/settings.local.json` as its template and refuses when there is none, so clone #1 is
   still made by hand.
3. **The install step is hardcoded to `npm ci`.** `repo.install[]` declares any of fourteen package
   managers, or an explicit command, and `add-clone` still runs `npm ci` in the app directory. A
   repo with no `package.json` gets a failing step it never asked for.
4. **`profile:` names a `profiles/` directory that does not exist**, and now never will: the two
   hangars this tool is built for need no profile code, which was the evidence the config boundary
   was drawn in the right place. Treat the key as a label; it changes no behaviour.
5. **The forge and tracker identity is still four literals** in `app/src/paths.ts`, so
   `forge.originUrl` and `tracker.baseUrl` are read for some purposes and ignored for others.
   Notably `add-clone` falls back to this repo's origin URL when none is given.
6. **Linux is unexercised.** The VS Code window-state path is macOS-only, two generated scripts
   fall back to a Homebrew `jq`, every install hint says `brew install`, and the Konsole and GNOME
   Terminal drivers have never run against a live terminal. GNOME Terminal structurally cannot
   deliver a `SYNC PAUSE`.

What *is* wired, and worth knowing because the list above used to be longer: ports, port roles and
their env keys, the per-hangar port offset, clone directory naming, the per-clone dotenv and its
extra variables, symlinks, secrets file, workspace naming and directories, VS Code's per-clone path
keys, theme and statusline naming, and which hangar a command acts on (`--hangar`, then the walk up
from your working directory, then `HANGAR_ROOT`).

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
pnpm typecheck && pnpm lint && pnpm format:check
hangar config schema --check     # only if you touched config/schema.ts
```

The fleet has **no test suite**. Two conventions stand in for it, both of which exist because they
caught a real bug: anything that produces text for a human or an agent gets a pure, exported builder
so every variant can be printed side by side; and state is derived at the moment it is reported
rather than carried in a flag that can go stale. `.claude/skills/hangar-internals` records why each
command is built the way it is — those "this exists because it caught something" notes are the only
surviving record of the bugs they prevent.

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
`colours change`; each asks before it acts instead.

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

hangar open 1               # a terminal window with this clone's tabs, plus its editor
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

**Never hand-edit a file under `tmp/`.** Each cached ticket is normally a hard link to one file the
whole fleet shares, so an in-place edit can rewrite every clone's copy of it, and nothing inside the
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
| `hangar open` created no new tab (Terminal.app)                | Terminal.app needs Accessibility permission for the terminal you ran `hangar` from. `open` checks and says what to allow. |

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
| `app/CLAUDE.md`                              | changing the CLI: package layout, conventions, the code map, the four seams |
| `hangar.config.example.yaml`                 | every config key, every alternative, and why each exists                  |
| `.claude/skills/hangar-ops/`                 | the full command surface — every flag and default                         |
| `.claude/skills/hangar-internals/`           | why each command is built the way it is. Six reference files, one subsystem each |
| each clone's own `CLAUDE.md` / `CLAUDE.local.md` | the application, and which clone you are in                            |

The hangar root deliberately says **nothing** about the application it clones. All project guidance
lives inside the clones, is tracked in git, and is versioned per branch — hoisting it up here would
stop it following the branch and silently go stale.
