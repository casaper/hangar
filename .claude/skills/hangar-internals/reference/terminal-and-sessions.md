# One window, and finding a clone's past sessions

`app/src/commands/open.ts` (394), `resume.ts` (235), `app/src/claude-sessions.ts` (310) and
`sessions.ts` (164). The terminal-driver capability table is in `app/CLAUDE.md`; this is what the
two commands do with those capabilities.

- **`hangar open` puts every clone in ONE terminal window and reuses whatever is already
  open.** Every part of that is gated on the driver's capabilities (`open.ts:184` `inspect`,
  `:201` `select`, `:370` `openTabs`), and iTerm2 is simply the only driver that has all of
  them — on GNOME Terminal `open` says so once and only appends.
  It finds that window by the user variables it stamps on the sessions it creates, so a
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

**GNOME Terminal's `SYNC PAUSE` refusal is a named `CliError`** (`syncPauseUnsupported` in
`terminal/index.ts`), constructed and printed by `doctor` rather than left as a `false` in a
capability record nobody prints. It is permanent, not an omission: VTE exposes no API for writing
into a running tab and `TIOCSTI` has been off by default since Linux 6.2. `sync` still degrades
correctly — every live session is reported unreachable and it asks before touching the clone —
but the developer learns that at the moment of the sync, which is the wrong moment.

**Two other Linux fixes with no seam of their own.** The `/opt/homebrew/bin/jq` fallback in the
status line was Homebrew on Apple Silicon and nowhere else; when it misses, every `jq` query
returns empty and the badge renders **blank rather than erroring**, which reads as a Claude Code
problem. It is now a six-path search list, duplicated by hand in `.claude/modes/statusline.sh` —
that file is hand-maintained and nothing derives it from `app/src/**`, so fixing only the
generated one leaves the mode badge broken. And `environment.ts`'s install hints take their verb
from the seam (`Tool.pkg` carries the package name, which is almost never platform-specific);
`installHint` is a function rather than a field because `TOOLS` is a module constant, and a hint
baked in at import is the trap `hangar.ts` records.

## The tmux driver

`app/src/terminal/tmux.ts`. The fifth terminal driver, and the only one on Linux that carries
`writeToTty` — which is to say the only one that makes the `SYNC PAUSE` protocol above possible
on a box without KDE. GNOME Terminal cannot be typed into at all, and Konsole needs `qdbus`
installed for anything past opening a tab.

| Hangar           | tmux           | why                                                    |
| ---------------- | -------------- | ------------------------------------------------------ |
| `TerminalWindow` | a **session**  | a session is what a developer looks at and attaches to |
| `TerminalTab`    | a **window**   | tmux windows are the tab bar                           |
| the tag          | window options | `@hangar_*`, tmux's own user-option namespace          |

**The tag is a WINDOW option, not a pane option.** A pane inherits its window's options in a
format lookup, so `list-panes -a -F '#{@hangar_clone}'` reads either — but a tab the developer
*splits* keeps its tag on every pane only if the option lives on the window. Pane options would
leave the new pane untagged, and an untagged pane sitting in a clone is exactly what makes `open`
stop and ask whether some other window is already there.

**`$TMUX` is tested before every emulator signal, and that ordering is the point.** Inside tmux
inside iTerm2, `ITERM_SESSION_ID` is still set — tmux passes the outer environment through — so a
scan that reached iTerm2 first would drive the wrong layer: a new iTerm2 *tab* beside the
multiplexer, and a `SYNC PAUSE` typed into whichever pane happened to be showing rather than the
one holding the session. tmux is also first in `PROBE_ORDER` on both platforms, kept honest by an
`isAvailable` that demands a running **server** and not just the binary: windows in a session
nobody is attached to are `open` succeeding while the developer sees nothing.

**`isAvailable` demands an ATTACHED CLIENT, not just a running server**, and that distinction is
the whole check. A leftover detached session — started for something else and abandoned — makes a
server-only test answer "available", and this driver is probed first on both platforms. `hangar
open` from somewhere the environment cannot identify (VS Code's integrated terminal, a hook, a
`claude -p` child) would then create a session nobody is looking at, `switch-client` would fail
with `no current client`, and `open` would report success while the developer saw nothing —
precisely the failure the check exists to prevent, through the one condition an earlier version of
it did not test. `list-clients` exits 0 with **empty output** when nothing is attached, so the
output is the answer and not the exit code; both directions were verified here. Tightening it
cannot break the case tmux exists for: running inside tmux sets `$TMUX`, which `resolveTerminal`
answers from the environment and never consults `isAvailable` for.

