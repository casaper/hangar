# The editors: what `ide sync` rewrites, and why VS Code outranks the rest

`app/src/commands/vscode.ts` (319), `app/src/editor/**` (nine drivers). The user-visible table of
which editor gets launched how, and what Hangar keeps in step for each, is in `app/CLAUDE.md`.

**`hangar ide vscode sync` is a text transform, not a copy**, and it is the only editor for which
that is true — `$PROJECT_DIR$` and project-relative settings spare all the others. Two reasons. A
handful of VS Code settings take an **absolute** path into the checkout — `stylelint.stylelintPath`,
`stylelint.configFile`, `stylelint.configBasedir`, `prettier.prettierPath`, `prettier.configPath`,
`jestrunner.projectPath`, `coverage-gutters.manualCoverageFilePaths`,
`storyExplorer.server.internal.npm.dir` — and VS Code resolves them against nothing, so those must
differ per clone while every other key should be identical. It discovers the checkout root the
source file's values point at, replaces it with a token, and renders that template with each
clone's own root. And both `.vscode/settings.json` and the `*.code-workspace` files are **JSONC** —
comments and trailing commas, neither of which survives `JSON.parse` — so nothing is ever
reserialised; key order and the hand-maintained tab indentation are preserved as text.

Three things follow that are worth knowing:

- **The key list is declared, not sniffed** — and it is **config**, not code:
  `editor.rootPathKeys` in `hangar.config.yaml` (`config/schema.ts:334`, a `z.record` of setting
  key → path relative to the clone root), seeded by `hangar setup` (`commands/setup.ts:267`) from
  the eight defaults in `editor/vscode.ts:51`. It used to be a hard-coded table in an
  `app/src/vscode.ts` that no longer exists; the move changed where you add a key, not what
  happens if you forget to. A clone-specific setting that is missing from it gets copied
  verbatim and leaves one clone's tool path aimed at another clone's `node_modules` — silent,
  exactly like a Storybook health check on a sibling's port. A rendered file that still contains
  another clone's directory name is therefore a **hard error** naming the file; the fix is to add the
  key to the config, not to force the write. Absolute paths _outside_ the fleet root are left
  alone — the `~/.vscode/extensions/…` YAML schema URL in the workspace file is genuinely shared.
- **`launch.json` and `tasks.json` are tracked by git**, unlike `settings.json`, `mcp.json` and the
  workspace files, so they are **compared and never written** — there is no flag to force it. They
  are versioned per branch, so the newest copy is not the right one, it is just whatever branch
  last touched it; writing it into a sibling would dirty that sibling's checked-out branch _and_
  import another branch's content into it. When they differ the command groups the clones by
  version and prints each one's branch, which is almost always the explanation. Git resolves that,
  not this command.
- **There is no source clone.** Each untracked artifact independently syncs from the most recently
  modified copy of _that_ file (they drift separately), which is printed; `--from <clone>`
  overrides it and `-n` shows the changed keys per clone without writing.

The workspace file exists **once per entry in `editor.workspaceDirs`**, byte-identical, because
VS Code only offers a `*.code-workspace` from the directory you opened. `['.']` is the common case
— a repo only ever opened at its root — and this hangar's repo is opened at its root AND at its
app directory, so it declares both and every clone carries two copies. The name comes from
`editor.workspaceFileName`, rendered per clone. `doctor` checks for each and fills a missing one
from a twin; `workspaceContent()` in `clone-config.ts` is only the fallback for a clone that has
none.

## VS Code is ranked above the other editors, and the code says so

`editor.kinds` accepts thirteen kinds; **one of them is verified against a live install and the
other twelve are written from documented contracts.** So the rank is in the code rather than in a
caveat:

- **`DEFAULT_EDITOR_KIND` (`app/src/editor/kinds.ts`) is the only place that names the default.**
  The zod default is `[DEFAULT_EDITOR_KIND]`, and the fallback for a config too broken to parse is
  `editorSchema.parse({})` — i.e. it reaches the same constant through the same default. Two
  literals here would be two things to keep in agreement, and the failure would be silent.
- **`editors()` builds the drivers in a loop with a per-kind catch**, not a `.map`. Several
  constructors probe the machine (`vimDriver` looks for four binaries, `jetbrainsDriver` resolves
  a launcher), and a `.map` would let one of them take the default editor down with it. `open`
  and `doctor` then isolate each driver again around `isAvailable`/`launch`, so `[zed, vscode]`
  cannot lose VS Code to Zed's launcher — listing order alone would have decided that.
- **`editorFor(kind)` builds only the kind asked for and does NOT catch.** It used to pick from
  `editors()`, which made `hangar ide vscode sync` construct every other configured driver
  first and depend on all of them. And an editor the developer named by running
  `hangar ide <kind> sync` is not a bystander: its failure is the answer to that command.

What this was checked with, since the seed suite covers the pure core and reaches none of this:
`kinds` set to all seven families at
once (`doctor` printed seven honest rows, no throw), VS Code placed **third** in that list (its
row still green), and `zedDriver` temporarily made to throw at construction — `doctor` reported
`the zed editor driver would not build: …` and VS Code's row survived, while `hangar ide zed sync`
raised, which is the intended asymmetry. The live VS Code path: `openWorkspaceFile` found
clone_03's already-open workspace and `launch` returned `reused: true`, so it focused that window
instead of opening a second one on the identical twin.

