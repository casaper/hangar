# `doctor`, and the two rules for anything generated into a clone

`app/src/commands/doctor.ts` (777) and the builders in `clone-config.ts` (493) it compares against.
Also the plan archive, because `plansDirectory` is the setting `doctor` checks and cannot fix.

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
clones), `.envrc.private`, **one row per `repo.symlinks[]` entry** (printing that entry's `why`
when it is missing), the theme and whether the file it names resolves, **one health-check allow per
port role that declares one**, one declaration-only row per `repo.install[]` step, that `tmp/` is
the clone's own directory, the three hooks in `settings.local.json` (plan collection, the cache
merge and the ticket record hook — each repair re-reads the file, so a clone missing two of them
gets both in one `--fix` pass), the sibling remotes in both directions, and the
`checkout.defaultRemote=origin` those remotes make necessary. Above the clones it also holds the
hangar's own generated `CLAUDE.local.md` and `.claude/settings.json` to their renders, reports
`secrets.variables[]` against the shared secrets file, reports the two mode settings files
without repairing them, and migrates a legacy `colour-assignments.json`.
Run it after any re-clone. **How much of the shared cache a clone links is deliberately not a
check** — a ticket fetched here reaches the others at the next `tmp merge`, which is what linking
per entry means, and a check that is red in normal operation is a check nobody reads.
(`hangar-ops/reference/reading-output.md` says the same to whoever reads the report — change one
and change both.)

## The `secrets` row, and the one gap `--fix` structurally cannot close

`secrets.variables[]` is a list of `{name, why, optional}`, and `doctor` reports each declared
name against what the shared secrets file actually sets. `src/secrets.ts` holds the pure half:
`secretVariableStatuses` takes the declaration and the file's TEXT — never a path — so every
state can be asserted without a mode-600 file full of live credentials on disk, which is the only
way this is testable at all. The value never leaves that module; callers get a three-state enum,
so no report, log or golden capture can grow a credential in it by accident.

**Why the key exists.** `secrets` used to be `file` + `mode`, so a hangar could say WHERE the
credentials live and never what has to be in them. `setup` scaffolds the names Hangar itself uses
— `forge.tokenEnvKey`, the tracker pair — because those come from keys it already has; everything
the REPO's own tooling reads is invisible from up here. This fleet's Playwright suite reads
`USER_READWRITE_PASSWORD`, the tracked `tests/playwright-regression-tests/.env` sets it EMPTY, and
direnv loads that file AFTER the shared secrets. That is the entire reason `repo.symlinks[]`
reloads them, and the entire content of that symlink's `why`. But nothing ever told a NEW hangar
to put the variable in the file, so a colleague's first fleet came up with the symlink created,
`doctor` green, and Playwright logging in with an empty password — the exact failure the symlink
exists to prevent, reproduced by leaving the declaration out.

Three decisions in it:

- **`empty` is a distinct state from `absent`, and that distinction is why `setup` writes its
  scaffold commented out** rather than as `NAME=`. A set-but-empty variable is indistinguishable
  from a real one to everything downstream: an empty `BITBUCKET_TOKEN` makes `sync` send an empty
  bearer token and report a 401, and an empty password makes Playwright fail a login rather than
  say it was never given one. Folding the two together would hide the worse of them.
- **`why` is required**, for the reason `repo.symlinks[].why` and `repo.install[].why` are: a
  variable name explains what breaks without it no better than a symlink does, and that string is
  the whole content of the row.
- **`optional: true` renders dim rather than red**, because a hangar whose owner never runs the
  Playwright suite must not have a permanently red `doctor`. A hangar declaring nothing gets no
  row at all — silence beats `0 variables declared` for the majority that never fill this in.

There is no `repair`, and it is the one check here where that is structural rather than a
choice: a credential cannot be derived from the clone index the way a port, a theme or an
identity file can. Everything else `doctor` reports outside git is recoverable from the formula;
this is the only thing a human has to supply. Which makes it worth a row precisely because it is
the row `--fix` will never close. (`hangar-ops/reference/reading-output.md` says the same to
whoever relays the report — change one and change both.)

