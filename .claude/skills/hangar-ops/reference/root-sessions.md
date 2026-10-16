# Sessions at the hangar root

How a session started at the hangar root differs from one in a clone, and how `CLAUDE.md` reaches
each. It is kept out of the root `CLAUDE.md` because every clone session loads that file and none
of them can act on this.

## Parent-session scope

A session started at the hangar root is for fleet-level work only: running `hangar`, comparing
clones, looking at the layout, editing the root `CLAUDE.md`. No project agents, hooks or permission
rules load. Its `.claude/` holds a **generated** `settings.json` — pointing `autoMemoryDirectory`
at the shared hangar memory and `plansDirectory` at `plans/`, so a hangar-root session writes
straight into the shared archive, plus a `statusLine` that badges the window with which of the two
hangar-root **modes** it was launched in (a red `NO MODE` when it was launched in neither). Beside
it are two skills: **`hangar-ops`** for driving the CLI and **`hangar-internals`** for changing it,
and a `modes/` directory holding what a bare `claude` at the root or in `app/` hands to Claude
Code, through `.local/bin/claude`.

**Neither skill reaches a clone session**, and neither does that settings file. Skills load from
the start directory and every parent only as far as the **repository root**, and each clone is its
own repo; settings and hooks are not walked up at all. Because the parent is its own repo,
`git log` here and in a clone are unrelated histories.

There is an `.envrc` here too. It puts this hangar's `bin/` and the CLI's own toolchain on PATH
(see `app/CLAUDE.md`) and does **not** reach the clones — direnv loads the nearest `.envrc` only,
and every clone has its own — which is why each clone repeats the same `PATH_add` in its untracked
`.envrc.private`.

**Do not run project work from here.** The repo's own build, test and lint commands and its skills
all need a clone's root as the working directory; start a session in the clone instead. The port
script's silent wrong answer from here is in `reading-output.md`, under `hangar ports`.

Session history and memory are keyed differently, which is worth knowing before you go looking for
either:

- **Transcripts** are keyed to the **working directory** a session was started in — a session
  started in a clone's subdirectory lands in its own `~/.claude/projects/` entry and will **not**
  appear in a `/resume` run from the clone root. `hangar resume <clone>` lists every one of a
  clone's transcript directories in one picker, which is what it is for.
- **File-based memory** is keyed to the **git repository root**, so every session in a clone —
  including ones started in a subdirectory — shares that clone's one memory directory. The clones
  are separate repos, so each gets its own memory directory unless `autoMemoryDirectory` is
  pointed at a shared path.

A parent session has its own transcript directory, so it sees no clone's history in `/resume`.
Operator mode **does** see the shared memory — the generated `.claude/settings.json` points
`autoMemoryDirectory` at the same per-hangar directory every clone uses, so a memory written there
is immediately visible in every clone and vice versa; `MEMORY.md` is one shared index with no
locking, so append a line to it, never rewrite it wholesale. Developer mode does not: its working
directory is `app/`, which that settings file does not reach, so its CLI-maintainer memories stay
out of every clone session.

## How the root `CLAUDE.md` reaches the clone sessions

Claude Code loads `CLAUDE.md` (then `CLAUDE.local.md`) from the working directory **and every
directory above it**, ordered filesystem-root-down. There is no repository boundary. So the root
`CLAUDE.md` and the generated `CLAUDE.local.md` beside it are prepended to the context of every session started in a clone,
whether or not anyone asked for it — which is exactly why they stay short, say nothing about the
application, and do not repeat each other. Every line in either is paid for once per clone and
cannot be branch-specific.

Note that this ancestor walk is specific to `CLAUDE.md` and `CLAUDE.local.md`. It does **not**
apply to `.claude/settings.json`, `.mcp.json`, hooks, agents or skills — those come from the
clone's own repo root (skills walk up only as far as it). So neither the parent's settings file nor
its two skills reach a clone session.

One exception, and it is what keeps the root `CLAUDE.md` short: a `CLAUDE.md` in a SUBdirectory is loaded
lazily — the first time a session reads a file anywhere beneath it — and then stays for the rest of
the session. That is why the CLI's own guidance lives in `app/CLAUDE.md`: a clone session and a
session that only runs `hangar` commands never load it, and a session editing `app/src/**` gets it
without asking. `/context` lists which memory files actually loaded.
