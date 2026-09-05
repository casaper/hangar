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
the machine's required tooling, reports the shared secrets file and the variables expected in it
(**creating the file** under `--fix`, never its contents), warns when a declared
`editor.rootPathKeys` table has no file in any clone to apply it to, reports the two mode settings
files without repairing them, and migrates a legacy `colour-assignments.json`.
Run it after any re-clone. **How much of the shared cache a clone links is deliberately not a
check** — a ticket fetched here reaches the others at the next `tmp merge`, which is what linking
per entry means, and a check that is red in normal operation is a check nobody reads.
(`hangar-ops/reference/reading-output.md` says the same to whoever reads the report — change one
and change both.)

## Six literals from this repo that were being written into every hangar

The builders in `clone-config.ts` render text a clone session READS as authoritative, and six
values in it named the repo Hangar was built in rather than the repo it was pointed at:

| was | is now | why it was invisible |
| --- | --- | --- |
| `node dev/ports.mjs` (×2) | `portCheckHint(hangar)` | `repo.portCheckCommand` was a schema key nothing read |
| `clone_NN/` | `clones.prefix` + `<NN>` | `clone_` is also the schema DEFAULT prefix |
| `.env.local` | `repo.cloneEnv.file` | `.env.local` is also the schema DEFAULT filename |
| `tmp/ABC-1234/ticket_ABC-1234.md` | `exampleIssueKey(hangar)` | no hangar but this one has `DN-` keys |
| "each cached **Jira** record" | branched on `tracker.kind` | a trackerless hangar has no record store at all |
| `<clone_NN>` in `clone-colours.sh` | `<clone>` | a usage placeholder, beside a line already saying `"$clone"` |

**Each was surrounded by derived output, which is what made them read as derived.** A session in
`clone_02` told to run `node dev/ports.mjs` is being told to run a script that does not exist, by
the one file whose whole job is to stop it guessing a port — and the failure is a session that
believes a wrong number, not an error.

They survived because the gated golden baseline used to include a capture of THIS hangar, where
all six are correct. **The second fixture is what found them, on its first run**: two configs that
disagree with each other make a literal visible the moment one of them contradicts it. Two of the
six could not have been found by a fixture that agreed with a schema default — `clone_` and
`.env.local` ARE the defaults, so only a config that overrides them shows the difference. That is
the reason `test/generic-text.test.ts` builds its hangar from a config disagreeing with this
repo's *and* with the defaults, and asserts the six literals appear in no generated text: a golden
capture proves what the bytes ARE, and this proves what they may never contain.

**`portCheckHint` degrades rather than omitting.** With no `repo.portCheckCommand` it names
`hangar ports`, which is always on PATH — correct, but it answers for the FLEET rather than for
the clone you are standing in, since only the repo's own resolver reads that clone's dotenv
through direnv. Naming the weaker command is better than naming none: the sentence exists to stop
somebody typing a literal port number.

## The `secrets` row, and the one gap `--fix` structurally cannot close

`secrets.variables[]` is a list of `{name, why, optional}`, and `doctor` reports each expected
name against what the shared secrets file actually sets. **Expected is derived PLUS declared**:
`hangarOwnSecretVariables` turns the config's own answers into rows — the forge token named by
`forge.tokenEnvKey` whenever the origin parses as a Bitbucket URL, and the Atlassian pair when
`tracker.kind` is `jira` — and `expectedSecretVariables` merges the declared list on top, where a
matching NAME wins outright so a hangar can make its forge token red rather than dim.

**That derivation closed the gap the declaration alone left open.** The paragraph below explains
why `secrets.variables` exists at all; what it did not say is that `setup` scaffolding Hangar's
own names into the FILE is not the same as `doctor` checking them. This fleet declared exactly
one variable, so `doctor` was silent about `BITBUCKET_TOKEN`, `ATLASSIAN_USER_EMAIL` and
`ATLASSIAN_API_TOKEN` — three of the four credentials it actually uses. `sync` names its missing
token at the point of use and the tracker path names nothing, so a colleague who copied this
hangar's committed example config inherited the silence with it. Deriving them means no hangar
has to restate its own config to get the row, and `optional: true` on all three keeps `doctor`
green for a hangar whose owner never syncs: each degrades visibly rather than breaking.

