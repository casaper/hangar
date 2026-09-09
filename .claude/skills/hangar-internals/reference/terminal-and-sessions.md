# One window per clone, and finding a clone's past sessions

`app/src/commands/open.ts`, `app/src/tmux.ts`, `resume.ts`, `app/src/claude-sessions.ts` and
`sessions.ts`. The emulator capability table -- who can open a window and who can raise one -- is
in `app/CLAUDE.md`; this is what the two commands do with it.

- **`hangar open` gives a clone ONE window and reuses the one it already has.** The emulator tab
  it opens is a client attached to that clone's session on this hangar's own tmux socket
  (`tmux -L hangar-<id>`), and the session holds one tmux window per `terminal.tabs[]` role. So
  "is this clone already open" is a question with an exact answer -- does the session exist --
  rather than an inference from what some window's shell happens to be standing in, and a clone
  that is already open is raised instead of opened a second time. That is not tidiness: a second
  window in a clone that already has a live Claude session is the fleet's worst failure, and the
  session name is what makes creating one by accident impossible. A clone whose VS Code workspace
  is already open gets that window focused too, for a reason that has nothing to do with
  terminals -- the workspace file exists twice per clone and VS Code counts the two copies as two
  different workspaces, so it is handed back the exact path it already has.

- **A session outlives the tab attached to it, and that is the point.** Closing the window leaves
  the clone's session running with whatever was in it, so `hangar open 1` reattaches rather than
  starting over -- verified by detaching with a marker on screen and finding it again afterwards.
  `tmux -L hangar-<id> attach -t '=<clone>:'` does the same by hand, and is also the answer on an
  emulator that cannot bring a window forward.

- **Window order is the order of `terminal.tabs[]`**, because each one is created in turn and tmux
  numbers them as they arrive. The config's key is `tabs` rather than `windows` for the reason
  worth keeping: what the developer sees is a tab bar, and a key named after the implementation
  would need a sentence of explanation on every read.

- **`hangar resume` is the only picker that sees all of a clone's sessions.** Claude Code's
  own `--resume` list is scoped to the directory it was started in, so a session started in
  `clone_01/angular/` is invisible from `clone_01/` — this one reads every transcript directory
  the clone owns and runs `claude --resume` with the right `cd` baked in, in the window you typed
  it in. Each row is the session's own generated title (its opening request when it never got
  one), and the pane under the list shows what it was asked first and last. The headless
  `claude -p` runs `sync` leaves behind are filtered out by their `sdk-cli` entrypoint. A
  session whose directory has a live `claude` in it is marked and **asks before resuming**:
  nothing can tell which transcript a running session owns, and resuming the one already open
  puts two Claude Code sessions in one clone.

## Finding what is running: the two detectors, and what each one assumes

`app/src/procs.ts`. Everything above rests on it — the busy-clone skip, the `SYNC PAUSE`
delivery, `remove-clone`'s two guards — and both of its detectors carry an assumption worth
knowing before trusting a green answer.

**Claude Code sessions come from `ps -axo pid=,tty=,etime=,args=`, matched on
`basename(argv[0]) === 'claude'`.** `args` is last on purpose: it is the only column that can hold
spaces, so as the final field it needs no quoting rule, and unlike `comm` it is never truncated.

> **`comm`-vs-`args` under procps is UNVERIFIED, and the consequence is silent.** Nothing in this
> fleet runs Linux. On macOS `ps` prints `claude` and the matcher is verified — three sessions,
> right ttys, right working directories. If a Claude Code process on Linux presents as `node`
> instead, every Linux hangar finds **zero** sessions, which turns off `sync --all`'s busy-clone
> skip and the whole `SYNC PAUSE` protocol — on the very platform tmux exists to carry them. It
> does not error: zero sessions is also what an idle machine looks like.
>
> That is what `claudeSessionDiagnostic()` and `doctor`'s `claude sessions` row are for. The row
> prints how many rows `ps` returned and how many matched, and when none matched it names the
> command names that mention `claude` anyway. A first `hangar doctor` on Linux answers the
> question in one line. **The matcher is never widened on a guess** — a false positive makes
> `sync` skip a clone that is not busy and `remove-clone` refuse a deletion nobody can explain.

