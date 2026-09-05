# Reading the output

## `hangar status <n>`

Ten rows always, in this order: `dir`, `colour`, `branch`, `sync`, `worktree`, `issue`,
`pull request`, `ports`, `servers`, `claude`.

**Two more appear only when there is something to say**, between `worktree` and `issue`, and a clone
showing neither is the healthy case, not a missing feature:

- **`pending`** — a rebase or merge is half-applied. Its detail says
  `` `--continue` or `--abort` it; sync will refuse to start ``, which is the whole story: this is
  the state `sync` refuses to begin on, so it is the row that explains a refusal.
- **`sync stash`** — a stash `hangar sync` took and never gave back. It earns its place because
  these clones carry hundreds of stashes each, so a leftover one is invisible in the pile.

Rows that need care when you relay them:

- **`sync` is honest about staleness.** Without `--fetch` it compares against whatever
  remote-tracking refs happen to be on disk and appends `(not fetched — may be stale)`. Do not
  report `in sync` as authoritative unless you passed `--fetch`; the command prints
  `Remote state was not refreshed. Add --fetch for an authoritative sync answer.` for the same
  reason. `no upstream` means the branch has never been pushed — not that it is behind.
- **`issue`** has three outcomes, and they are not the same answer. `no tracker configured for
  this hangar` means the config says `tracker.kind: none` and nothing was looked for — there is no
  branch to rename and no key to add, and relaying it as "no ticket found" invents a problem. Or a
  URL. Or `none inferred`, which appears ONLY on a hangar that has a tracker and means no key was
  found in the branch name or in this branch's commits — that one is actionable, and telling it
  from the first is the whole point of the row: a hangar with no tracker used to print it, so a
  missing config read as a branch naming convention. A URL may carry `(from a commit on this
  branch, not from the branch name)` — that parenthesis is a weaker signal than a branch name.
  (A fourth, `(no link — this hangar has no tracker.baseUrl)`, is defensive: the schema requires
  `baseUrl` whenever the kind is not `none`, so a config that loaded cannot produce it.)
- **`pull request`** is a **search URL**, not a link to a specific PR. It does not mean a PR exists.
  It says `no link — forge.originUrl is not a Bitbucket repository` on a hangar hosted elsewhere.
- **`claude`** distinguishes `on <tty>` from `(no tty — IDE session)`. A session with no tty cannot
  be sent a `SYNC PAUSE`, which is what makes `sync` ask.
- **`ports`** here are the values the index formula says the clone should have. Whether the clone's
  `.env.local` agrees is `hangar ports`' job, not this one.

**A trailing warning `clone_0X and clone_0Y are both on <branch>`** is legal but almost always a
mistake worth surfacing. Two clones on the *default* branch is the normal resting state and is the
one pair deliberately not warned about.

## `hangar ports`

Prints the whole map, then either `Every .env.local agrees with the index formula.` or one warning
per disagreement, followed by
`` Repair with `hangar doctor --fix`, then re-run `direnv allow` in that clone. `` — note the second
half: a repaired `.env.local` does nothing until direnv reloads it.

`--json` gives the same data machine-readably.

**The specific trap:** the clones get their per-clone ports from direnv, which the repo wires up in
a `SessionStart` hook (`.claude/hooks/direnv-load.sh` — it appends a `direnv export` plus a `cd`
wrapper to `CLAUDE_ENV_FILE`, so every Bash call in a clone session, and every `cd` inside one,
re-evaluates the environment). **A parent session has no such hook**, so `.env.local` is never
loaded, so running the repo's own port script from here reports its fallback defaults for
**every clone** — it does not error, it just answers wrong (the tell is the `(default)` marker
it prints beside each number). Never read a clone's ports from a parent session; read the clone's
`CLAUDE.local.md`, or `grep` its `.env.local`.

## `hangar doctor`

