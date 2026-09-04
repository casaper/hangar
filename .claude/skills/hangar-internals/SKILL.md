---
name: hangar-internals
description: Design rationale for the hangar fleet CLI - the two config files and the no-config gate, why sync asks Bitbucket for a branch's PR target rather than guessing master, how tmp merge collapses a ticket's cached names onto one inode, what ide vscode sync rewrites per clone, doctor's checks, and the Jira hook's fail-open rules. Load before editing app/src or debugging a sync, tmp merge, plans collect, ide sync, colours or doctor run.
---

# `hangar` internals

This is the half of the fleet's `CLAUDE.md` that only matters when you are **changing or debugging
the CLI**, moved out because it was loaded into every clone session, which pays for it and can act
on almost none of it. The prohibitions stayed in `CLAUDE.md` — what a clone session must not run,
and what a `SYNC PAUSE` line means. What is here is why each command is built the way it is.

Every "this exists because it caught something" note is load-bearing: the fleet has no test suite,
so these paragraphs are the regression record.

## The `hangar` CLI

The fleet is orchestrated by one TypeScript commander CLI. The executable is `bin/hangar`; the
package it runs is `app/` (`app/src/**`, `app/package.json`, `app/node_modules`), kept out of
the fleet root for the ancestor reason above. The fleet root's tracked `.envrc` does
`PATH_add bin`, so inside the fleet root you just type `hangar`. **Every clone gets the same directory on PATH from its own
untracked `.envrc.private`**, so `hangar` also works from inside a clone — which is where you
usually are. There is no build step: Node strips the types and runs `src/cli.ts` directly.

Two conventions for changing it, both of which exist because they caught something:

- **There is no test suite, so anything that produces text for a human or an agent gets a PURE
  builder, given its facts and exported.** Every variant can then be printed side by side
  without constructing the state that produces it, which is how `sync`'s eight closing messages
  were checked — and it found two bugs reading the code had not: one froze an agent after a
  SUCCESSFUL sync, the other told it a branch had moved when nothing was integrated.
- **Derive state at the moment you report it; carry a flag only for what git cannot know.** A
  `restored` boolean set beside a `git stash pop` lies whenever the pop fails, which it can — it
  only warns. Ask `inProgressOperation`, `conflictedFiles`, `syncStashes` instead. Whether an
  integration got committed is the one thing git cannot answer, so that one is carried, and a
  carried flag needs guarding for the paths that do nothing (`up-to-date` integrates nothing).

| Command                           | What it does                                                          |
| --------------------------------- | --------------------------------------------------------------------- |
| `hangar list`                  | every clone, its branch and last commit                               |
| `hangar ports [--json]`        | the whole port map, and any `.env.local` that disagrees with it       |
| `hangar status <clone>\|--all` | branch, sync vs origin, Jira link, PR link, ports, servers, sessions  |
| `hangar sync <clone>\|--all`   | stash, fetch, rebase-or-merge onto its PR's target branch, restore    |
| `hangar {rebase,merge}-default` | strategy forced rather than chosen — otherwise the same command      |
| `hangar open <clone>\|--all`   | each clone's tabs in one terminal window + every configured editor    |
| `hangar resume [clone]`        | pick one of a clone's past Claude Code sessions and resume it         |
| `hangar add-clone`             | create the next clone and wire it in completely                       |
| `hangar remove-clone <clone>`  | detach it (`--delete` also removes the directory, guarded)            |
| `hangar doctor [--fix]`        | verify/repair every untracked per-clone artifact                      |
| `hangar plans collect`         | gather every clone's finished plans into the shared `plans/`          |
| `hangar plans stamp`           | date-prefix the plans in `plans/`, skipping any a live agent is using |
| `hangar tmp merge`             | pool every clone's `tmp/` cache in `tmp/`, a symlink per entry back   |
| `hangar jira hook`             | `PreToolUse`: serve a cached ticket instead of re-fetching it         |
| `hangar ide vscode sync`       | one VS Code setup everywhere, per-clone paths still per clone         |
| `hangar colours sync`          | regenerate the palette-derived artifacts                              |
| `hangar colours change`        | give one clone another hue, and rebuild everything that names it      |
| `hangar colours list`          | the palette, painted, and which clone holds each hue                  |

