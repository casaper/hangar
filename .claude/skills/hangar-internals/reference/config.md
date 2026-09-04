# The config: two files, the no-config gate, and the one key that writes itself

`app/src/config/schema.ts` (479), `load.ts` (211), `derive.ts` (183), `default-branch.ts` (306),
plus the `preAction` gate in `cli.ts`.

## The config file is split in two, and one of them is not in git

`hangar.config.yaml` is **gitignored**. It names one machine's paths, ports and token variable
names, and it is written by `hangar setup` per machine, so tracking it would mean every hangar
sharing one machine's answers. What is committed is **`hangar.config.example.yaml`**: every key,
its default, and every alternative that the cross-field checks will not let stand beside it.

Three properties hold that pair together, and each is a decision:

- **The example is a faithful SUPERSET of the live file, and that is checkable.** `hangar config
  show` on each must differ only in the free-text `_` note. It is the only committed record of
  how this hangar is configured, so a drifting example is a lost config.
- **It is not a second marker.** `isHangarRoot` tests `CONFIG_FILENAME` exactly, so the example
  can sit in a hangar root without being mistaken for one — and `hangar --hangar <dir>` on a
  copy is how you validate it (nothing loads the example's own filename).
- **You cannot uncomment two alternatives.** `superRefine` rejects two port roles whose bases
  are congruent mod `step`, an `install` step naming both `manager` and `command`,
  `rootPathKeys` with no VS Code-family kind to read them, and a tracker with no `baseUrl`. So
  the example carries alternatives as COMMENTS beside one live choice.

**The rule for what a live config keeps:** a value that pins state already on disk or already
running stays written down even when it equals the default — `clones.prefix` and `clones.pad`
name directories that exist, `ports.step`/`ports.offset` place dev servers that are serving, and
a future change to a default must not move either. A value that only configures a feature this
hangar does not use goes — `editor.jetbrains` in a hangar listing only `vscode` configures
nothing.

## Absence is a gate; invalidity is a report

A `preAction` hook in `cli.ts` refuses **every** command when `hangar.config.yaml` is missing:
the marker file IS the hangar, and running without one means running on schema defaults while
looking like a configured run. Two exemptions, both load-bearing rather than convenient —
`setup`, which writes the file, and **`jira hook`, whose `PreToolUse` contract is fail-open**,
because a non-zero exit from a PreToolUse hook can block the tool call it exists to accelerate.
The two `SessionEnd` hooks (`plans collect`, `tmp merge`) are deliberately NOT exempt: a missing
config there is worth surfacing, and a session ending is the safe moment to surface it.

The gate tests EXISTENCE and never parses. That is what keeps `config validate` and `doctor`
able to do their jobs: both exist to report an invalid config, and a gate that parsed the file
would stop them before they could. So the four config readers that are reached outside a
command's own `loadConfigFile` — `currentHangarId`, `terminalColourSettings`, `terminal` and
`editorConfig` — now catch only the UNPARSEABLE case, where falling back beats refusing (a
`colours sync` that regenerates with default colouring is better than one that will not run).
`EditorSelection.fellBack` therefore means exactly one thing now: the config would not parse.

## One gate sits below that one, in `bin/hangar`

The config gate can only refuse once the CLI has loaded, and there is a failure that happens
first: the CLI has real dependencies (`commander`, `zod`, `yaml`, `dotenv`, `picocolors`) while
`app/node_modules` is gitignored, and `node` itself reaches PATH only through direnv. So a fresh
clone of this repository runs `hangar` and gets Node's `ERR_MODULE_NOT_FOUND` with a stack trace —
which reads as a broken tool rather than as a missing step, and it is the very first thing a new
hangar hits, before `setup` has had any chance to check the machine.

`bin/hangar` therefore checks for `node` and for `app/node_modules` before it `exec`s anything,
and names which of the two is missing along with the command that fixes it. **It cannot live in
`app/`**: the condition it reports is the CLI being unable to load.

It repeats the config gate's exemption for the same reason and no other: **`jira hook` exits 0
silently even on an unbootstrapped hangar**, because a non-zero exit from a `PreToolUse` hook
blocks the tool call. Two gates, one exemption, one rationale — if a third gate is ever added
above these, it inherits the exemption too.

The same file resolves its own directory with `${0%/*}` and two shell builtins rather than
`dirname`. That is not style: with a degraded PATH `dirname` is not found, the command
substitution came back empty, the hangar root resolved to `/`, and the bootstrap advice printed a
path to somewhere nobody asked about — a wrong answer produced by the very check meant to explain
a degraded environment.

## `forge.defaultBranch` — asked once per hangar, not once per command

Every clone in a hangar is a clone of ONE repo, so which branch that repo treats as its default
is a property of the **hangar**, not of a clone. It used to be re-derived per clone per command
from `origin/HEAD`, with a `remoteHeadBranch()` that fell back to the literal `master` — wrong
for every repo that uses `main`, and wrong SILENTLY, which is the failure this fleet is built
against. `config/default-branch.ts` is now the only place that answers the question, and
`remoteHeadBranch` is gone.

**Required in effect, optional in the schema.** Nobody types the value: the first command that
needs it detects it and writes it into `hangar.config.yaml`, and every command afterwards reads
it from there. It stays `optional()` in the zod schema because a hard requirement would make
`config validate` and `doctor` fail on the very file they exist to diagnose — before the autofill
could run — and because detection needs a clone or a network, neither of which a schema can
promise. Undetectable is a `CliError`, never a guess.

Five properties, each of which is a decision:

- **Two entry points, because two kinds of caller have incompatible needs.**
  `requireDefaultBranch({ persist })` is for commands that ACT on the answer and throws when
  nothing can tell it. `tryDefaultBranch()` never throws, never writes and never touches the
  network — it is what `status` and `inferTicket` use, the latter because it is reachable from
  paths whose whole contract is that "no answer" is a normal answer.
- **`persist` is not optional.** Every call site states whether it may write, so no report-only
  command or `-n` run can mutate the hangar's config as a side effect of asking a question —
  byte-identical dry-run output is this CLI's regression record. `sync` passes
  `persist: opts.dryRun !== true`; `landOnBranch` passes `true`, but only past the dry-run
  return, and the pre-fetch half of that function deliberately uses the `try` form so an instant
  refusal stays instant.
- **Detection is cheapest-question-first:** every clone's local `origin/HEAD` (free, and
  disagreement between clones is reported rather than silently resolved by whichever sorts
  first), then `git remote set-head origin --auto`, then `git ls-remote --symref` on
  `forge.originUrl` — which needs no clone at all, and is the only path a hangar with no clones
  yet can take. `origin/HEAD` is a local symref: git 2.45 and later fill it in during a fetch
  that finds it absent (verified on 2.55), but nothing updates it once it exists.