**The no-tty marker is spelled differently by the two `ps` implementations**: BSD prints `??`,
procps prints `?`. The check was `=== '??'` alone, so on Linux every ttyless process came back
with a tty literally *named* `?` — not "no tty". `status` would print `on ?` and `sync` would
open `/dev/?` to deliver a pause. Both spellings (and `-`) now count as absent.

**Dev servers come from two sources, and the second one exists because the first is one repo's
convention.** `*.pid` files under `tmp/` and `tmp/_<clone>/` are written by *this app repo's*
`dev/run-with-pid.mjs`; a repo that starts its servers any other way writes none. That made
`status` say "none running" forever and — the real damage — made `remove-clone`'s refusal to
delete a clone that is still serving stop protecting anything, with nothing to notice. So
`runningServersIn` also asks `lsof` which of the clone's ports have a listener. A clone's ports
are a pure function of its index, so there is nothing to configure.

Both halves, not one: a listener answers *is this clone serving*, a pid file answers *what is it
called and how do I stop it*, and only the pid file survives a server on a port this hangar never
assigned. A pid file wins when both name the same process.

**Both of `remove-clone`'s guards depend on `lsof`, and only one of them says so.** The server
guard reports `portsChecked: false` and blocks. The SESSION guard cannot: `claudeSessionsIn` needs
`cwdsOf` to attribute a pid to a clone, so without `lsof` it simply returns an empty list and
passes quietly. The deletion is still blocked — by the server guard, which fires on the same
missing tool — so nothing gets through; but do not read a passing session guard on a machine
without `lsof` as evidence that no session is running.

**`ServerScan.portsChecked` is why this is a record and not an array.** "Nothing is running" and
"nobody could ask" are the same empty list, and `remove-clone` turns the first into a deletion —
so a missing `lsof` is reported as its own guard rather than passing quietly. `lsof` is a
required tool for a second reason too: `cwdsOf` maps a pid to its working directory with it,
which is how *any* session is attributed to a clone at all.

## The platform seam

`app/src/platform/` — the fifth seam, and the last to arrive for an honest reason: this fleet
runs on macOS, so every platform difference in this CLI was invisible until the tool was
published for someone else to run. Three were already there, written as if `darwin` were the only
case.

Same shape as the other four — a capability record plus a driver, `darwin`/`linux`/`unsupported`
registered in `platform/index.ts` — with one difference: **it is not overridable by config.**
`editor.kinds` and `terminal.kind` name a preference; this names a fact, and a key letting
someone declare `darwin` on a Linux box would only produce paths under a `~/Library` that is not
there.

| capability             | darwin | linux | what its absence costs                                              |
| ---------------------- | ------ | ----- | ------------------------------------------------------------------- |
| `openExternally`       | `open` | `xdg-open` | nothing hands a path to the desktop                            |
| `openApplicationByName`| yes    | **no**    | a JetBrains install with no launcher on PATH has no fallback    |
| `vscodeWindowState`    | yes    | yes       | `open` cannot tell a clone's workspace is already open          |

`vscodeWindowState` is the one that matters and the one that moved. It lived in `user-paths.ts`,
whose stated test is *would two hangars disagree about this path* — which it passes, and which is
not the question. It is `~/Library/Application Support/<dir>/User/globalStorage/storage.json` on
macOS and `~/.config/<dir>/User/globalStorage/storage.json` on Linux, so only the config
directory differs and the seam carries exactly that (`machineConfigDir`). Written for macOS it
does **not** fail on Linux: it returns a plausible path, `readFileSync` throws, the catch reports
"no opinion", and `hangar open` opens a second window on a workspace that was already open — how
two Claude Code sessions end up in one clone. It now returns `undefined` rather than a guess, so
a caller gets a nullable it must handle.

`openApplicationByName` is JetBrains' Toolbox case: Toolbox may install no shell launcher, and
then `open -a "WebStorm" <dir>` is the only handle left. Linux has no equivalent, and
`doctor`'s platform row says so rather than letting the fallback vanish.