**`usesBitbucket` in `bitbucket.ts` is the one place that decides whether this hangar talks to
Bitbucket**, and it exists because three callers were each deciding it differently: `repoRef`
parsed the origin URL and ignored `forge.kind` entirely, `setup` used
`originUrl.includes('bitbucket.org')` (a substring test `notbitbucket.org.example.com` passes),
and the token reader hardcoded the literal `BITBUCKET_TOKEN` — so **`forge.tokenEnvKey` was a
config key nothing read**. A hangar naming a different variable got a `sync` that looked for
`BITBUCKET_TOKEN`, did not find it, and reported the target branch as a guess. `DEFAULT_BITBUCKET_TOKEN_ENV_KEY`
is now the single literal, on the `DEFAULT_EDITOR_KIND` precedent. `src/secrets.ts` holds the pure half:
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

**The FILE is repairable even though its contents are not.** A row above the variables reports a
shared secrets file that does not exist, and `--fix` writes the same commented-out scaffold
`setup` writes — through the same `secretsFileContent` builder, which now takes the variable list
rather than `Answers` so the two cannot drift. `setup` was the ONLY thing that had ever created
that file, and README's fastest way into a fleet somebody else configured is "copy the example
config and stop", which never runs `setup`; running it afterwards answers "already exists and is
valid" and stops, and `--force` rewrites the config. So there was no route to the one file every
credential lives in, and each clone's `.envrc.private` loads it with `dotenv_if_exists` — an
absent one loads nothing and says nothing. Creating it is not deriving a credential. Both writers
pass `{ mode: 0o600 }` on the create rather than chmod-ing afterwards: between the two syscalls a
world-readable file sits where credentials are about to go. When one `--fix` run both creates the
file and reports every variable unset, the note says so, because two rows reading as contradictory
findings is how a correct report gets ignored.

There is no `repair` for the CONTENTS, and it is the one check here where that is structural
rather than a choice: a credential cannot be derived from the clone index the way a port, a theme
or an identity file can. Everything else `doctor` reports outside git is recoverable from the formula;
this is the only thing a human has to supply. Which makes it worth a row precisely because it is
the row `--fix` will never close. (`hangar-ops/reference/reading-output.md` says the same to
whoever relays the report — change one and change both.)

## `--fix` runs to the end, and a symlink is judged on where it POINTS

Two bugs in one report, both found by walking a colleague's first day, and both about the same
`repo.symlinks[]` row.

**`resolveLink` used `realpathSync` alone, which throws on a dangling link.** The one symlink this
fleet declares targets the shared secrets file, which does not exist in a hangar nobody has run
`setup` in — so a perfectly correct link answered `undefined` and was reported as a different link
entirely: `expected a symlink resolving to <root>/.env.shared, found ../../../.env.shared`, of a
link that lands exactly there. `realpathSync` stays FIRST, because it is the only one that
resolves a symlinked path COMPONENT (a hangar reached through `/tmp` -> `/private/tmp`); the
lexical `resolve(dirname, readlink)` is the fallback when it throws. Creating an empty
`.env.shared` turned the row green with no change to the link, which is what proved it.

**The repair call was not wrapped, inside two loops.** `check.repair()` sat bare in the per-check
loop inside the per-clone loop, and the symlink repair refuses by design when something
unexpected is already at the path — refusing throws a `CliError`, which propagated out of both
loops. So `hangar doctor --all --fix`, the last command the README's walkthrough tells a new
hangar to run, printed one error and stopped, leaving the ports, hooks, remotes and themes of
every remaining clone unvisited with nothing saying they had been skipped. Deleting the link and
re-running recreated the identical link, reported it repaired, and called it broken again on the
next run: a closed loop nothing in the output explained. A refusal is information about ONE
artifact; it is now reported where that artifact's row would have been and the run continues.
`--fix` is the pass people run without reading, so the one thing it must not do is quietly do
less than it says.