- **The write is a three-line text insertion, not `doc.setIn` + `doc.toString()`.**
  Re-serialising this document rewrites it: with the `yaml` library's own defaults it reflows
  every block scalar, respaces `[DN]` into `[ DN ]` and moves the comments inside a sequence onto
  the wrong item — an unreviewable diff to a hand-maintained, four-hundred-line, gitignored file
  that is the only record of this machine's ports and paths. `parseDocument` is used only to
  LOCATE the `forge:` line and read the block's indentation off its first entry; the lines go in
  immediately after that line, never before the first entry, because a comment block above an
  entry documents THAT entry. Then two proofs before the rename: the new text must differ from
  the old by exactly the lines being added, and the result must parse back as a valid config
  naming this branch. Anything else and it writes nothing and says what to add by hand — the
  caller already has the value, so a failure costs one re-detection and nothing else. The rename
  is atomic because four clone sessions and their `SessionEnd` hooks share this file.
- **It keys on the threaded hangar's root, and the `Map` is now load-bearing rather than
  aspirational.** Two hangars resolved in one process must stay disjoint, and since the root comes
  from real discovery (`--hangar`, then the walk, then `HANGAR_ROOT`) there can genuinely be more
  than one key. `pnpm golden` renders two in a single run.
- **`doctor` compares the stored value with each clone's `origin/HEAD`, and only warns.** (How to
  relay that row to a user is `hangar-ops/reference/reading-output.md`, which states the same
  rule — change one and change both.) Storing
  the answer is what makes a repo that RENAMES its default branch a hazard, so this is the row
  that notices; it uses local refs only, because a check that sometimes hangs for twenty seconds
  is a check people stop running. A warning with no `--fix`, because which of the two is right is
  genuinely unknown: git writes `origin/HEAD` at clone time and never updates it, so a clone
  predating the rename keeps the old answer for good and the config may well be the newer one.