**A session Hangar cannot reach is reported, never assumed.** The pause goes into the tmux pane
on the session's tty, so a `claude` started by hand in a bare emulator tab -- or inside the
developer's OWN tmux, on the default socket -- has no pane on this socket and gets nothing.
`procs` finds it by its tty all the same, so it appears in the list and would otherwise read as a
bug rather than as a session in a place this protocol does not reach; `sync` names which kind of
miss it is. It still degrades correctly: every unreachable session is reported and `integrate`
asks before touching the clone. There is no fallback worth having -- VTE exposes no API for
writing into a running terminal and `TIOCSTI` has been off by default since Linux 6.2, so "type
at the tty directly" is not a route on the platform that would need it most.

**Two other Linux fixes with no seam of their own.** The `/opt/homebrew/bin/jq` fallback in the
status line was Homebrew on Apple Silicon and nowhere else; when it misses, every `jq` query
returns empty and the badge renders **blank rather than erroring**, which reads as a Claude Code
problem. It is now a six-path search list, duplicated by hand in `.claude/modes/statusline.sh` —
that file is hand-maintained and nothing derives it from `app/src/**`, so fixing only the
generated one leaves the mode badge broken. And `environment.ts`'s install hints take their verb
from the seam (`Tool.pkg` carries the package name, which is almost never platform-specific);
`installHint` is a function rather than a field because `TOOLS` is a module constant, and a hint
baked in at import is the trap `hangar.ts` records.

## The tmux layer

`app/src/tmux.ts`. Every window `hangar open` creates is a tmux window, so everything that could
ever have differed between emulators happens here instead -- identically on both platforms,
because it is the same program on both.

**The server is Hangar's, on a private socket.** `tmux -L hangar-<id>`, started with a config
this CLI generates, and that is what makes the layer safe to be opinionated in: no session of the
developer's own lives on that server, so status-line format, window naming and -- the reason it
has to be private -- SERVER options are Hangar's to set. `extended-keys`, which is what makes
Shift+Enter a newline in Claude Code, is a server option. Two hangars are two sockets, which is
the same rule the rest of the fleet follows: what a hangar writes where another could reach it
carries the id, and nothing INSIDE a per-hangar server needs one.

| Hangar          | tmux           | why                                                     |
| --------------- | -------------- | ------------------------------------------------------- |
| a clone         | a **session**  | a session is what a developer attaches to               |
| a `tabs[]` role | a **window**   | tmux's window list is the tab bar                       |
| which hangar    | the **socket** | `-L hangar-<id>`; nothing inside it has to carry the id |

**The session NAME is the identity, which is why there is nothing to stamp and read back.** A
window can be split, renamed or `cd`'d clean out of the clone and still be that clone's window,
because the session it sits in says so. `open` asks `has-session`: absent, it creates the session
with a window per role and hands it to an emulator tab; present, it raises. `@hangar_clone` is set
per session anyway, so a session made by hand on this socket -- it carries the conf's global
`@hangar_id` and no `@hangar_clone` -- reads as foreign on a fact rather than on a heuristic.
`@hangar_clone` needs exactly one write at session scope: measured on tmux 3.7c, a session-scope
user option is visible from a pane-context format too, so a split pane stays attributed without a
second write.

**Six things tmux enforces silently, each measured before the code was written.** They are the
reason the argv is a pure builder with a test rather than a call site that got it right once:

- **`-f` and `-L` are PRE-COMMAND globals.** The SYNOPSIS is `tmux [-f file] [-L socket-name]
  [command ...]`, while `new-session`'s own `-f` is "a comma-separated list of client flags" --
  so the config flag written after the subcommand typechecks, runs, and loads nothing.
- **A missing `-f` file is ignored in silence.** `tmux -f /nonexistent new-session -d -s x` exits
  0, prints nothing, and creates the session unconfigured. So `hangar open` checks the conf exists
  itself; nothing downstream could notice.
- **`-f` rides only on `new-session`**, because the reads cannot start a server: `has-session` and
  `list-sessions` on a dead socket exit 1 and leave no socket file behind. That is also what makes
  `hangar open -n` genuinely side-effect free.