Seven behaviours are worth knowing before you run them:

- **`hangar sync` types into a live Claude session.** There is no CLI mechanism to message a
  running interactive session, so it finds the session's tty, maps it to an iTerm2 tab and writes
  a pause message, then a closing message afterwards. Each one leads with a marker —
  `SYNC PAUSE`, then **exactly one** `SYNC FINISHED` or `SYNC ABORTED`, which the pause promises
  and a `finally` delivers. That guarantee is the point: six paths lead out of a sync between
  the two messages, five of them used to send nothing, and an agent told to STOP and wait for a
  message that never comes waits for good. The closing message **reports the state it found**
  rather than an outcome — a half-applied operation, files still conflicted, work still in a
  stash — because those combine, and it says whether to resume or to stand still and tell the
  user. `--all` **skips** clones with a live session unless `--include-busy`. Rebase vs merge
  follows the rule "rebase only my own linear branch"; anything with merge commits, or started by
  someone else, is merged instead. It **refuses to start on a clone that is already mid-rebase or
  mid-merge** — finish or abort that first, because step one is a `git stash push` and it would
  bury the half-applied state in a stash nobody thinks to look in.
- **`hangar sync` integrates onto the branch the clone's PULL REQUEST targets, not onto
  `master`.** Nothing local knows that branch: a branch cut from `master` can have a PR onto
  `release9`, or onto another branch of this fleet (a stacked PR — one clone's PR onto another
  clone's branch), and every fork-point heuristic answers `master` for all of them. So `sync`
  asks the Bitbucket REST API, authenticated with `BITBUCKET_TOKEN` from `.env.shared` (an
  Atlassian API token; Bitbucket Cloud takes it as a bearer token). The target is **printed on
  every run** with where it came from, and `-n` shows it without changing anything. Priority is
  `--onto <ref>` > the open PR's destination > the default branch. Two open PRs onto different
  branches **abort** and ask for `--onto`; a destination that does not exist on origin even
  after the fetch **aborts** too, rather than quietly falling back — a rebase onto the wrong
  base is the expensive thing to undo here. No token, no network or a 401 is _not_ an error: it
  falls back to the default branch and says the target is a guess. The ref handed to git is
  always `origin/<branch>` — a bare name is ambiguous the moment a sibling clone has the same
  branch, which in a stacked PR it does by definition, and `checkout.defaultRemote` does not
  reach `rev-parse` or `rebase`.
- **`merge-default` and `rebase-default` are `sync` under another name, and the name is read out
  of `process.argv`.** Commander records nowhere which alias a subcommand was reached by —
  `actionCommand.name()` always answers `sync` — so `forcedStrategy` scans the invocation for one
  of the three names. A WHITELIST scan and not a parser that skips global options: the parser
  version stays correct only until a second value-taking global option is added, at which point
  it would silently take that option's value for the subcommand name. `--strategy` outranks the
  name, because a flag was typed for this run while the name is only how the command was reached.
  The force itself is `decideStrategy`, which is pure and takes the AUTOMATIC RESULT rather than
  the clone, so all twelve combinations print side by side with no git state; it leaves the
  automatic answer untouched whenever the force agrees with it, which keeps the dry run's output —
  this command's regression record — byte-identical unless something was really overridden. Two of
  the four kinds are never forced: `ff-only` means the branch IS the target and `up-to-date` means
  it already contains it, and neither is an opinion to override. Forcing a MERGE is silent (it is
  the conservative half of the rule); forcing a REBASE over an automatic merge `warn`s on both the
  real and the dry-run path, because that is the one case where the tool does what it otherwise
  refuses — rewriting merge commits, or commits somebody else authored.
- **`hangar plans collect` and `tmp merge` move files between the clones and the fleet root.**
  Both are idempotent and neither ever overwrites: byte-identical copies collapse to one, anything
  that differs is kept beside the winner as `<name>.from-clone_NN`, and anything a live session may
  still be writing is left where it is and reported. Run them again rather than forcing them.
  It also makes **one record per ticket** in `tmp/jira-tickets/`, with every cached name a hard
  link to it — see **Shared `tmp/`** below, and note that a relation copy loses its
  `relation:`/`relatedTo:` frontmatter when it is linked, because one inode cannot name two
  trunks.
  **`tmp merge` never touches a PID file — it does not move, link or even read one** — so every
  clone keeps its own `tmp/` directory and its own PID files in it, and a running dev server is no
  obstacle to running the command. Only the cache entries inside `tmp/` are shared, one symlink
  each. It moves every clone's cache into the store BEFORE it links any of it back, so a conflict
  copy created for the last clone still reaches the first, and it drains
  `~/.claude/dvb-gn-jira` in the same run (nothing is left pointing into a store that has been
  emptied). See **Shared `tmp/`** below.
  **Each clone runs `tmp merge --quiet` from a `SessionEnd` hook**, so a ticket first fetched in
  one clone reaches the others when that session ends. It is `SessionEnd` and not a trigger on
  the write itself for a reason that cannot be tuned away: the store pass deliberately leaves
  alone any copy written in the last two minutes, so a hook firing BECAUSE a ticket was just
  written would arrive inside its own exclusion window every time and do nothing. Nothing
  watches `tmp/` — the run happens once, at the end of a session, when nothing is mid-write.
  Quiet mode holds the whole narration and prints it only if something needs a human (a
  conflict copy, a name it could not link, a record whose frontmatter disagrees with its
  filename, a stray PID file); the two-minute guard is explicitly not one of those, because the
  next session end resolves it. The two `--quiet` commands are built differently and flush on
  opposite criteria — `plans collect` buffers locally and prints when something MOVED, `tmp merge`
  captures at the `ui.ts` level and prints only when something WARNED — so a third one copies
  whichever matches its outcome rather than unifying them. Not having the hook costs one wasted
  re-fetch in a sibling and never a wrong answer — `jira hook` reads `fetched_at:` out of the file
  and refuses to hand back anything older than the copy the clone already holds.
- **Conflicts are delegated to a headless `claude -p` inside the clone**, then verified
  mechanically (no unmerged paths, no markers). If that fails the whole operation is aborted and
  the pre-sync state restored — never left half-merged. **One exception, and it is inherent:**
  putting your stashed work back happens after the integration is already committed, so if that
  is what fails, the branch has moved and cannot be rolled back. The clone is then left with
  unmerged paths and the stash intact, and the session is told the integration DID happen —
  never that it did not. `status` grows two rows for exactly this wreckage — `pending` and
  `sync stash` — and both appear **only when there is something to say**, so a clone that shows
  neither is the healthy case and not a missing feature. The stash row earns its place: these
  clones carry six hundred stashes each, and a leftover `hangar-sync` one is invisible in
  that pile. `git rerere` and `-X ours/theirs` are
  deliberately not used: they look like resolution and silently produce wrong code.
  **That run takes one to three minutes and streams its progress** — a dim line per tool call,
  per API retry, and a heartbeat into any longer silence — because `claude -p` in its default
  output format prints nothing at all until it finishes, which reads as a hung command and gets
  killed, leaving the rebase stopped mid-pick. **Let it run; do not resolve the same files by
  hand while it is working.** It is aborted after 10 minutes
  (`ORCH_UTIL_RESOLVE_TIMEOUT_MS` overrides), and the headless session id it prints is the
  transcript to read afterwards.
- **`hangar open` puts every clone in ONE iTerm2 window and reuses whatever is already
  open.** It finds that window by the user variables it stamps on the sessions it creates, so a
  clone that already has tabs there is selected rather than opened a second time, and a clone
  whose VS Code workspace is already open gets that window focused — the workspace file exists
  twice per clone and VS Code counts the two copies as two different workspaces, so it is handed
  back the exact path it already has. A window it does NOT recognise — opened by hand, or before
  this change, and already sitting in that clone — makes it stop and ask, because that window may
  hold a live Claude session and a second one in the same clone is the fleet's worst failure.
  **Tab order is creation order and nothing else:** iTerm2's AppleScript interface cannot move a
  tab — `move` is accepted and silently does nothing — so `open` sorts the clones it was given
  and appends them, then says so when the window ends up out of clone order. Sorting one that
  already is means dragging the tabs by hand, or closing the window and running `open --all`.
- **`hangar resume` is the only picker that sees all of a clone's sessions.** Claude Code's
  own `--resume` list is scoped to the directory it was started in, so a session started in
  `clone_01/angular/` is invisible from `clone_01/` — this one reads every transcript directory
  the clone owns and runs `claude --resume` with the right `cd` baked in, in the tab you typed
  it in. Each row is the session's own generated title (its opening request when it never got
  one), and the pane under the list shows what it was asked first and last. The headless
  `claude -p` runs `sync` leaves behind are filtered out by their `sdk-cli` entrypoint. A
  session whose directory has a live `claude` in it is marked and **asks before resuming**:
  nothing can tell which transcript a running session owns, and resuming the one already open
  puts two Claude Code sessions in one clone.