## `setup` emits only what it observed

The rule, and it was broken in a way only a foreign repo could reach: **a value `setup` cannot
observe is asked for, offered by a preset, or left out with a comment saying what it would do.**

What it used to write into every config it produced was this fleet: the Playwright symlink, the
eight VS Code path keys under `angular/`, `portCheckCommand: [node, dev/ports.mjs, --json]`, this
organisation's Jira host as the tracker default, and
`envrcDirs: ['.', '<appDir>', 'tests/playwright-regression-tests']`. That last one is the tell that
none of it was ever exercised against another repo: `detectAppDir` returns `''` for a repo with no
`package.json`, so the rendered list was `['.', '', 'tests/...']`, `envrcDirs` is
`z.array(z.string().min(1))`, and **`setup` wrote a config to disk and then threw validating it.**

Three things now hold it to the rule:

- **`envrcDirs` and `editor.rootPathKeys` are DERIVED**, from `git ls-files -- '*.envrc'` and from
  a clone's own `.vscode/settings.json` (any value starting with the clone's path is a per-clone
  path, whatever extension put it there). Both reproduce this hangar's hand-maintained config
  exactly, which is the identity substitution that proves the derivation rather than the literal.
- **`setup -n` validates the render**, through `parseConfigText` — the parse/validate half of
  `loadConfigFile`, split out to work over text. The dry run used to `return` before the only parse
  in the command, so the one invocation that could have caught a config setup cannot load was the
  one that skipped the check. That gap is where the `envrcDirs` bug lived.
- **The golden net captures `setup -n` per preset in an EMPTY temp directory**, not against this
  hangar. With no clones there is nothing to derive from, which is exactly a colleague's first run.
  Pointing it here would need `--force`, which would leave the live gitignored config one `-n`
  regression away from being destroyed by the net meant to protect it.

### Presets are templates, not code

A preset supplies the two answers no checkout can produce — `ports.roles[]` and
`repo.cloneEnv.vars` — and writes them out as plain config. **It is never read again at runtime**,
which is the whole design constraint: a runtime `if (profile === 'sql-postgrest')` would
re-introduce exactly the hardcoding this track spent five items deleting. `profile:` in a written
config is a label; no code consults it, and `app/src/profiles/` was never written and now never
will be. Two hangars needing zero profile code was the evidence the config boundary had been drawn
in the right place.

Every preset's port bases sit in different residue classes mod the default step of 100, because the
schema rejects two roles whose clones would collide — correctly: `api: 3000` beside `admin: 3100`
puts clone 1's admin on clone 2's api. A preset shipping that would be a config nobody can load,
found by whoever ran setup rather than whoever wrote it, which is why each preset is rendered and
parsed in the gated capture.

### The secrets file is created, and every line is commented out

`setup` used to NAME a secrets file it never created, so a fresh hangar had `doctor` red and `sync`
with no token to read — both of which get diagnosed as bugs rather than as "nobody has filled this
in yet". It is created at `secrets.mode` (0600) with the variable names the config implies, all
commented out. Not `BITBUCKET_TOKEN=`: a set-but-empty variable is indistinguishable from a real
one to everything downstream, so an empty token makes `sync` report a 401 instead of "no token
configured". An existing file is never overwritten — it holds live credentials.