- **A session target is `=name:` and both characters matter.** Targets fall through exact name,
  then name PREFIX, then glob. With sessions `clone_01` and `clone_1` on one socket,
  `set -t 'clone_0:' @q v` SUCCEEDED on a prefix match while `set -t '=clone_0:'` answered
  `no such session`. The trailing colon is needed because `set-option` and `new-window` take a
  target-pane, where the session part is only recognised before a `:` -- `set -t '=clone_01'`
  fails with `no such session: =clone_01` while `'=clone_01:'` works.
- **`.` and `:` in a session name are ACCEPTED.** `new-session -s 'a.b'` and `-s 'c:d'` both
  succeed and produce a session that can never be addressed afterwards, so the sanitiser is a
  rewrite rather than a refusal.
- **`new-session -A -s <name>` matches exactly** -- `-s` takes a name, not a target, and `-A -s yy`
  beside a session `y` created `yy`. So one string is right for a first open and for reattaching
  after the tab was closed. What it does on the branch that cannot normally be reached is worth
  knowing: kill the server between building the session and attaching to it, and `-A` creates a
  bare session with one unnamed window, no roles and no hue. `open` waits for the client rather
  than trusting the attach to have found what it built.

**The emulator returns before the client attaches, and that gap is a duplicate waiting to
happen.** An emulator reports success as soon as it has CREATED a tab, so a second `hangar open`
moments later sees no client, cannot tell that from a genuinely detached session, and opens
another tab onto the same clone -- the one direction from which a session name cannot rule out a
duplicate. `open` waits up to three seconds for the client and treats its absence as a failure,
which also stops it repeating an emulator's claim to have run a line it dropped. A client appears
in under 100ms when it works, so the wait is only ever paid when something is wrong.

**`send-keys` and not `new-window -- <command>`.** A window whose command IS its process exits the
moment that process does, so a `claude` window would vanish on `/exit` instead of leaving the
shell the developer expects. Confirmed: the command runs and a live shell holds its output.

### The colour lives in the shell hook, and every `set -w` names `$TMUX_PANE`

The hue is painted by `generate/terminal-sh.ts`'s hook rather than from here, and the reason is
the one that governs every emulator: anything on the opening side paints only what `hangar open`
created, and the hook paints whatever `$PWD` is in -- so a window made with `C-b c` inside a
clone's session is coloured too, and so is a shell in a clone that is not in tmux at all.

The one piece `open` paints itself is `status-left`, at SESSION scope when it creates the
session. Two reasons, and the second decides it: the status bar has to be right the instant the
client attaches, which is before any shell has printed a prompt and so before the hook has run
once, and `status-left` IS a session option -- the hook could only reach it with `-g`, which would
have whichever clone was entered last recolour the bar of every other session on the socket.

It is a **badge**: `#[fg=<ink>,bg=<hue>,bold] <clone> #[default]`. The hue is the background and
not the text, because a solid block of colour is what a developer actually finds across four
near-identical windows -- and because putting the hue behind text is only safe when something
also chooses the text, which is the next section.

The hook sets five window options -- `@hangar_colour`, `window-status-current-style` (the hue as
a BACKGROUND with the ink in front), `window-status-style` (the hue as text, in its lifted
`barText` form), and both pane border styles at full strength. All five were confirmed settable
per window on tmux 3.7c, confirmed not to leak into a sibling window, and confirmed to clear with
`set -uw`. `-u` rather than writing a literal default, so two hangars sharing one server restore
each other's values instead of flattening them; never `-g`, which would have the last clone
entered recolour every window of both.

**`-t "$TMUX_PANE"` on every call, and it is load-bearing.** `set -w` with no target is the
session's ACTIVE window, not the window the calling shell is in. Without it, two windows in one session
got this: entering a clone's directory from window 1 put its hue on **window 0** and left window 1
with none. It still happens inside one clone's session -- a `cd` into a sibling clone's directory
is a second hue in one session, and a window made with `C-b c` is a second window to get wrong. A pane id is a legal target for a window option and resolves to that
pane's own window, so the fix costs no extra exec -- tmux sets `TMUX_PANE` in every pane, and it
keeps working from a split, which is the same property that makes a split pane keep its
clone. This was found by opening two windows in one session and reading the options back,
which is the only way it shows up: with a single window the wrong target and the right one are
the same window.

