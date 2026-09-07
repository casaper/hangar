# The clones' colour identity

The colour is not decoration — it is how the developer tells near-identical terminal windows apart,
and an agent that does not know which clone it is in is the failure this fleet is most prone to. It
is wired the same way in every clone and none of it is in git (it cannot be:
`.claude/settings.json` is tracked and shared, so a colour set there would apply to every clone for
every developer).

What `hangar colours sync` writes, and how the hues are derived from `src/palette.ts`, is in
`app/CLAUDE.md`. This file is the part a user asks about.

## Changing a colour

To change what a hue LOOKS LIKE, edit `src/palette.ts` and run `hangar colours sync`. To give
one clone a different hue, `hangar colours change 4 red` — that is the only per-clone value in
the fleet that is not a pure function of the index, so it is remembered in
`.hangar/colour-assignments.json` (sparse: a clone that was never re-coloured is not in it,
which is why `add-clone` and `remove-clone` still need no bookkeeping). It is **not tracked, and
nothing regenerates it** — the one file in the fleet that is both. `hangar colours change` is its
only writer, and a hangar from before the move keeps its root-level copy read (permanently) until
`hangar doctor --fix` moves it forward. The command
rebuilds everything that names the colour, which is the reason it exists rather than being three
manual edits: the four generated artifacts, the clone's `.claude/settings.local.json` (it selects
the theme by NAME, and a theme that no longer exists makes Claude Code fall back to the default
one — the clone then looks like every other clone) and its `CLAUDE.local.md` (which tells the
agent which colour to announce). It also deletes the theme file for the old hue, which is named
after it and would otherwise linger. Picking the hue the index formula would have given clears
the assignment instead of writing one, so going back is the same command; a hue a sibling already
has is refused unless you pass `--force`, and `hangar doctor` reports it if you do.
`hangar colours list` paints the whole palette with who holds what.

## Where the colour actually shows

The **status line** is the reliable signal: it shows the clone colour in every permission mode.
The theme's input-box border only does so in Manual mode, because `promptBorder` is mode-specific
(auto mode uses `warning`, plan mode `planMode`, accept-edits `autoAccept`) and those are
deliberately left alone — permission mode is safety information and must stay readable.

A theme change needs a Claude Code restart in that clone before it shows up.

## The terminal colour hook

The same hues colour **the terminal** whenever the shell's `PWD` is inside a clone (any
subdirectory included), via `clone-terminal.sh` here. It is a `chpwd` hook (zsh) or a
`PROMPT_COMMAND` entry (bash), not a direnv hook, deliberately: direnv only fires on entering or
leaving a directory that has an `.envrc`, redirects that file's stdout, and has no notion of
"left the fleet entirely", so escape codes emitted from `.envrc` would be both fragile and
incomplete. direnv owns the environment; the shell owns terminal I/O. The hook resets only what
it set, so a tab coloured by hand is left alone — and so that two hangars sourced into one shell
do not undo each other.

It paints **three independent layers**, because the emulators support wildly different amounts:

| layer  | how                                    | where                                        |
| ------ | -------------------------------------- | -------------------------------------------- |
| chrome | `tmux set -w` window options, full hue | every window `hangar open` creates           |
| chrome | iTerm2's OSC 6 tab colour, at full hue | iTerm2, in a shell outside tmux              |
| chrome | OSC 11 background, darkened to a tint  | Konsole, GNOME Terminal/VTE, xterm, kitty, … |
| chrome | nothing at all                         | Terminal.app, which ignores OSC 11           |
| title  | OSC 0 (plus OSC 30 for Konsole's tab)  | everywhere recognised                        |
| env    | `HANGAR_CLONE*` variables              | everywhere, with no terminal support at all  |

The **env layer is the floor** and the reason this works on terminals nobody has thought about: a
prompt or a starship config can colour itself from `HANGAR_CLONE_SGR` (a real escape sequence,
24-bit or 256-colour depending on `$COLORTERM`) with no emulator co-operation. The others are
`HANGAR_CLONE`, `_RGB`, `_HEX`, `_X256`, `_COLOUR` and `HANGAR_ID`.

The background is a **tint** (`terminal.colour.tint`, 16% by default), not the hue: a saturated
colour behind text is unreadable. iTerm2 and tmux escape this because they colour a tab and a
window-status entry, where full strength is exactly right. On an **unrecognised** terminal the
chrome and title layers are skipped entirely — a stray escape in someone's output is corruption,
not colour. If your terminal ignores the OSC 111 reset, set `HANGAR_TERM_BG` to your real
background and the hook restores that instead. **Terminal.app understands neither sequence**, so
a plain shell there gets the title and env layers only -- and a Hangar window there is not a plain
shell, it is a tmux client, where the chrome comes from tmux's window options like everywhere
else.

**Under tmux the hook sets five window options** rather than emitting escapes, which tmux would
swallow: `@hangar_colour` plus `window-status-style`, `window-status-current-style` and both pane
border styles. So a clone shows up in tmux's own status line and on its pane borders, and it
works for a window you made yourself with `C-b c`, not only one `hangar open` created. They are
**window**-scoped and cleared with `set -u`, so a window you `cd` out of restores what it had and
nothing leaks into a sibling. `tmux show -w` is how to see what painted a window.

The status line's own left segment is the one piece `hangar open` paints, at SESSION scope when it
creates a clone's session: the bar has to be right the instant the window attaches, which is
before any shell has printed a prompt. So a clone's tmux status bar carries its name in its hue
from the first frame, and the windows inside it get theirs from the hook on the first `cd`.

The windows `hangar open` creates live on Hangar's own tmux socket, `tmux -L hangar-<id>`, one
session per clone. That is where to look when a window is open but not in front, or when the
emulator was closed and the session is still running: `tmux -L hangar-<id> ls`, then
`tmux -L hangar-<id> attach -t '=<clone>:'`. The socket is private, so the tmux you run for your
own work never sees any of it -- and a bare `tmux ls` will not find these.

`hangar doctor` reports which emulator was detected and what the tmux server is doing, whether an rc actually sources
the hook, and — the trap worth knowing — **whether an rc names a file under this hangar that no
longer exists.** The idiomatic `[ -r X ] && . X` guard means a renamed artifact fails _silently_:
the colours simply stop, with nothing anywhere to say why.
