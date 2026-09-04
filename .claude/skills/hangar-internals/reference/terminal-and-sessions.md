# One window, and finding a clone's past sessions

`app/src/commands/open.ts` (394), `resume.ts` (235), `app/src/claude-sessions.ts` (310) and
`sessions.ts` (164). The terminal-driver capability table is in `app/CLAUDE.md`; this is what the
two commands do with those capabilities.

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