`window-status-current-style` is set alongside `window-status-style` because they are different
options -- the first styles a window that is not current. With only the second, the clone you are
actually looking at is the one window with no colour.

## The status bar had no background, and so had tmux's own green

**The bug, because it is the reason half of the above reads the way it does.** `clone-tmux.conf`
set the status line's FORMAT and deliberately no colour -- "every colour in it is the clone's" --
so nothing ever set `status-style` and tmux used its built-in default. Read off the live server:

```
$ tmux -L hangar-<id> show -g status-style
status-style bg=green,fg=black
```

That is a saturated default rather than a neutral one, so every clone hue was being drawn as text
on green. Measured with WCAG 2.1 across the palette: **1.00:1 to 2.64:1** -- the whole set fails
even the 3.0 that large text wants, and the `green` clone is exactly 1.00, the same colour twice.
Four clones looked like four different problems and were four points on one scale.

Three things fell out of fixing it, and each one is a decision rather than a detail:

- **The bar names its own background AND its own foreground**, from `STATUS_BAR_BG` /
  `_FG` / `_DIM` in `palette.ts`. Not `fg=default`, so the bar is self-contained on a light
  terminal theme too. They live with the hues rather than in the conf that renders them because
  `barText` is derived by measuring AGAINST that background -- two files holding different ideas
  of it would be wrong with nothing to report it. Both window styles keep a neutral base there as
  well, since `set -uw` restores what is in the conf: without one, a window leaving a clone falls
  back to tmux's green rather than to the bar.
- **The ink is pure black or pure white, and that is what makes the floor PROVABLE.** Against
  black the ratio is `(L + 0.05) / 0.05`, against white `1.05 / (L + 0.05)`; the two cross at
  `(L + 0.05)^2 = 0.0525`, so the better of them is never worse than **4.58:1** on any sRGB colour
  at all. Every hue in the palette and every hue anyone ever appends to it is therefore readable
  with nobody checking. It holds for PURE black and white only -- a near-black tuned to the bar
  looks tidier, still passes on today's sixteen, and silently voids the proof for the seventeenth,
  which is why `test/contrast.test.ts` pins the pair and not just the outcome.
- **`barText` is a floor, not a wash.** Fourteen hues clear 4.5:1 at full strength and come back
  byte-identical; only indigo (10% toward white) and crimson (33%) move. Reusing `shimmer` would
  have been one line, lightened all sixteen, and still promised nothing about a hue added later.

**No library, and the reason is the guarantee rather than a dislike of dependencies.** culori,
colorjs.io, wcag-contrast and apca-w3 were all weighed and none of them ships its own TypeScript
types, in a package whose only `@types/*` is Node's. APCA -- the WCAG 3 draft, and genuinely
better for light text on dark -- changes exactly one answer on this palette: indigo's ink flips to
white. Both clear AA, so it buys a dependency and no readability.

**`pnpm golden` could not have caught any of this**, which is the cleanest example in this repo of
where the capture net ends. `gated/*` pins the bytes of the rendered conf and the hue table, so it
would have recorded the unreadable pair for ever: it says what the colours ARE and nothing about
whether one reads on the other. `test/contrast.test.ts` asserts the arithmetic instead, over the
whole palette, so an unreadable hue appended in future fails `pnpm test` rather than arriving as a
screenshot.

## What the clone bar says, and the four things tmux would not let it say

`generate/tmux-conf.ts`'s `barOptions`, `generate/tmux-status-sh.ts`, `pr-cache.ts` and
`commands/browse.ts`. The bar carries the clone's hue badge, its tabs, then the issue key and the
pull request; the branch is on a line along the bottom of the pane. Everything below was measured
on tmux 3.7c, and four of the measurements are the reason the design is shaped the way it is
rather than the obvious way.