**The window-state file that makes `openWorkspaceFile` work is platform-specific, and moved onto
the platform seam at F11.** It is `~/Library/Application Support/<stateDir>/User/globalStorage/
storage.json` on macOS and `~/.config/<stateDir>/User/globalStorage/storage.json` on Linux — only
the config directory differs, which is exactly what `PlatformDriver.machineConfigDir` carries.
Written for macOS it does not fail elsewhere: it returns a plausible path, the read throws, the
catch reports "no opinion", and `open` opens a **second** window on a workspace that was already
open — the duplicate this whole mechanism exists to prevent, and the way two Claude Code sessions
end up in one clone. It now returns `undefined` on a platform whose location is unknown, so the
caller gets a nullable rather than a wrong path. `<stateDir>` still matters as much as ever: every
fork has its own (`Code`, `Cursor`, `Windsurf`, `Code - Insiders`), and reading the wrong one
answers about a different application's windows.

`doctor`'s editor row names the two things that differ **between** these editors, both the
editor's doing: who works out which window already has the clone open (`focus-existing` when
Hangar must, `self-deduping` when the editor does, `a terminal tab` for terminal vim, which is not
a window at all), and whether there is a setup to keep in step (`sync` / `sync, per-clone paths` /
`launch only`). It used to print `$PROJECT_DIR$` for Xcode and vim, describing a mechanism neither
has.

## The `*.code-workspace` artifact is gated on the configured editors, and the gate is one predicate

`wantsWorkspaceFiles(hangar)` in `clone-config.ts` asks the same question the schema's
`rootPathKeys` cross-check asks — "is there a kind that CONSUMES it" — through the same
`isVscodeFork` predicate, rather than a second list that could disagree with the first.

**It gates the three callers that are not the driver**, and nothing else: `add-clone` writing the
file, `doctor` checking and repairing it, and `dev.ts`'s golden capture recording it.
`workspacePath`/`workspacePaths`/`workspaceContent` stay pure and ungated — they are called from
inside `editor/vscode.ts`, which only exists when a VS Code kind is configured, so gating the
builder would make the driver re-ask a question it has already answered and leave
`hangar ide vscode sync` unable to name the file it syncs.

Without it, a hangar configured `kinds: ['jetbrains']` got a `*.code-workspace` per clone for an
editor whose project IS the directory, `doctor` reported the file **missing** when you deleted it,
and `--fix` put it back. That was not a hypothetical: the gated golden baseline carried three
rendered workspace files for the `kinds: [zed]` fixture, so the net had pinned the bug as correct.
Removing those three files and their three manifest lines was the whole gated diff.

Two decisions inside it:

- **No row at all in `doctor`, rather than a green "not applicable" one.** The `editor` row
  already says what Hangar does per configured editor; a second row saying it does nothing is
  noise in the common case.
- **A workspace file left behind by a hangar that USED to list VS Code is left alone and
  unreported.** The tracker hook went the other way — `doctor` removes a stale one — and the
  difference is the cost, not consistency: a stale hook starts a Node process on every Bash tool
  call, while a stale workspace file is an inert gitignored file that nothing reads.

A hangar whose config will not parse gets `['vscode']` from the schema default and so keeps the
file. That is the recoverable answer: with the editors unknown, a typo in an unrelated line of
YAML must not start deleting an artifact from every clone. `test/editor-config.test.ts` asserts
the default is still a kind that wants one, because that is what the choice rests on.

## `isAvailable` has to be as wide as `launch`, and for JetBrains it was not

`open.ts` checks `driver.isAvailable()` and returns before it reaches `driver.launch(clone)`. So a
driver whose availability probe is **narrower** than its launch path has a launch path that cannot
be reached — and `editor/jetbrains.ts` had exactly that. `launch` falls back to
`openExternally(clone.path, app)` — `open -a "IntelliJ IDEA"` — with a comment saying why:
"Toolbox may not have installed a shell script, and then the application BUNDLE is the only handle
left." `isAvailable` modelled that same fallback as `existsSync('/Applications/<app>.app')`.

Toolbox does not install under `/Applications`. So the bundle fallback was unreachable through
`hangar open` in precisely its motivating case, and the answer was `IntelliJ IDEA is not
available` for an IDE that was installed and would have opened.

The fix is not more paths in the `existsSync` list — that is the same guess again. It is
`PlatformDriver.applicationExists`, the read-only twin of `openExternally`'s `app` argument,
gated by the **existing** `openApplicationByName` capability so the two answers have the same
reach by construction. On macOS it is `osascript -e 'id of app "<name>"'`, which is LaunchServices'
own lookup — the same resolution `open -a` performs, so it finds `~/Applications` too. On Linux it
is `false`, for the same reason `openApplicationByName` is: there is no lookup from a display name
to a `.desktop` entry.

**No new capability key**, deliberately: each fixture's `manifest.txt` captures the capability
record key by key (`platform-caps openExternally=true openApplicationByName=true …`), so a new
boolean would have moved both fixtures' gated manifests for a fact neither fixture is about.

**Still unverified, and the one thing a machine here cannot answer:** whether LaunchServices
resolves the literal `IntelliJ IDEA` for a Toolbox install (named *IntelliJ IDEA Ultimate*) or for
the Community edition (*IntelliJ IDEA CE*). The probe is strictly wider than the path check in
every case, so this is not a regression risk; if a product turns out to need alternate names,
`JETBRAINS_PRODUCTS` is where they go and `editor.jetbrains.launcher` is the escape hatch until
then.

## `doctor` says when its editor rows are the fallback's

With a config that will not parse, `editors()` resolves `kinds` to the schema default — so a
hangar configured `kinds: ['jetbrains']` printed a green `editor  VS Code — …` row naming an
editor its own config does not list, seven lines below the warning that the config does not
validate, with nothing connecting the two. `editor/index.ts` already warns about this shape ("VS
Code opened at it and no hint as to why"); `doctor` is where the hint belongs, because it is the
command you run when something is wrong and it was the one confirming the wrong answer.
`editorChoice.fellBack` was already returned and unused.