## Two checks that exist because the peer path skips `setup`

`hangar setup` is where the machine's tooling is proved and where the secrets file is created, and
README's fastest way into a fleet somebody has already configured routes around it entirely. Both
of these are the same structural finding, presented as two rows because they fail differently.

- **The `tooling` row.** `inspectEnvironment` had exactly one caller, `setup` — so the check
  README introduces with "hangar setup checks all of this for you" never ran for the people that
  sentence was written for. `doctor` reports it and never throws, prints ONE green line rather
  than a row per tool (a dozen green rows every run is a wall people learn to scroll past), and
  leaves the recommended tools to `setup`, which is where you are choosing what to install.
  `lsof` is the one that matters most and looks optional: without it nothing attributes a process
  to a clone, and every resulting failure looks exactly like an idle machine.
- **`homebrew` now asks `brew --prefix`** between `HOMEBREW_PREFIX` and the `/opt/homebrew`
  default, and that was a precondition for the row rather than scope creep. `brew shellenv` is in
  the Apple-silicon install instructions and was not in the older Intel one, so an Intel Mac with
  Homebrew at `/usr/local` very often has the variable unset — and `setup` then refused to
  continue on a machine that has Homebrew. `.envrc.hangar` still has the same two-step fallback
  and fails the same way; that one is unfixed.

## An editor's `rootPathKeys` with no file to apply them to

`editor.rootPathKeys` is the config half of the only per-clone TEXT transform in this CLI, and
`reportEditor` now warns when the table is declared and NO clone has the file those keys live in.
An empty table was already handled (it means "no setting here holds an absolute path", true of
most repos); this is the opposite case, and it is what a colleague copying a committed example
config gets. `.vscode/settings.json` is untracked and personal — only `launch.json` and
`tasks.json` are in git — so a fresh fleet has none of it, `ide vscode sync` answers "no clone has
this file, nothing to sync" and stops, and the eight declared keys are inert: correctly declared,
describing a rewrite of a file that does not exist. The config reads configured, `ide vscode sync`
reads healthy, the editor row is green, and VS Code resolves stylelint, prettier and jest against
nothing — with every symptom appearing inside the editor, where nothing connects it back.

Gated on the table being DECLARED, exactly as the secrets row is gated on a variable being
declared, and silent the moment one clone has the file. **There is deliberately no `--fix` and no
generated default.** That is the same line `defaultSettings` draws between derived and personal:
emitting editor settings a hangar invented is a config that looks configured and is not.

## The tally, and the line between a problem and a fact

`problems` counted only the per-clone checks, so a hangar with no clones yet printed five
warnings -- its identity file, its settings, two mode statuslines, its secrets -- and closed with
`No problems in 0 clone(s).` A summary that contradicts the report immediately above it is worse
than no summary.

`doctor()` now holds a local `problem()` beside the plain `warn()`, and which one a site uses is
the whole decision. **Everything about this hangar's own state counts**, including the one-time
manual steps `--fix` deliberately will not close: those go to zero once somebody does them, which
is what a setup check is for. **The machine's CAPABILITIES do not** -- a `ps` that will not run, a
terminal with no `writeToTty`. Those are facts about where the fleet is running and are permanent
on some platforms, so counting them would leave a correctly configured GNOME Terminal hangar
permanently non-zero. The dim `optional:` secret rows stay out by construction, since they go
through `note`. The five `report*` helpers return a count rather than sharing a mutable module
variable, for the reason `two-hangars.test.ts` exists.

The summary names the two halves separately -- `above the clones` and `in N clone(s)` -- because
they are fixed in different places: a clone problem is almost always derivable, and a hangar one
is as often a decision `--fix` will never close.

**The exit code stays 0, and that is the convention rather than an oversight.** A `--check` flag
is this CLI's gate -- `config schema --check` and `colours sync --check` both exit 1 when stale,
verified -- and a report is a report. `doctor` has no `--check`, so nothing should read `$?` from
it; the summary line is the answer.

## The shell-hook check matched a bare filename