**A window's name is the ROLE alone.** The clone is named by the badge -- a block of colour, which
is what a developer actually finds across four near-identical windows -- and by
`set-titles-string`, for a window in the dock with no bar to read. A third naming in the window
name puts it in every tab beside a badge already saying it, once per `terminal.tabs[]` role.
Nothing looks a window up by name: identity is the session, and every `-t` targets a captured
`#{window_id}`.

### The four refusals, each measured

- **A status line cannot carry an OSC 8 hyperlink.** There is no `link=` style attribute, and a
  literal sequence in `status-left` is drawn as visible text with the `ESC` stripped --
  `L[]8;;https://example.com/T-1\T-1]8;;\` -- with `capture-pane -H` finding no hyperlink at all.
  tmux supports OSC 8 in PANE content only (the `hyperlinks` terminal feature, `mouse_hyperlink`,
  `capture-pane -H`). So a clickable region running a command is the mechanism here, not a
  fallback for one.
- **`#[range=user|X]` works in `status-format` and is silently ignored in `pane-border-format`.**
  Ranges are a status-line feature; the border accepts the style, renders nothing for it and
  fires no `Status` key. That is what splits the bar in two: the short clickable facts belong up
  top, and the long branch belongs on the border, which can only ever be text.
- **A header at the top and a footer at the bottom is unreachable.** `status-position` is one
  option for the whole status block, so `status 2` gives a second line with both at the top.
  `pane-border-status bottom` is the only bottom line tmux has, and it renders with a single pane.
  Its cost is one row of the pane, and one line per pane once a window is split -- so the format
  is wrapped in `#{?pane_active,…,}` and the other panes keep a plain border. **No comma may
  appear inside either arm**: `#{?…}` splits on the first one, so a two-part style like
  `bg=x,fg=y` cuts the format in half and the rest is drawn as text.
- **A `range=user|X` argument is at most 15 bytes**, documented and not reported: a longer one
  simply never fires. `hangar-ticket` is 13. The prefix is not decoration -- it is what the click
  binding tests, so our regions can be told from tmux's own `window`, `session` and `pane` ones.

### The click preserves the key it takes

The default binding for `MouseDown1Status` is `switch-client -t =`, which is click-a-tab-to-switch,
and `MouseDown1Border` is `select-pane -M`. A bare rebinding of either takes that away from every
window in the fleet in order to add a link. So there is one binding and it falls through:

```
bind-key -T root MouseDown1Status if-shell -F '#{m:hangar-*,#{mouse_status_range}}' \
  'run-shell -b "<hangar>/bin/hangar browse #{s/hangar-//:mouse_status_range} #{@hangar_clone}"' \
  'switch-client -t ='
```

`#{m:…}` is a glob match and `#{s/hangar-//:…}` strips the prefix, so **the range name IS the
argument** and there is no table mapping one to the other. `run-shell` expands formats in its
command before running it -- verified, `#{@hangar_clone}` arriving as `clone_01` -- and `-b` keeps
tmux from blocking on a browser. `bin/hangar` by absolute path, because `run-shell` inherits the
SERVER's environment, which is whatever shell started it and need not have direnv's PATH; the same
reason `iterm2.ts` names tmux absolutely.

**The click is the one part of this that calls the CLI**, and it can afford to: a click is a
person, once. Measured on this machine, `bin/hangar --version` costs 0.24-0.28s against 0.02-0.04s
for shell plus git -- so everything the bar REFRESHES is a generated script, and in exchange the
URLs come from `issueUrl` and `prSearchUrl` rather than being spelled a second time in shell.

### The clone comes from the session tag, and that is a correctness property

Each field is a `#(…)` job calling `clone-tmux-status.sh <field> "#{@hangar_clone}"`. The tag is
expanded into the command TEXT rather than the script reading a pane's working directory, for two
reasons and the second is a bug rather than a preference:

- Identity is the session, which is this module's oldest rule. A pane `cd`'d out of the clone is
  still that clone's pane, and `#{pane_current_path}` would have it report nothing -- or, standing
  in a sibling clone's directory, report the sibling's branch.
