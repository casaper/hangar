# Notes that change what you type

Split out of `commands.md`; the command tables and the tool map stay there.

**These are written in the shell spelling**, because that is the form you hand to the user and the
form the flags are named in. Everything here is equally true of the tool that runs it — the map
above says which — with one substitution throughout: where a note says `-n`, the tool is the
separate `<thing>_preview`.


- **`pr create` and `pr update` are the only commands that write to the FORGE**, which makes their
  mistakes the only ones the whole team can see. Five things follow, and each one is a refusal
  rather than a warning:
  - **The clone comes from where the command runs.** In a clone's own shell the argument may be
    left out; naming a DIFFERENT clone is refused, and from the hangar root the argument is
    required. There is no `--all` — one pull request at a time, on purpose.
  - **`pr create` opens a DRAFT.** `--ready` opens it ready for review, which notifies its
    reviewers and cannot be taken back. It is also idempotent: a branch that already has one open
    is reported, exit 0, and nothing is created — so re-running it is safe.
  - **`pr update` rewrites only pull requests the token owner authored**, and refuses when it
    cannot tell whose it is. With neither `--draft` nor `--ready` it leaves the draft state alone.
  - **It refuses when the branch, or its latest commits, are not on origin** and prints the `push`
    command. Pushing stays the user's own action; do not offer to do it.
  - **No agent may run either through Bash.** `bin/hangar-exec-guard` refuses both unless the
    invocation carries `-n`, because `-y` skips the confirmation. The `pr_create` and
    `pr_update` tools are not Bash calls and stay behind their `ask` rules.
- **The title and body come from the description the repo's own agent writes**, found in that
  clone's own `tmp/`, and a description written BEFORE the branch's last commit counts as out of
  date.
  In the terminal that is repaired for you — `forge.prDescriptionPrompt` runs as a headless Claude
  Code session in the clone, one to three minutes with progress streaming. **Through the tool it is
  not**: `pr_create` and `pr_update` fix `--no-describe`, so they refuse and name the command to
  type. That is deliberate — a tool call cannot show a stream and would die at its own timeout
  mid-run. `--file <path>` and `--title <text>` bypass the search entirely.
- **Both commands ASK before they act, on the terminal, and there is no terminal behind a tool.**
  So a tool call needs `yes: true` or it reports that nothing was created and exits 0 — which is
  why the preview matters here more than anywhere else: it is where the title is printed, and
  reading that back to the user before you pass `yes: true` is how a human sees what will be
  published. In the terminal `-y` is the same thing. Writing a description asks separately, before
  the run starts.
- **The editor commands live under `ide`, aliased `editor`, so the top level carries one entry for
  the editors rather than one per editor.** `colours` is aliased `colors`, and `checkout-default`
  is aliased `checkout`.
- **`hangar exec` is the user's, and you cannot run it at all.** It is not `ask` — it is denied
  in both modes AND blocked by a `PreToolUse` hook that reads the whole command line, so
  `cd /somewhere && hangar exec ...` is refused too. Do not go looking for a spelling that gets
  through; there is no tool either, and that is deliberate rather than a gap. Everything after
  `--` is a shell snippet, so a schema could describe it and never constrain it, and it reaches
  every clone in one call — including working trees other agents are live in. **When it is the
  right answer, hand the user the exact line and let them run it**, `-n` first.
- **Everything after `--` is the snippet; everything before it selects clones.** So
  `hangar exec 1 3 -- git status -sb` runs in two clones and `hangar exec --all -- git fetch` in
  all of them. Your shell splits argv before hangar sees it and hangar rejoins it with single
  spaces, so **quote the whole snippet as one argument whenever spacing or an operator matters**:
  `hangar exec --all -- 'grep "two words" .'`. Without the quotes the doubled space is lost.
- **The snippet runs in the user's own `$SHELL` with `-i`, in each clone's ROOT**, so their shell
  functions and aliases are available and each clone's own direnv environment — its ports, its
  pinned Node — is loaded first. `--no-direnv` turns that off. An interactive shell costs several
  seconds to start, which is why clones run in parallel by default and each clone's output is
  printed as one block when it finishes; `--serial` streams live instead, and `-j` bounds the
  fan-out. **A snippet that prompts for input will not work** — stdin is closed in both modes.
  Expect a couple of lines of noise per clone from the user's own rc files.