Hangar-level rows come first (the detected terminal driver and its capabilities, one row per
configured editor and whether it can actually be launched, the recorded default branch versus each
clone's `origin/HEAD`, the declared secret variables, any stray PID files in the shared store),
then one section per clone.

Each per-clone check is a **green `ok` line** or a **red failure**. A failure whose cause is
derivable from the clone index adds `` fixable with `hangar doctor --fix` ``; a failure without that
line cannot be repaired automatically and needs a human decision. The footer counts the problems.

Four things to say correctly when you relay a report:

- **`settings targets` and `settings.local.json` are not the same question, so they can disagree
  and neither is wrong.** `settings targets` asks only whether the theme file and the statusline
  script the clone NAMES are on disk; `settings.local.json` asks whether it names the ones this
  hangar generates. A half-finished rename shows exactly that pair — a green `settings targets`
  (the old artifact is still there) beside a red `settings.local.json` naming the statusline. Say
  which of the two is red rather than "doctor contradicts itself"; the red one is the answer, and
  `hangar doctor --fix` repairs it.

- **`No problems in N clone(s)` describes what is on disk, not what the running sessions are
  using.** Claude Code reads `.claude/settings.local.json` and `CLAUDE.local.md` once at startup, so
  a hook wired in by `--fix` or a theme swapped by `colours change` reaches that clone at its
  **next** session. A green report says nothing about the sessions open right now.
- **The default-branch row only warns**, and there is no `--fix` for it. (Why, at length:
  `hangar-internals/reference/config.md`, which states the same rule — change one and change
  both.) Which of the two is right
  is genuinely unknown: git writes `origin/HEAD` at clone time and never updates it, so a clone
  predating a rename keeps the old answer for good and the config may well be the newer one.
- **`jira record hook` asks the opposite question on a hangar with no tracker, so read its
  detail rather than its name.** Where `tracker.kind` is `jira` the row wants the hook wired and
  goes red when it is missing. Where the config says `none` — which is the default — it wants the
  hook GONE, reports `correctly absent`, and goes red only when a stale one is still there from
  before the tracker was switched off. Both directions are `hangar doctor --fix`. Never relay a
  red row here as "the Jira cache is broken" without saying which of the two it is.
- **`code-workspace` is absent, not missing, on a hangar with no VS Code-family editor.** The row
  is written only where a configured `editor.kinds` entry actually reads a `*.code-workspace` — so
  a JetBrains-only or Zed-only hangar has no such row, and that is the correct reading rather than
  a check that stopped running. It used to appear everywhere: those hangars were told the file was
  missing and `--fix` created one for an editor that has no use for it. A file left behind by a
  hangar that used to list VS Code is deliberately left alone and unreported (it is inert and
  gitignored) — unlike a stale `jira record hook`, which costs a process per Bash call and IS
  removed.
- **A warning that the editor rows are the DEFAULT means the config did not parse.** With
  `hangar.config.yaml` invalid, the editor list falls back to the schema default, so the rows
  below it can name VS Code on a hangar whose config says JetBrains. Fix the config first —
  `hangar config validate` says what is wrong — and re-read; until then `hangar open` uses those
  same fallback editors.
- **How much of the shared cache a clone has linked is deliberately not checked.** A ticket fetched
  in one clone reaches the others at the next `tmp merge`; a check that is red in normal operation
  is a check nobody reads. (`hangar-internals/reference/doctor.md` says the same — change one and
  change both.)
- **The summary counts BOTH halves, and the exit code is always 0.** The closing line names
  `N problem(s)` and says where they are — `above the clones`, `in N clone(s)`, or both — because
  the two are fixed in different places: a clone problem is almost always derivable and `--fix`
  closes it, while a hangar one is as often a decision (a credential to paste, one line in a
  tracked settings file). It used to count only the clone half, so a fresh hangar printed five
  warnings and then `No problems in 0 clone(s).` What it deliberately does NOT count is the
  machine's capabilities — a `ps` that will not run, a terminal that cannot be typed into — since
  those are facts about where the fleet runs, permanent on some platforms, and a check red in
  normal operation is a check nobody reads. **Never read exit 0 as "healthy": in this CLI a
  `--check` flag is the gate (`config schema --check`, `colours sync --check` both exit 1) and a
  report is a report. Read the summary line, not `$?`.**
- **The `secrets` row reports two sources and repairs neither.** What it checks is
  `secrets.variables[]` — what the repo's own tooling needs — **plus the credentials Hangar
  itself needs, derived from the config**: the forge token named by `forge.tokenEnvKey` when the
  origin is a Bitbucket URL, and the Atlassian pair when `tracker.kind` is `jira`. Those three
  need no declaration, and they used to need one nobody wrote: this fleet declared only its
  Playwright password, so `doctor` was silent about three of the four credentials it actually
  uses. A declared entry with the same NAME overrides the derived one, which is how you make a
  forge token red rather than dim. A credential is the one thing in the fleet that cannot be
  derived from a clone index, so relay it as a job for the human, with the variable's `why`, and
  never as something you can repair. It distinguishes two states worth keeping apart when you report them: **not set** is a
  gap, while **set but EMPTY** is worse, because an empty value reads as configured to everything
  downstream — an empty token produces a 401 rather than "no token configured". A row printed dim
  and prefixed `optional:` is a variable declared `optional: true`; mention it, do not chase it.
  A hangar that expects nothing gets no row at all, which is not the same as being fully
  configured.
- **The secrets FILE, unlike its contents, `--fix` does create.** A separate row above the
  variables says when the shared secrets file does not exist at all, and `--fix` writes the same
  commented-out scaffold `hangar setup` writes — mode 600, every line inert. That is not deriving
  a credential; it is creating the container, and it exists because the fastest way into a
  configured fleet (`cp hangar.config.example.yaml hangar.config.yaml`) never runs `setup`, which
  was the only thing that had ever written the file. Each clone loads it with `dotenv_if_exists`,
  so an absent one loads nothing and reports nothing. When one run both creates the file and
  reports every variable unset, that is one finding, not two.
- **`terminal hook` matches the hook's full PATH, not its filename.** `clone-terminal.sh` is
  written inside the hangar root, so by the naming rule it carries no hangar id and every hangar's
  copy has the same name — a second hangar used to report the hook as sourced on the strength of
  the FIRST one's line in `.zshrc`, while its own colours did nothing. A green row now means this
  hangar's own file.
- **A `tooling` row names missing required programs.** Green is one line; anything missing is
  named with its install hint. It is the same check `hangar setup` runs and refuses on — `doctor`
  only reports — and it is here because copying a config skips `setup` entirely. `lsof` is the one
  worth chasing: without it nothing can attribute a process to a clone, so `sync --all` stops
  skipping busy clones and every failure looks like "nothing is running".
- **The two `.claude/modes/*.settings.json` rows are a one-time manual step, and they count.**
  Those files are tracked and carry an absolute `statusLine.command`, so a fresh clone of a
  published hangar has the previous owner's path and the mode badge silently never appears.
  `doctor` prints the value to set and the exact shell line that sets it — relay that line rather
  than the prose. There is deliberately no `--fix`: operator mode may run `hangar doctor` and
  those files hold its permission list, so a repair would let it rewrite its own boundary through
  a command it is allowed to run. Warn the user that the edit stays modified in `git status` and
  conflicts on a pull; that is the price of the boundary being structural rather than argued.
- **`<file> is in no clone, so <editor>'s N per-clone path setting(s) are inert`** means the
  config declares `editor.rootPathKeys` — settings that hold an absolute path into the checkout
  and so must differ per clone — while no clone has the file those keys live in. Nothing is
  broken and nothing is repairable: the file's contents are the developer's, not Hangar's. Tell
  them to set it up in one clone and run `hangar ide <kind> sync`, which gives every other clone
  the same file with its own root.

## `hangar list`

The one authoritative answer to which clones exist. Index gaps are normal.