- **A tmux job is keyed on the EXPANDED command**, so two sessions whose formats expand to the
  same shell command share one job and one answer. With the clone name in the text, `clone_01` and
  `clone_02` rendered their own branches at the same moment on one server (measured, two clients).
  Without something session-specific in there, every bar in the fleet would show whichever clone's
  job ran first.

`#{…}` does expand inside `#()`, with either quoting -- but the format value is single-quoted on
the way into the conf and tmux processes no escapes inside single quotes, so the job uses DOUBLE
quotes around the tag. One `'` in there would end the option's value and leave the rest of the
line as garbage tmux does not complain about.

### The script is generated so the key pattern is not a second definition

`jira.ts` is the authority on what an issue key is, and the script is a second READER of the same
config: the prefixes come from `tracker.keyPrefixes`, so adding one reaches both. What shell
cannot reproduce is `KEY_IN_TEXT_RE`'s lookarounds -- `grep -E` has no lookahead -- so a
tokenising `tr` plus a `^`-anchored match stands in for them. Verified against this fleet's own
branch shapes: `fixes/ABC-1323_x` and `fixes/ui/ABC-1401_y` both answer, `feature/XABC-99_z` does
not (which is exactly what the lookbehind is for), and it differs from `jira.ts` only where a
digit run is followed immediately by a letter.

**With no configured prefixes there is no ticket field at all.** `jira.ts`'s untargeted matcher
leans on a sixteen-entry denylist of key-shaped things that are not keys (`UTF-8`, `SHA-256`), and
its own comment says why: a confident link to a ticket that does not exist is worse than saying
nothing. Reimplementing that list in shell is precisely the "change one, change both" duplicate
the generated script exists to avoid, so the bar stays quiet instead.

Every failure in the script is `exit 0` with nothing printed -- no clone tag, no such directory,
a detached HEAD, no git. A status bar is redrawn every ten seconds in a place nothing can be
dismissed from, so an error message there is worse than a shorter bar. The cost is that a stale
script is SILENT, which is why `doctor` byte-compares it like the conf.

### The pull request is on disk, keyed on the branch

`openPullRequests` is a Bitbucket call with a token and an eight-second timeout, so it cannot be
behind a ten-second refresh at all. It is answered by the commands that were going to ask anyway
-- `sync` resolves a PR's target branch on every run -- and by `hangar browse pr`, which fetches
when the cache is cold and writes what it learns. Neither writes on `-n`.

**Keyed on the branch, which removes the freshness question rather than answering it.** A pull
request's id never changes for a branch, so a line whose branch is not the branch checked out
right now is simply not this branch's pull request and is ignored: no TTL, and the specific
failure ruled out is a clone showing the number of the PR it was on last week. What it does not
rule out is a PR closed and reopened as a new one on the same branch; the next `sync` corrects
that, and `fetchedAt` is recorded so a reader that wants to care can.

One line, space-separated, no JSON: the only reader that matters is generated shell, reading it
with one `read -r` and no `jq`. A JSON parser in a status bar is a dependency whose failure mode
is a bar that has quietly stopped saying anything. Neither a branch name nor a URL may contain a
space, so a space is a separator no value can forge.

A cold or mismatched cache shows a bare ` PR ` rather than nothing, and that is a label rather
than a claim: it links to `prSearchUrl`, which is the branch's pull-request list and is a true
statement whether or not one exists. Without it a cold cache would leave nothing on the bar to
click, and the number could only ever arrive by someone knowing to ask.

### Reaching a server that is already running

`-f` is read ONCE, when the server starts, so all of the above reached nothing that was already
open -- four sessions and eleven windows kept the green bar, and `doctor` could only name
`kill-server`, which it refuses to run because that ends every live agent in the fleet.

It did not have to. Every option the bar needs is a global **session** or **window** option rather
than a server option, so `colours sync` writes them onto the live server, then re-paints each
session's badge through the same `paintSession` builder `open` uses, then each of its windows. That
is the actual line between these and the four settings in `TMUX_SETTINGS`: two of those are server
options, and for them `kill-server` really is the only repair.