**No fleet session yet means a DETACHED one plus `switch-client`.** Detached is the only kind a
subprocess can create — tmux attaches *clients*, and `hangar` is not one — and `switch-client`
works precisely when `hangar` was run from inside tmux, which is when this driver gets chosen.
Outside it, tmux reports `no current client` and the call is a no-op: the windows exist, they are
just not brought forward, and `tmux attach -t hangar-<id>` finishes the job. The window
`new-session` unavoidably creates *becomes* the first tab rather than being left beside it — a
spare untagged window sitting in a clone is the foreign window `open` is built to be suspicious
of.

### The colour lives in the shell hook, and every `set -w` names `$TMUX_PANE`

**tmux had no colour at all until it was asked about.** `generate/terminal-sh.ts` sent `$TMUX`
down its `title` family, on the reasoning that the emulator sequences would need DCS passthrough
and that pane colour is tmux's own business -- so the one driver with the full capability set on
Linux offered the `env` layer and nothing else, which needs the developer to write their own
status-line format before anything is visible.

It is fixed in the **hook**, not here, and the driver still declares `paintOnCreate: false`. That
is now a positive statement rather than a gap. Two reasons, and the second is the one that
decides it:

- A driver only paints tabs `hangar open` created; the hook paints whatever `$PWD` is in, so a
  window made with `C-b c` is coloured too. That is the same argument `TerminalCapabilities`
  already makes for every emulator except Terminal.app.
- The value a `paintOnCreate` driver receives is the **tinted background** (`commands/open.ts`),
  because that is the surface Terminal.app paints. A tmux window-status entry wants the full hue,
  so routing tmux through the seam would mean carrying two colours through it for one consumer.

The hook sets five window options -- `@hangar_colour`, `window-status-style`,
`window-status-current-style`, and both pane border styles. All five were confirmed settable per
window on tmux 3.7c, confirmed not to leak into a sibling window, and confirmed to clear with
`set -uw`. `-u` rather than writing a literal default, so two hangars sharing one server restore
each other's values instead of flattening them; never `-g`, which would have the last clone
entered recolour every window of both.

**`-t "$TMUX_PANE"` on every call, and it is load-bearing.** `set -w` with no target is the
session's ACTIVE window, not the window the calling shell is in. Without it, two clone windows in
one session got this: entering `clone_02` in window 1 put `clone_02`'s hue on **window 0** and
left window 1 with none. A pane id is a legal target for a window option and resolves to that
pane's own window, so the fix costs no extra exec -- tmux sets `TMUX_PANE` in every pane, and it
keeps working from a split, which is the same property that put the `@hangar_*` tags at window
scope above. This was found by opening two windows in one session and reading the options back,
which is the only way it shows up: with a single window the wrong target and the right one are
the same window.

`window-status-current-style` is set alongside `window-status-style` because they are different
options -- the first styles a window that is not current. With only the second, the clone you are
actually looking at is the one window with no colour.

**`send-keys -l -- <text>` then a separate `Enter`.** `-l` is literal, so a word like `Enter`
inside a `SYNC PAUSE` message stays a word instead of becoming a keypress, and `--` guards a
message beginning with a dash. The newline has to be its own call for the same reason `-l` is
used: without it the line sits unsent on the agent's input, which is the worst of the three
outcomes — delivered, and not read.

### Exercised, unlike its two Linux neighbours

Konsole and GNOME Terminal ship on documentation alone and their headers say so. tmux does not,
because it is the same program on macOS: against tmux 3.7c here, `openTabs` created a detached
session and tagged its windows, `pickFleetWindow` found it and a later tab appended to it,
`windows()` read the tags back and reported a bystander session as untagged, re-tagging one
window `@hangar_id other_hangar` made it read as foreign, `select` moved the active window to the
named clone's `claude` tab and returned false for a clone with no tabs, and a real `SYNC PAUSE`
line landed in the pane on the named tty and — confirmed with `capture-pane` — in **no** other.
A tty nothing owns returns false, so `sync` reports a miss rather than claiming a pause.