## The install checks report a declaration and never execute it

`repo.install[]` is the one thing Hangar runs INSIDE a clone that can destroy work: this repo's
step is `npm ci`, which deletes `node_modules` before refetching it. So "doctor replays the same
step list as checks" — a sentence a plan could easily leave in — would have `hangar doctor` wipe
four clones' installs while their dev servers were serving, every time somebody asked whether the
fleet was healthy.

`installChecks` in `app/src/install.ts` therefore asks only what the filesystem can answer:

- does the step's `dir` exist in this checkout (a missing one is red unless the step is `optional`)
- if the manager leaves a marker INSIDE the clone, is it there

`INSTALL_MARKERS` (beside `MANAGER_COMMANDS`, so the fourteen managers and their markers cannot
drift into two files) is **deliberately partial**, and the gaps are the honest part. The four
JavaScript managers write `node_modules`, `uv` writes `.venv`, `composer` writes `vendor`. Maven,
Go, cargo, pip, poetry, gradle, deno and bundler put the result in a cache outside every clone and
shared between them, so no per-clone path could answer for those. A step with no marker gets a
`Check` with `ok: true` and `unverified: true`, which renders **dim rather than green** — because a
row that reads like a verified pass while verifying nothing is worse than one that says it cannot
tell, and inventing a marker for maven would make `doctor` permanently red on a correctly
installed clone.

Executing a step is `hangar install <clone>`, which a human types, and deliberately NOT a
`doctor --fix` repair: one entry point to a package manager in a live clone is safer than two, and
`--fix` is the pass people run without reading. `doctor` names the command instead.

**`nodeVersionFile` is honoured under either version manager, and the fallback says so.** It used
to call `fnm exec --using=<v>` when fnm was on PATH and otherwise run the command bare, silently
— while the README promised "either `fnm` or `nvm`" and `setup`'s environment row printed
`found (of fnm / nvm)` for an nvm-only machine. So an nvm user's first `add-clone` ran `npm ci`
under whatever `node` was first on PATH, which at a hangar root is the HANGAR's pinned Node and
not the app's. Nothing said a word, and this fleet's two pins agreeing (`24` and `24.20`) was
luck rather than design.

`nodeBinDirFor` asks fnm first, because it is a binary and answers in one spawn, then nvm — which
is a shell FUNCTION and so has to be sourced in a subshell before `nvm which` can be asked
anything, the same trap `.envrc.hangar` documents beside `hangar_use_node`. The resolved directory
is PREPENDED to `PATH` rather than going through `fnm exec`, because that is the one form both
managers can express: nvm has no `exec`. Nothing here INSTALLS a Node version — unlike
`hangar_use_node`, which does — because an install step is not the place to spend four minutes
fetching a toolchain nobody asked for. And with neither manager present the command still runs on
whatever Node is there, because a missing version manager is a worse reason to refuse an install
than a version mismatch is. It now warns first, which is the whole change: the fallback was
always defensible, and being silent about it was not.

**The nvm branch is written from nvm's documented interface and has not been run against a live
nvm** -- the same caveat the Konsole and GNOME Terminal drivers carry, and for the same reason:
this machine has fnm, so that branch is only ever reached on a machine that does not. What is
verified is that the probe fails silently and cleanly with nvm absent (exit 1, nothing on either
stream), so an fnm-only machine pays nothing for it. If you have nvm, `hangar install <clone> -n`
will not tell you -- the dry run never spawns -- so the thing to check is that a real
`hangar install` reports the app's pinned version and not the hangar's.

## The plan archive, and why sharing it is a command rather than a setting