**One table feeds both, and it has to.** `barOptions` is rendered into the conf and written onto
the live server by `TmuxServer.restyle`; a list of globals written out in `restyle` beside the
formats written out in the conf would be two half-copies of the same thing, and the symptom is a
bar that is right on a fresh server and a version behind on the one somebody is working in.
`test/tmux-conf.test.ts` asserts every entry reaches the conf, and that no entry is one of
`TMUX_SETTINGS`' server options -- a server option in that table is a setting that reaches the
file and nothing else, with nothing to say which happened.

The **click binding is the exception to the table**, because a key binding is a command and there
is nothing for `set` to carry it. `restyle` issues it as a command for exactly the same reason it
writes the options: a live server would otherwise keep the bar and lose the link.

A window's own `@hangar_colour` tag wins over its session's clone, looked up by hex because
`colours change` means a clone's hue need not be the one its index implies. That is the case the
hook exists for -- a `C-b c` window `cd`d into another clone has already recorded which -- and
repainting a whole session one colour would discard it until the next `cd`. It is skipped on `-n`
and `--check`, being the one thing in that command that touches state outside the artifacts.

`doctor` gets **no** row for any of it. The conf byte-compare already goes red on a stale file, and
`TMUX_SETTINGS` is documented as the four settings Claude Code needs -- growing it with a style
would make `doctor` claim something it was not written to say.

**`send-keys -l -- <text>` then a separate `Enter`.** `-l` is literal, so a word like `Enter`
inside a `SYNC PAUSE` message stays a word instead of becoming a keypress, and `--` guards a
message beginning with a dash. The newline has to be its own call for the same reason `-l` is
used: without it the line sits unsent on the agent's input, which is the worst of the three
outcomes — delivered, and not read.

### Exercised, unlike two of the four window-openers

Konsole and GNOME Terminal ship on documentation alone and their headers say so. tmux does not,
because it is the same program on macOS. Against tmux 3.7c here: a session created per clone with
a window per role, the roles read back in `tabs[]` order, `has-session` answering correctly for a
clone with a session and one without, a second `open` of the same clone raising the existing
session and creating nothing, a detached clone reattached with its shell's scrollback intact, four
sessions carrying four distinct `status-left` hues with no global leak, and a real `SYNC PAUSE`
line landed in the pane on a named tty and -- confirmed with `capture-pane` -- in **no** other of
four. A tty nothing owns returns false, so `sync` reports a miss rather than claiming a pause.

The status bar was exercised on the live fleet with four Claude sessions running throughout and
none disturbed: `colours sync` reported `restyled 4 live tmux session(s)`, and all four badges and
all eleven windows read back with `bg=<hue>,fg=<ink>`. The HOOK's tmux arm was exercised on a
throwaway socket instead -- `tmux -L hangar-probe -f clone-tmux.conf` -- which is also the check
that the conf loads at all: a `cd` into a clone wrote `@hangar_colour=#ffcc00` and the matching
`bg=#ffcc00,fg=#000000,bold`, and that hue's non-current style came back byte-identical to its
main, which is what a floor rather than a wash looks like. The five-field hue table's split was
checked in `sh`, `bash` and `zsh`, because appending to that table is the trap below.

**The trap, since it would have passed every gate.** `clone-colours.sh` prints its fields
positionally and `clone-terminal.sh` split them ending `name=${rest#* }` -- everything after the
second space. Appending `ink` and `barText` therefore landed them INSIDE `$name`, which the hook
exports as `HANGAR_CLONE_COLOUR`: measured, `cyan #000000 #00ccff`. Nothing typechecks a generated
shell string, so the only thing that would have noticed is a developer's own prompt printing a hex
after the colour name. The split is now one uniform pair of steps per field with only the last
taken by `#* `, so a sixth field cannot corrupt the fifth -- and fields are appended, never
reordered, so `$1..$3` stay where anything already reading them expects.

iTerm2 is exercised on this machine, and three of its behaviours are recorded in `iterm2.ts`
rather than here because they are that driver's own: `write text` into a session that was just
created is accepted and dropped, a bare `create tab with default profile` returns `missing
value`, and `command` is argv rather than a shell line -- so `exec` starts nothing and PATH is the
application's, which is why the attach command names tmux by absolute path.
