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
