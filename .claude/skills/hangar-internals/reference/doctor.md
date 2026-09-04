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
clones), `.envrc.private`, the playwright symlink, the theme, the Storybook health-check port,
that `tmp/` is the clone's own directory, the three hooks in
`settings.local.json` (plan collection, the cache merge and the Jira record hook — each repair
re-reads the file, so a clone missing two of them gets both in one `--fix` pass), the sibling
remotes in both directions, and the `checkout.defaultRemote=origin` those remotes make necessary.
Run it after any re-clone. **How much of the shared cache a clone links is deliberately not a
check** — a ticket fetched here reaches the others at the next `tmp merge`, which is what linking
per entry means, and a check that is red in normal operation is a check nobody reads.
(`hangar-ops/reference/reading-output.md` says the same to whoever reads the report — change one
and change both.)

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

## The plan archive, and why sharing it is a command rather than a setting

**Plans cannot be shared by a setting.** Claude Code resolves `plansDirectory` against the project
root and then requires the result to be **inside** that root — a string-prefix test on the resolved
path, with symlinks followed. Anything outside is rejected with `plansDirectory must be within
project root` and the CLI **silently falls back to `~/.claude/plans`**, mixed in with this machine's
other projects. That is not a check to work around: `../plans`, an absolute
`~/code/dvb_gn/plans`, and a `.claude/plans` symlink pointing at the fleet root all fail it the same
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