**`hangar ide vscode sync` is a text transform, not a copy** — and it is the only editor for which that is true ($PROJECT_DIR$ and project-relative settings spare the others) —, and for two reasons. A handful of
VS Code settings take an **absolute** path into the checkout — `stylelint.stylelintPath`,
`stylelint.configFile`, `stylelint.configBasedir`, `prettier.prettierPath`, `prettier.configPath`,
`jestrunner.projectPath`, `coverage-gutters.manualCoverageFilePaths`,
`storyExplorer.server.internal.npm.dir` — and VS Code resolves them against nothing, so those must
differ per clone while every other key should be identical. It discovers the checkout root the
source file's values point at, replaces it with a token, and renders that template with each
clone's own root. And both `.vscode/settings.json` and the `*.code-workspace` files are **JSONC** —
comments and trailing commas, neither of which survives `JSON.parse` — so nothing is ever
reserialised; key order and the hand-maintained tab indentation are preserved as text.

Three things follow that are worth knowing:

- **The key list is declared, in `app/src/vscode.ts`, not sniffed.** A clone-specific setting
  that is missing from it gets copied verbatim and leaves one clone's tool path aimed at another
  clone's `node_modules` — silent, exactly like a Storybook health check on a sibling's port. A
  rendered file that still contains `clone_NN` for another `NN` is therefore a **hard error**
  naming the file; the fix is to add the key to the table, not to force the write. Absolute paths
  _outside_ the fleet root are left alone — the `~/.vscode/extensions/…` YAML schema URL in the
  workspace file is genuinely shared.
