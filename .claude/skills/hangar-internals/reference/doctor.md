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
check** — a ticket fetched here reaches
the others at the next `tmp merge`, which is what linking per entry means, and a check that is red
in normal operation is a check nobody reads.

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