`clone-terminal.sh` is written INSIDE the hangar root, so by the naming rule in `app/CLAUDE.md` it
carries no hangar id -- which makes the name byte-identical in every hangar on the machine. The
positive half of `reportShellHook` tested `content.includes(hookName)`, so a second hangar
reported `terminal hook sourced from .zshrc` on the strength of the FIRST hangar's line, and its
own terminal colours silently did nothing. The stale-path half of the same function was already
scoped with `startsWith(hangar.root)` and was right.

Both halves now resolve the rc's path-shaped tokens through one `expandHome` and compare against
`hangar.paths.terminalHookScript`. One normalisation, not two written separately: the note this
check prints recommends the `$HOME/...` form, so that form has to match, and two copies of that
rule is how the halves came to disagree in the first place.

## The mode settings rows print the edit, and say what it costs

Still no `--fix`, for the security reason `reference/modes.md` spends its length on. What changed
is that the row prints the exact shell line rather than prose describing it -- **through a temp
file, not `sed -i`**, because in-place editing is the one flag GNU and BSD sed spell incompatibly
and this hangar's own `.envrc` puts GNU sed ahead of BSD on macOS. The obvious `sed -i ''` form is
correct in a plain terminal and silently wrong inside the hangar, where it reads the script as a
filename; this line is going to be pasted into a shell nobody here can see.

It also says what the edit costs, which nothing did: both files are tracked, so the change is a
permanent modification in `git status` and a conflict on every pull that touches them.

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

**And that is exactly how this check went green over a rename that was never finished.**
`settings targets` asks only whether the named path EXISTS. Phase one wrote
`~/.claude/<id>-clone-statusline.sh` beside `~/.claude/dvb-clone-statusline.sh`; phase two never
ran; and because the old script was still sitting there, all four clones went on pointing at it
with this row green. An existence check cannot notice a rename it is standing in the middle of.
So `settings.local.json` -- the row below it, the one that already compared `theme` against the
generated name -- now compares `statusLine.command` and `autoMemoryDirectory` too. Existence is
the weaker question and it stays where it is; identity is what closes the phase.


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

`settingsContentFor` reapplies the derived half on top of either template, so the two paths
cannot disagree about ANY of it. Both renders are in the golden capture
(`settings.local.json` from the fixed template, `settings-default.json` from nothing) because they
answer different questions: what `settingsContentFor` does to a file it was handed, versus what a
hangar can derive from nothing at all.

### It reapplied two of the eight, and said it reapplied all of them

For a long time `settingsContentFor` regenerated `theme` and the health-check allows — the two
values that differ per CLONE — while its own header claimed it covered the derived half, and
`doctor` held the same two. The other six were written once by `add-clone` and never looked at
again by anything.

That is invisible while a hangar keeps its name and its place, which is why the note that used to
sit here was wrong. It read: *`HangarPaths.memory` is `~/.claude/<id>-memory` by the naming rule,
and this hangar's four live clones still name `dvb-gn-memory` … only `defaultSettings` — a hangar
with no sibling — reads the path today, so leaving it splits nothing.* The premise stopped being
true the moment the hangar root's own `.claude/settings.json` became generated: it names
`<id>-memory`, the clones named `dvb-gn-memory`, and `~/.claude/dvb_gn-memory` and
`~/.claude/dvb-gn-memory` both existed with 25 entries each. The fleet's ONE shared memory
directory was two directories, a hangar-root session and a clone session could not see each
other's memories, and `hangar doctor --all` closed with `No problems in 4 clone(s).` The two
were still byte-identical when it was found -- nothing had been lost, and the repair needed no
hand-merge -- but they would have diverged at the next write from either side. That is the shape
of every bug this check exists for: correct today because nothing has happened yet.

So the check and the builder moved together:

- `settingsContentFor` now OVERLAYS the whole derived half — theme, statusline, memory directory,
  the hangar-root allow, the secrets deny, the health checks and the three hooks — and leaves the
  personal half exactly as the template had it. Overlay, never rebuild: a rewrite from
  `defaultSettings` would delete a developer's MCP servers to fix a theme.