- **`sync`, `merge-default` and `rebase-default` are one command.** All three resolve the same
  target — whatever the branch's open pull request points at, which is often *not* the default
  branch — and only the strategy differs. `--strategy` outranks the name.
- **`--onto <ref>` skips the pull-request lookup entirely.** Reach for it only when the user names
  a target; the lookup is usually the right answer and is printed on every run.
- **A `sync` that hits conflicts can be steered while it works, and only from a terminal.** While
  the headless resolver is running, a line typed at the keyboard plus Enter reaches it — "keep
  master's version of that spec" — and comes back as a cyan `→ sent:` line, which is the
  confirmation it was delivered. It is picked up at the resolver's NEXT turn rather than the one in
  flight, so a line typed mid-tool-call lands a few seconds later. There is no flag: the channel
  exists when stdin is a tty and does not when it is not, which means **no agent can use it —
  through the Bash tool or the `sync` tool alike.** A tool call has no terminal either, so there is
  no channel and the run is the fire-and-forget one. This is the user's to type, in the window the
  sync is running in.
- **A `--continue` during that sync owns the terminal.** If git needs an answer — a GPG passphrase
  for a signed commit, a prompt from one of the repo's own hooks — the question appears on screen
  and waits for it. There is no timeout, so a sync sitting silent after the resolver has finished
  is worth LOOKING at rather than killing: something is asking.
- **`open` leaves each clone on the branch it has unless told otherwise.** `-c` fetches and puts
  it on the default branch, up to date; `--branch <name>` on that one. `--include-busy` only
  governs that checkout, so it is refused without one of the two.
- **`open -n` is worth running before the real thing.** It prints the branch each clone is on or
  would land on (or why it would be left alone), the tmux session and windows it would create or
  the window it would bring forward, and the attach line verbatim — and changes nothing.
  `--no-claude` still narrows what the real run does; `-n` is how you see it first.
- **`open` opens no editor unless `-e` is passed**, and `hangar edit <clone>` is that half on its
  own — the editors, and nothing else: no fetch, no branch, no session, no window. The clone's own
  tmux windows bind `C-b C-e` to it, so a developer sitting in a clone can open it in VS Code
  without naming an index. `close --no-editor` and `reload --no-editor` are the other direction
  and are unchanged: `close` shuts a window that is open, and `reload --no-editor` is about
  rewriting the editors' per-clone files rather than about launching anything.
- **`remove-clone --force` is the one genuinely unrecoverable flag in this CLI** — its own help says
  uncommitted work is NOT recoverable. Never pass it without the user asking for it in those terms.
- **`add-clone --no-install` leaves the clone unusable** until someone runs `hangar install
  <clone>`. It prints the exact steps it skipped, from `repo.install[]`, each with its `why`.
- **`hangar install` is the user's command, and `-n` first is not optional courtesy.** What it
  runs comes from `repo.install[]`, and this repo's step is `npm ci` — which DELETES
  `node_modules` before refetching it, so a clone with a dev server running loses it mid-request.
  `hangar install <clone> -n` prints every step without spawning anything.
- **`hangar allow` is how a clone direnv has blocked gets un-blocked**, and a repo usually has
  more than one `.envrc` — this one has three, all TRACKED, so any `git pull` or `hangar sync`
  blocks the lot at once. The command runs `direnv allow` in each directory that has one,
  discovered from `git ls-files` with `repo.envrcDirs` union'd in as the fallback. It changes no
  file and no git state, which is why it is not a `[user]` row. **A failure warns and the run
  carries on** — unlike `install`, where a failed step means stopping — so `--all` never leaves
  the fleet half done; the exit is non-zero at the end, naming every directory that failed.