- **`launch.json` and `tasks.json` are tracked by git**, unlike `settings.json`, `mcp.json` and the
  workspace files, so they are **compared and never written** — there is no flag to force it. They
  are versioned per branch, so the newest copy is not the right one, it is just whatever branch
  last touched it; writing it into a sibling would dirty that sibling's checked-out branch _and_
  import another branch's content into it. When they differ the command groups the clones by
  version and prints each one's branch, which is almost always the explanation. Git resolves that,
  not this command.
- **There is no source clone.** Each untracked artifact independently syncs from the most recently
  modified copy of _that_ file (they drift separately), which is printed; `--from <clone>`
  overrides it and `-n` shows the changed keys per clone without writing.

The workspace file exists **twice** per clone, byte-identical — `clone_NN/dvb_gn_NN.code-workspace`
and `clone_NN/angular/dvb_gn_NN.code-workspace` — because VS Code only offers a
`*.code-workspace` from the directory you opened, and this repo is opened at both. `doctor` checks
for both and fills a missing one from its twin; `workspaceContent()` in `clone-config.ts` is only
the fallback for a clone that has neither.

### The config file is split in two, and one of them is not in git

`hangar.config.yaml` is **gitignored**. It names one machine's paths, ports and token variable
names, and it is written by `hangar setup` per machine, so tracking it would mean every hangar
sharing one machine's answers. What is committed is **`hangar.config.example.yaml`**: every key,
its default, and every alternative that the cross-field checks will not let stand beside it.