**Plans cannot be shared by a setting.** Claude Code resolves `plansDirectory` against the project
root and then requires the result to be **inside** that root — a string-prefix test on the resolved
path, with symlinks followed. Anything outside is rejected with `plansDirectory must be within
project root` and the CLI **silently falls back to `~/.claude/plans`**, mixed in with this machine's
other projects. That is not a check to work around: `../plans`, an absolute
the hangar's own `plans/`, and a `.claude/plans` symlink pointing at the hangar root all fail it the same
way. An absolute `~/.claude/dvb-gn-plans` was configured in all three clones and did exactly that,
unnoticed, for a day.

Dates come from the filename, then the file's own birthtime/mtime, then the first transcript that
mentions it. **`stat` alone is not trustworthy here:** an earlier consolidation copied 157 plans
without preserving times, so they all carry one identical second, and Claude Code's atomic rewrite
resets birthtime on a plan it is still editing. `plans collect` detects a bulk-copy timestamp (many
files, same second, birthtime == mtime) and refuses to use it, then writes the date it resolved
back as the file's mtime so it survives.

One consequence to expect: `/resume` on an older session will not find its plan file where it left
it. Claude Code logs `Plan file missing during resume` and reconstructs the plan from the message
history, so it degrades rather than breaks.

## Two checks exist because Claude Code fails these silently

`doctor` compares each clone's `theme` against the name the generator would produce, which goes
red correctly after a rename. What it did NOT do until F6 is assert the target is on disk -- and
that is the difference between a red row and no row at all. **Claude Code falls back to the
default theme for a name it cannot resolve, and says nothing**, so a rename without a repair
leaves the whole fleet identically coloured -- the exact failure the colours exist to prevent --
and it surfaces at the next session start rather than when the rename happened. A
`statusLine.command` pointing at a path that is not there behaves the same way: the status line
just stops.

So `settings targets` reads the `theme` and `statusLine.command` **out of the settings file**
rather than from the generator, so a hand-edited value is caught too. It has **no repair**: a
file naming a missing artifact is a different problem from the artifact being absent, and
`colours sync` is what writes artifacts.

This is also why renaming anything under `~/.claude` is a three-phase operation and not an edit:
write the new names BESIDE the old, repair the settings that point at them, and only then delete
the old ones -- each phase reversible on its own, and `settings targets` green throughout.


## `defaultSettings`, and the line between derived and personal

`add-clone` used to copy a sibling's `.claude/settings.local.json` wholesale and THROW when there
was no sibling, which is the only reason the README told a stranger to create clone #1 by hand —
the one step nobody can be talked through, in the command whose entire job is to spare them it.

A sibling is still preferred, and that is not a fallback ordering. The split is:

- **Derived, in `defaultSettings`**: `Read(<hangar root>/**)`, `Read(<secretsFile>)` in `deny` (an
  ABSOLUTE path, because the secrets file sits outside every clone so no clone can commit it —
  which also means no clone-relative rule can reach it), one health-check allow per role that
  declares one, the three hooks through the same `with*Hook` writers a `doctor --fix` repair uses,
  `statusLine.command`, `autoMemoryDirectory` and `theme`. Every one is a function of the hangar
  and the clone index, and every one lives outside git.
- **Personal, and so sibling-copy-only**: `enabledMcpjsonServers`, `enabledPlugins` and the
  `terminal.*` keys. Emitting those as defaults would ship one machine's seven MCP servers into a
  stranger's fresh hangar, where none of them resolve — a config that looks configured and is not,
  which is the failure this whole track is about.

`settingsContentFor` regenerates the derived half on top of either template, so the two paths
cannot disagree about a theme or a port. Both renders are in the golden capture
(`settings.local.json` from the fixed template, `settings-default.json` from nothing) because they
answer different questions: what `settingsContentFor` does to a file it was handed, versus what a
hangar can derive from nothing at all.

**`HangarPaths.memory` is `~/.claude/<id>-memory` by the naming rule, and this hangar's four live
clones still name `dvb-gn-memory`.** That predates the rule and is where the fleet's actual memory
is. Nothing renames it: moving live memory needs the tracked `.claude/settings.json` and four
per-clone files moved with it plus a session restart each, and only `defaultSettings` — a hangar
with no sibling — reads the path today, so leaving it splits nothing.