- **From inside a clone the command may not be reachable, and the shell function is the answer.**
  direnv considers only the NEAREST `.envrc`, and when that one is blocked it reverts the
  environment outright rather than falling back to a parent — so the clone's own
  `PATH_add "<hangar>/bin"` has not run and `hangar` is not on PATH in exactly the shell that
  needs this. `hangar_<id>_allow` is generated into `clone-terminal.sh`, which the developer's
  `~/.zshrc` sources, and it names `bin/hangar` by absolute path. Tell the user that name rather
  than a path; it takes the same arguments the command does, and it reaches a NEW shell only.
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
  which is also worth typing directly. **A click only arrives if the terminal emulator reports
  button presses, and that is not the same setting as the wheel** — iTerm2 has one for each, so a
  bar where scrolling works and nothing is clickable is the emulator rather than tmux. `doctor`'s
  `emulator` row appends `clicks not reported` and names the setting to change; it never changes
  it, and it is not counted as a problem, because with clicks reported a plain drag inside a pane
  selects in tmux rather than in the emulator — a trade the developer may have made on purpose.
  **The other half is the tmux server's own PATH**, which is launchd's when the terminal created
  the server rather than `hangar open` — and then the click, `C-b C-e` and the bar's own
  pull-request refresh all find no `node` and do nothing. `doctor` has a row for that one too, and
  `hangar colours sync` is the repair; it writes onto the running server with nothing restarted.

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
  **It also stops the clone's dev servers**, rather than assuming they die with the session — one
  that was detached or re-parented outlives it and goes on holding the clone's port. They are
  stopped first, so a tracked server can remove its own pid file, and through the same guards
  `hangar servers kill` uses: a stray is left running and named, so the editor's own language
  server is never caught up in it. A clone with no session but a live dev server is therefore no
  longer "nothing to close" — and because that is a signal, it asks before sending one.
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
- **`hangar list` is the fleet's one-screen answer to "who is on what"**: branch, issue key, pull
  request, build and review per clone. The pull-request columns come from the cache the tmux bar
  draws, and a record past `forge.prCacheTtlSeconds` is refreshed first, all clones at once, for
  at most three seconds — whatever has not answered is shown marked `(stale)`, with one line after
  the table saying why. `--no-refresh` asks nothing. REVIEW is `no reviewers`, `pending a/n`
  (reviewers assigned, nobody has decided), `approved a/n` or `changes a/n`, with `changes`
  winning over any approval; a merged, declined or superseded pull request shows no build or review.
- **`resume -n` is `--limit`.** Everywhere else `-n` is `--dry-run`.
- **`-q, --quiet` on `plans collect` and `tmp merge` exists for the `SessionEnd` hooks.** They flush
  on opposite criteria — `plans collect` prints when something MOVED, `tmp merge` when something
  WARNED — so silence from either is the normal outcome, not a failure.

## `scrub` reads the drafts, not the code

`hangar scrub` reports lines under `tmp/` that name this fleet — a clone directory, a path inside
the hangar, a port the fleet derived, the CLI itself, or fleet vocabulary like `this clone` and
`<clone>`. It changes nothing, ever: what a sentence was trying to say is a judgement, and the
usual fix is to say it about the checkout rather than to delete it.

**Run it before issue text or a reproduction case goes anywhere.** That is the moment it pays,
because `tmp/` is where both are drafted and both are pasted out verbatim — into a tracker, into a
pull request, to a colleague who has one checkout and no fleet. Reproduction STEPS are the worst
case and the reason the check exists: steps built around one clone's dev-server port cannot be
followed by anybody else at all.

- **`tmp/` only**, the shared store plus every clone's own, deduplicated by real path — a clone's
  `tmp/` entries are symlinks into one store, so a draft would otherwise be reported once per
  clone. A clone's own unmerged directory is still its own finding.
- **Documents only.** Prose and the files a reproduction case is made of; dot-directories under
  `tmp/` are machine scratch and are skipped whole.
- **`--recent` bounds it to a day** and is what the `SessionEnd` hook in every clone passes. By
  hand, the interesting answer is usually the whole store: `hangar scrub --recent=100000`.
- A base port is never reported — that is the project's own default and is correct anywhere. Only
  a port this fleet derived from it is.

The rule it backs is in every clone's `CLAUDE.local.md`, so a clone session already has it; this
is what catches the slip, and `hangar doctor` has a row for the hook.

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