Three properties hold that pair together, and each is a decision:

- **The example is a faithful SUPERSET of the live file, and that is checkable.** `hangar config
  show` on each must differ only in the free-text `_` note. It is the only committed record of
  how this hangar is configured, so a drifting example is a lost config.
- **It is not a second marker.** `isHangarRoot` tests `CONFIG_FILENAME` exactly, so the example
  can sit in a hangar root without being mistaken for one — and `hangar --hangar <dir>` on a
  copy is how you validate it (nothing loads the example's own filename).
- **You cannot uncomment two alternatives.** `superRefine` rejects two port roles whose bases
  are congruent mod `step`, an `install` step naming both `manager` and `command`,
  `rootPathKeys` with no VS Code-family kind to read them, and a tracker with no `baseUrl`. So
  the example carries alternatives as COMMENTS beside one live choice.

**The rule for what a live config keeps:** a value that pins state already on disk or already
running stays written down even when it equals the default — `clones.prefix` and `clones.pad`
name directories that exist, `ports.step`/`ports.offset` place dev servers that are serving, and
a future change to a default must not move either. A value that only configures a feature this
hangar does not use goes — `editor.jetbrains` in a hangar listing only `vscode` configures
nothing.

### Absence is a gate; invalidity is a report

A `preAction` hook in `cli.ts` refuses **every** command when `hangar.config.yaml` is missing:
the marker file IS the hangar, and running without one means running on schema defaults while
looking like a configured run. Two exemptions, both load-bearing rather than convenient —
`setup`, which writes the file, and **`jira hook`, whose `PreToolUse` contract is fail-open**,
because a non-zero exit from a PreToolUse hook can block the tool call it exists to accelerate.
The two `SessionEnd` hooks (`plans collect`, `tmp merge`) are deliberately NOT exempt: a missing
config there is worth surfacing, and a session ending is the safe moment to surface it.

The gate tests EXISTENCE and never parses. That is what keeps `config validate` and `doctor`
able to do their jobs: both exist to report an invalid config, and a gate that parsed the file
would stop them before they could. So the three config readers that are reached outside a
command's own `loadConfigFile` — `currentHangarId`, `terminalColourSettings`, `terminal`, plus
`editorConfig` — now catch only the UNPARSEABLE case, where falling back beats refusing (a
`colours sync` that regenerates with default colouring is better than one that will not run).
`EditorSelection.fellBack` therefore means exactly one thing now: the config would not parse.

### VS Code is ranked above the other editors, and the code says so

`editor.kinds` accepts thirteen kinds; **one of them is verified against a live install and the
other twelve are written from documented contracts.** So the rank is in the code rather than in a
caveat:

- **`DEFAULT_EDITOR_KIND` (`app/src/editor/kinds.ts`) is the only place that names the default.**
  The zod default is `[DEFAULT_EDITOR_KIND]`, and the fallback for a config too broken to parse is
  `editorSchema.parse({})` — i.e. it reaches the same constant through the same default. Two
  literals here would be two things to keep in agreement, and the failure would be silent.
- **`editors()` builds the drivers in a loop with a per-kind catch**, not a `.map`. Several
  constructors probe the machine (`vimDriver` looks for four binaries, `jetbrainsDriver` resolves
  a launcher), and a `.map` would let one of them take the default editor down with it. `open`
  and `doctor` then isolate each driver again around `isAvailable`/`launch`, so `[zed, vscode]`
  cannot lose VS Code to Zed's launcher — listing order alone would have decided that.
- **`editorFor(kind)` builds only the kind asked for and does NOT catch.** It used to pick from
  `editors()`, which made `hangar vscode sync` construct every other configured driver first and
  depend on all of them. And an editor the developer named by running `hangar <kind> sync` is not
  a bystander: its failure is the answer to that command.

What this was checked with, since there is no test suite: `kinds` set to all seven families at
once (`doctor` printed seven honest rows, no throw), VS Code placed **third** in that list (its
row still green), and `zedDriver` temporarily made to throw at construction — `doctor` reported
`the zed editor driver would not build: …` and VS Code's row survived, while `hangar zed sync`
raised, which is the intended asymmetry. The live VS Code path: `openWorkspaceFile` found
clone_03's already-open workspace and `launch` returned `reused: true`, so it focused that window
instead of opening a second one on the identical twin.

`doctor`'s editor row names the two things that differ **between** these editors, both the
editor's doing: who works out which window already has the clone open (`focus-existing` when
Hangar must, `self-deduping` when the editor does, `a terminal tab` for terminal vim, which is not
a window at all), and whether there is a setup to keep in step (`sync` / `sync, per-clone paths` /
`launch only`). It used to print `$PROJECT_DIR$` for Xcode and vim, describing a mechanism neither
has.