- The two permission ARRAYS are add-if-absent. A stale deny only ever restricts, and a stale
  allow cannot be told from a rule the developer wrote themselves without knowing every root this
  fleet has ever had. What matters is that the CURRENT deny is present — its absence is what let
  `Read(<hangar root>/**)` reach a live secrets file after a move.
- `invokesOurCli` gained a second arm. It matched on this hangar's own `bin/` only, so a matcher
  naming a PREVIOUS root was not replaced but appended beside — two `SessionEnd` collectors and,
  worse, two `PreToolUse` Jira hooks, one of them a path that is not there. `bin/hangar` exits 0
  silently for `jira hook` precisely because a non-zero `PreToolUse` exit blocks the tool call,
  and a binary that does not exist cannot exit 0 at all. `--hangar <path> <subcommand>` is a shape
  only this CLI emits, and a clone belongs to exactly one hangar, so a matcher naming another root
  is always this hangar's own stale one, never a neighbour's live one.
- `doctor`'s `settings.local.json` row checks all of it and names which value drifted. It needed
  no new repair plumbing: that row's repair already called `settingsContentFor`, so widening the
  builder widened `--fix`.

### The one hook row whose right answer comes from the config

Two of the three hook rows are unconditional: every clone wants the plan collector and the `tmp`
merger, so the row asks "is it wired" and `--fix` wires it. **The tracker hook is not**, and it
went a long time behaving as if it were. `withJiraHook` and `hasJiraHook` read no config at all,
so a hangar declaring `tracker.kind: none` — which is the schema DEFAULT, and so every hangar
adopting this tool before configuring a tracker — got the hook written into every clone by
`add-clone`, kept there by the overlay, reported **missing** by `doctor` when it was not there,
and installed by `--fix`. It is inert: `jiraHook` declines on `kind: none` before it touches the
filesystem. It is not free: a `PreToolUse` matcher on `Bash` starts a Node process on **every Bash
tool call in every clone**, forever, to serve nothing.

So `withJiraHook` reconciles rather than adds — it already filtered its own stale matchers before
appending, and dropping the append turns that filter into the removal. **The gate is inside the
builder, not at the four call sites** (`defaultSettings`, `settingsContentFor`, this row's repair,
and the golden capture's template): a gate at the call sites is one that a fifth caller is added
without. The row then asks the opposite question when the tracker is off — not "is it wired" but
"is it gone" — and the same `withJiraHook` repairs both directions, so the jira → none transition
is repairable rather than merely un-made.

**The two predicates beside it are deliberately different strengths, and swapping them is silent.**
`hasJiraHook` is exact equality on the command this hangar would write today, which is right where
the answer decides whether to REWRITE: a drifted command *should* be rewritten. `hasAnyJiraHook`
is the same `invokesOurCli` test the filter uses, and is right where the answer decides whether to
REMOVE. Ask exact equality on the disabled path and `doctor` reports "correctly absent" about a
stale pre-`--hangar` hook that its own repair then deletes in the same run — the report and the fix
disagreeing, which is the failure the pair exists to make impossible.

**None of this is in `gated/`, and it cannot be.** Both fixtures declare `kind: jira`, and neither
can flip: `dev/fixture.config.yaml` is pinned by `tracker-config.test.ts` asserting its cache keys
disagree with the other fixture's and with the schema defaults, and `dev/fixture-vscode.config.yaml`
is the sole carrier of `syncScript`, `namerScript` and six other enumerated things. So the disabled
settings shape has no byte-level pin; `app/test/tracker-config.test.ts` carries it as properties
instead, including the negative case a capture could never state — that a hook belonging to another
tool in the same `PreToolUse` array is left alone. An empty `gated/` diff after this change is
therefore the meaningful result: it proves the enabled path did not move.

**Moving live memory is still not something `--fix` finishes.** It repoints the clones at
`<id>-memory`; the memories already written under the old name have to be merged across by hand,
appending to the surviving `MEMORY.md` rather than overwriting it, and no running session sees any
of it until it restarts.
