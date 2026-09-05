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
- **`issue`** has three outcomes, and they are not the same answer. A URL; or the bare key with
  `(no link — this hangar has no tracker.baseUrl)`, meaning the branch names a ticket and the
  hangar has nowhere to link it; or `none inferred`, meaning no key was found in the branch name or
  in this branch's commits. Telling the middle one from the last matters: a missing config would
  otherwise read as a branch naming convention. A URL may carry `(from a commit on this branch, not
  from the branch name)` — that parenthesis is a weaker signal than a branch name.
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

Three things to say correctly when you relay a report:

- **`No problems in N clone(s)` describes what is on disk, not what the running sessions are
  using.** Claude Code reads `.claude/settings.local.json` and `CLAUDE.local.md` once at startup, so
  a hook wired in by `--fix` or a theme swapped by `colours change` reaches that clone at its
  **next** session. A green report says nothing about the sessions open right now.
- **The default-branch row only warns**, and there is no `--fix` for it. (Why, at length:
  `hangar-internals/reference/config.md`, which states the same rule — change one and change
  both.) Which of the two is right
  is genuinely unknown: git writes `origin/HEAD` at clone time and never updates it, so a clone
  predating a rename keeps the old answer for good and the config may well be the newer one.
- **How much of the shared cache a clone has linked is deliberately not checked.** A ticket fetched
  in one clone reaches the others at the next `tmp merge`; a check that is red in normal operation
  is a check nobody reads. (`hangar-internals/reference/doctor.md` says the same — change one and
  change both.)
- **The `secrets` row has no `--fix` and never will.** It reports `secrets.variables[]` — what the
  repo's own tooling needs out of the shared secrets file — against what that file actually sets,
  and a credential is the one thing in the fleet that cannot be derived from a clone index. So
  relay it as a job for the human, with the variable's `why`, and never as something you can
  repair. It distinguishes two states worth keeping apart when you report them: **not set** is a
  gap, while **set but EMPTY** is worse, because an empty value reads as configured to everything
  downstream — an empty token produces a 401 rather than "no token configured". A row printed dim
  and prefixed `optional:` is a variable declared `optional: true`; mention it, do not chase it.
  A hangar that declares nothing gets no row at all, which is not the same as being fully
  configured.

## `hangar list`

The one authoritative answer to which clones exist. Index gaps are normal.