Two rules for anything `hangar` GENERATES into a clone, both learned from the identity file:

- **It has to satisfy that clone's own tooling.** `.git/info/exclude` hides a file from git, not
  from Prettier, and the repo's `md:check` globs `../**/*.md` from `angular/` — so an untracked
  generated `*.md` sitting at a clone root is formatted by the repo like any tracked file. The
  identity file's markdown table went unpadded for a while and sat in that repo's pre-existing
  format debt, where it read as the branch's doing and nobody could fix it: hand-formatting it
  now trips `doctor`'s content check instead.
- **`doctor` compares its content, never just its presence.** An existence check on a generated
  file is a check that lets the content rot. The `*.code-workspace` pair is the deliberate
  exception, because its content is `vscode sync`'s business rather than a generator's.

`hangar doctor` is the regression net for everything that lives outside git and so cannot be
restored by a pull — ports, the `CLAUDE.local.md` + `.git/info/exclude` pair (the identity file by
CONTENT, since it is generated, so a stale or hand-edited one is rewritten — existence alone was
the check for a while, and three clones spent it telling their sessions the fleet had three
clones), `.envrc.private`, the playwright symlink, the theme, the Storybook health-check port,
that `tmp/` is the clone's own directory, the three hooks in
`settings.local.json` (plan collection, the cache merge and the Jira record hook — each repair
re-reads the file, so a clone missing two of them gets both in one `--fix` pass), the sibling
remotes in both directions, and the `checkout.defaultRemote=origin` those remotes make necessary.
Run it after any re-clone. **How much of the shared cache a clone links is deliberately not a
check** — a ticket fetched here reaches
the others at the next `tmp merge`, which is what linking per entry means, and a check that is red
in normal operation is a check nobody reads.

## Shared `tmp/`

Every clone **keeps its own `tmp/` directory**. What is shared is the content in it that belongs
to no clone in particular — the per-ticket Jira cache, the PR descriptions, whatever else the
skills leave there — which lives in `~/code/dvb_gn/tmp/<name>` with `clone_NN/tmp/<name>` a
**symlink per entry** in every clone. A ticket fetched in one clone reaches the others at the next
`hangar tmp merge`.

**The links go one level down, and `tmp/` itself is never a symlink.** `tmp/` also holds the
dev-server PID files: `dev/run-with-pid.mjs` refuses a name that is already live and
`node dev/pids.mjs --kill <name>` finds a server by that file, so a shared `tmp/` would let the
first clone to start a dev server block the other two and let a kill reach into a sibling. With
the links one level down, **PID files are never moved, linked or even read** — a running dev
server is no obstacle to sharing, and nothing has to have landed on a clone's branch first.
Whether a clone writes `tmp/<name>.pid` or `tmp/_<clone>/<name>.pid` is its branch's business and
matters to nobody else. A `tmp` that IS a symlink is the shape an earlier version of `tmp merge`
produced: `tmp merge` turns it back into the clone's own directory of links, and `doctor` reports
it.

`hangar tmp merge` is idempotent and never overwrites: byte-identical copies collapse to one,
anything that differs is kept beside the winner as `<name>.from-clone_NN` (and is then linked
everywhere like any other entry — review the pair and delete the loser), and a link that already
points where it belongs is left alone rather than rebuilt. It shares everything except PID files
and dotfiles — a **blocklist**, so a file a skill starts caching tomorrow is shared without
anyone editing a table. `-n` previews, and names any entry two clones both offer, since which of
the two wins is decided from what is on disk and a dry run has moved nothing.

**One ticket lands in the store under several names, and `tmp merge` collapses them onto one
file.** The `jira-scope` skill gives a directory only to the ticket the user asked about, so a
ticket fetched as a relation is written into the asking ticket's directory:
`ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md` **is ABC-1323**. The **last** issue key in a
filename is what the file contains; the keys before it only say how it was reached (and the same
holds for an attachment — `ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png` is ABC-1191's
attachment). Three things follow:

- **Every ticket has ONE record: `tmp/jira-tickets/ABC-1234.md`**, and every cached name for that
  ticket is a **hard link** to it — its own `tmp/ABC-1234/ticket_ABC-1234.md` and every
  `tmp/<TRUNK>/ticket_<TRUNK>_<relation>_ABC-1234.md`. One ticket is one inode however many
  investigations reached it. This directory is deliberately **not** linked into the clones like
  every other store entry: no skill owns that path, and a symlink in `clone_NN/tmp/` would
  invite an agent to write into it.

  **The record cannot carry `relation:`/`relatedTo:`, and that is a proof rather than a taste.**
  Those keys name the trunk a copy was reached from, and a ticket reachable from two trunks
  would need one inode holding two different `relatedTo:` values. So the record is the winning
  copy with those two lines removed, and each relation copy loses them when it is linked. The
  filename still says `_relates_to_`, and the trunk's own `relations:` / `parent:` /
  `subtasks:` frontmatter still states the relation and its label, so nothing is unrecoverable —
  it is printed every time it happens. Nothing in the skill reads a cached record (`sync.mjs`
  has no `readFileSync` at all), so the stripped keys change what a reader sees and nothing else.

  **A ticket's OWN record wins over a relation copy regardless of age**; `fetched_at:` only ranks
  peers. That is the rule the old freshest-wins collapse lacked, and its absence is what put
  ABC-1259's and ABC-1323's own records into a state where they read as though they hung off
  another ticket. The store makes it unreachable rather than merely warned about. A copy written
  in the last two minutes is left alone — a session may be mid-refresh, and this pass replaces
  content — and a copy whose `id:` disagrees with its filename is reported and never linked.

  The one thing that does **not** collapse: **a ticket with attachments, cached under two
  different trunks.** Asset references in the body are trunk-specific
  (`ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png`), so one shared record cannot carry
  correct references for both; the copy whose references differ is kept as its own file and
  reported. Tickets with no attachments — most of them — link freely.

- **Byte-identical files elsewhere in the store are hard-linked**, by `jdupes -L` (`-A` skips
  dotfiles, `-X noext:pid` keeps PID files out, and it treats already-linked files as
  non-duplicates, so a re-run does nothing). Not reimplemented and not `fdupes`, which has no
  hard-link action at all. **Attachments** are what this is for now that ticket records have
  their own store: a 4 MB recording fetched under two relation paths is one file twice.
  **Install it (`brew install jdupes`) or the pass is skipped with a warning** — the rest of the
  merge is unaffected.
- **Everything else about a ticket that differs under one canonical name** — `plan_<KEY>.md`,
  `pr_description_<KEY>.md` — still collapses onto the **freshest** copy, where freshest-wins is
  the whole of the right answer. Freshness is `fetched_at:` / `fetched:` frontmatter (Jira's
  `updated_at:` is only a fallback — it is written on a ticket's own file and left off the
  relation copies, so it cannot rank the two against each other). **Both spellings are read:**
  `jira-scope` wrote the bare names, the newer `jira-ticket-sync` contract writes the `_at` ones,
  and matching only one sent every synced file to the file-mtime fallback. Markdown only: a
  differing pair of _assets_ under one name is a download that went wrong, not a newer
  rendering, so neither is preferred. `-n` prints every choice before any of it happens.

**A ticket fetched in the last hour is not fetched again.** `hangar jira hook` is a
`PreToolUse` hook, wired into each clone's untracked `.claude/settings.local.json` by absolute
path (`doctor` checks it, `--fix` wires it). It reads the Bash command Claude Code is about to
run; when every file a `jira-ticket-sync/sync.mjs` run would write is already on disk and inside
the TTL, it hard-links from the record store whatever is missing and **denies** the command,
telling the agent what it got instead. Five properties are the whole design:

- **It fails open.** A flag it does not know, a frontmatter shape it cannot read, a record with
  no parsable timestamp, a shell construct in the tail — all exit silently and let the fetch
  happen. A hook that wrongly denies leaves an agent unable to read a ticket for reasons
  invisible from inside the clone. `--explain` prints the reason it declined, which is the only
  way to debug something that is silent by design; `-n` decides without linking.
- **All or nothing.** A run writes the trunk AND its parent, sub-tasks and relations, so the
  neighbourhood is read out of the CACHED trunk's own frontmatter and every one of those tickets
  must also be in the store and fresh. An OLD-format record has those keys absent rather than
  empty, and absent is declined — reading it as "no neighbours" would turn a full sync into one
  linked file.
- **It never reimplements the naming.** Where each file belongs comes from that clone's own
  `jira-scope/jira-cache.mjs name`, one subprocess per file. `paths.mjs` calls itself the single
  owner of every filename in that directory, it is tracked and branch-versioned, and an
  untracked copy of `stemFor` here would drift the first time a branch changed a relation slug.
- **It never hands back a worse copy than the clone already has.** This is the case immediately
  after any real fetch: `sync.mjs` replaces the inode, so the clone holds the fresh copy while
  the store still holds the previous one until the next `tmp merge`. Linking then would put the
  OLDER record over the newer file and report it as cached. So a destination whose own
  `fetched_at:` is at least as fresh as the store record's is left exactly where it is and
  counted as satisfied — the file that run would have written is present and fresh, just not by
  way of the store.
- **Whether Jira changed cannot be known without asking Jira**, so the TTL (`--ttl <minutes>`,
  default 60) is the whole of the freshness guarantee. `JIRA_SYNC_NO_CACHE=1` in front of the
  command bypasses the hook — an env var and not a flag, because `sync.mjs` dies on an unknown
  flag.

None of this needs anything from the clones. Their `.claude/` is shared with every other
contributor and must work without this fleet, so the record store appears in no tracked file: the
skill writes exactly what it always wrote, and `tmp merge` and the hook do the rest.

The old per-key mechanism — `tmp/<KEY>` linked into `~/.claude/dvb-gn-jira` by
`hangar jira link` — is **gone**, and so is that command: `tmp merge` drains the store into
`~/code/dvb_gn/tmp` and removes it, and links every entry rather than only the `DN-####`
directories (which left `pr-*.md` and `author-aliases.md` unshared in whichever clone made them).

This needs **no change to the tracked skill tooling**:
`.claude/skills/jira-scope/jira-cache.mjs` hardcodes `<git toplevel>/tmp/<KEY>` with no
configuration, but only ever does `mkdirSync(..., {recursive: true})` on it, which follows a
symlink.

`ticket_<KEY>.md`, its relation variants and Jira attachments are clone- and branch-independent,
which is the point. **A PR description is not** — it is derived from the working-tree diff, so it
is shared as a side effect and is last-writer-wins when two clones work one ticket at once. One
ticket normally belongs to one clone, so this is bounded, but do not trust a PR description you
did not just generate in this clone.

`tmp/` is gitignored by the tracked `tmp/` rule, which matches the real directory and everything
under it — the per-entry links included. So nothing about `tmp` belongs in `.git/info/exclude`;
that file is back to hiding `/CLAUDE.local.md` alone. A clone that still carries the old `/tmp`
line is fine — it excludes something already ignored.
