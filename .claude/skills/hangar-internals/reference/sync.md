# `sync`, its two other names, and `checkout-default`

The most dangerous command in the CLI and the two that share its machinery.
`app/src/commands/sync.ts` (882 lines) and `checkout-default.ts` (328); the shared landing step is
`landOnBranch`.

- **`hangar sync` types into a live Claude session.** There is no CLI mechanism to message a running
  interactive session, so it finds the session's tty, maps it to the tmux pane on that tty and
  writes a pause message, then a closing message afterwards. Each one leads with a marker — `SYNC
  PAUSE`, then **exactly one** `SYNC FINISHED` or `SYNC ABORTED`, which the pause promises and a
  `finally` delivers. That guarantee is the point: six paths lead out of a sync between the two
  messages, five of them used to send nothing, and an agent told to STOP and wait for a message that
  never comes waits for good. The closing message **reports the state it found** rather than an
  outcome — a half-applied operation, files still conflicted, work still in a stash — because those
  combine, and it says whether to resume or to stand still and tell the user. `--all` **skips**
  clones with a live session unless `--include-busy`. Rebase vs merge follows the rule "rebase only
  my own linear branch"; anything with merge commits, or started by someone else, is merged instead.
  It **refuses to start on a clone that is already mid-rebase or mid-merge** — finish or abort that
  first, because step one is a `git stash push` and it would bury the half-applied state in a stash
  nobody thinks to look in.
- **`hangar sync` integrates onto the branch the clone's PULL REQUEST targets, not onto
  `master`.** Nothing local knows that branch: a branch cut from `master` can have a PR onto
  `release9`, or onto another branch of this fleet (a stacked PR — one clone's PR onto another
  clone's branch), and every fork-point heuristic answers `master` for all of them. So `sync`
  asks the Bitbucket REST API, authenticated with `BITBUCKET_TOKEN` from `.env.shared` (an
  Atlassian API token; Bitbucket Cloud takes it as a bearer token). The target is **printed on
  every run** with where it came from, and `-n` shows it without changing anything. Priority is
  `--onto <ref>` > the open PR's destination > the default branch. Two open PRs onto different
  branches **abort** and ask for `--onto`; a destination that does not exist on origin even
  after the fetch **aborts** too, rather than quietly falling back — a rebase onto the wrong
  base is the expensive thing to undo here. No token, no network or a 401 is _not_ an error: it
  falls back to the default branch and says the target is a guess. The ref handed to git is
  always `origin/<branch>` — a bare name is ambiguous the moment a sibling clone has the same
  branch, which in a stacked PR it does by definition, and `checkout.defaultRemote` does not
  reach `rev-parse` or `rebase`.
- **`merge-default` and `rebase-default` are `sync` under another name, and the name is read out
  of `process.argv`.** Commander records nowhere which alias a subcommand was reached by —
  `actionCommand.name()` always answers `sync` — so `forcedStrategy` scans the invocation for one
  of the three names. A WHITELIST scan and not a parser that skips global options: the parser
  version stays correct only until a second value-taking global option is added, at which point
  it would silently take that option's value for the subcommand name. `--strategy` outranks the
  name, because a flag was typed for this run while the name is only how the command was reached.
  The force itself is `decideStrategy`, which is pure and takes the AUTOMATIC RESULT rather than
  the clone, so all twelve combinations print side by side with no git state; it leaves the
  automatic answer untouched whenever the force agrees with it, which keeps the dry run's output —
  this command's regression record — byte-identical unless something was really overridden. Two of
  the four kinds are never forced: `ff-only` means the branch IS the target and `up-to-date` means
  it already contains it, and neither is an opinion to override. Forcing a MERGE is silent (it is
  the conservative half of the rule); forcing a REBASE over an automatic merge `warn`s on both the
  real and the dry-run path, because that is the one case where the tool does what it otherwise
  refuses — rewriting merge commits, or commits somebody else authored.
- **`hangar checkout-default` takes the branch from the config and refuses to guess it.**
  `forge.defaultBranch` is the one answer the whole hangar uses — `reference/config.md` has why it
  is stored rather than derived — and there is no `master` fallback anywhere behind it. It differs
  from `sync` in three deliberate
  ways: it **only ever fast-forwards** (`git merge --ff-only` on the refs the fetch already
  brought, so one round trip and no possible conflict — a diverged default branch is reported and
  left for `sync`); it **does not stash**, refusing a tree with modified files only when a branch
  SWITCH is what would carry them, and not when the clone is already on the default branch and
  `merge --ff-only` can police itself; and it sends **no `SYNC PAUSE`**, because that protocol
  buys a paused agent a guaranteed closing message for an operation that takes minutes, and this
  one is instantaneous. What a live session gets instead is a `confirm()` put to the human — which
  fails closed with no tty, so an unattended invocation refuses rather than swapping the branch
  under a working agent. Every guard runs BEFORE the fetch so a refusal is instant, and under `-n`
  none of them throws: a dry run reports every reason the run would stop, not just the first.
- **Conflicts are delegated to a headless `claude -p` inside the clone**, then verified
  mechanically (no unmerged paths, no markers). If that fails the whole operation is aborted and
  the pre-sync state restored — never left half-merged. **One exception, and it is inherent:**
  putting your stashed work back happens after the integration is already committed, so if that
  is what fails, the branch has moved and cannot be rolled back. The clone is then left with
  unmerged paths and the stash intact, and the session is told the integration DID happen —
  never that it did not. `status` grows two rows for exactly this wreckage — `pending` and
  `sync stash` — and both appear **only when there is something to say**, so a clone that shows
  neither is the healthy case and not a missing feature. The stash row earns its place: these
  clones carry six hundred stashes each, and a leftover `hangar-sync` one is invisible in
  that pile. `git rerere` and `-X ours/theirs` are
  deliberately not used: they look like resolution and silently produce wrong code.
  **That run takes one to three minutes and streams its progress** — a dim line per tool call,
  per API retry, and a heartbeat into any longer silence — because `claude -p` in its default
  output format prints nothing at all until it finishes, which reads as a hung command and gets
  killed, leaving the rebase stopped mid-pick. **Let it run; do not resolve the same files by
  hand while it is working.** It is aborted after 10 minutes
  (`ORCH_UTIL_RESOLVE_TIMEOUT_MS` overrides), and the headless session id it prints is the
  transcript to read afterwards.
- **The operator can talk to that run while it happens, and the protocol is why the prompt goes
  in over stdin.** The resolver is spawned with `--input-format stream-json`, which makes stdin a
  stream of further user messages rather than a single prompt, so a line typed at the terminal is
  forwarded as one more message — the way to say "keep master's version of that spec" while the
  model is still reading files, instead of discovering the wrong choice a minute later. Five
  properties hold it together. The first four are measured against the CLI; the last is
  reasoned, and is the one to suspect first if this ever misbehaves:
  - **The prompt itself is the first message on stdin, not an argv prompt.** One shape, verified,
    for both the first message and every later one.
  - **`--replay-user-messages` echoes each accepted line back on the output stream**, so a
    delivered instruction is SHOWN (`→ sent: …`) rather than hoped for. The first replay is the
    prompt this command sent itself and is not printed. A message written after stdin has closed
    is an `EPIPE` on a dead child, which is handled and never takes the sync down.
  - **A queued line is picked up as the NEXT turn**, so the session does not exit at the first
    `result` if something was typed during it: stdin closes on a `result` with nothing pending,
    and EOF is what ends the session — it will otherwise wait for input forever.
  - **Streaming input does NOT hand permission decisions to a host**, which is the one way these
    flags could have reintroduced the hang they sit next to: `--input-format stream-json` is the
    SDK host protocol, and `--permission-prompts` defaults either to `host` — nobody answering,
    so the first tool call outside the allowlist blocks until the ten-minute timeout and the sync
    rolls back — or to nobody, which denies and carries on. An A/B of the two spawn shapes on a
    call outside the allowlist answers it: both auto-deny with `This command requires approval`,
    the model reads the refusal and continues, and both reach `result success`. Nothing needs
    `--permission-prompts none` pinned, and a future default that changes this is what that A/B
    is for.
  - **The channel exists only when `process.stdin` is a tty.** An agent driving `sync` through a
    Bash tool, a script or a `SessionEnd` hook has no terminal, gets no reader, and gets the
    fire-and-forget run unchanged. The reader is built with `terminal: false` and released
    (`close()` plus a `pause()`) the moment the child is done — a readline that owns the tty takes
    over Ctrl-C, and interrupting a sync has to keep working, as does the `confirm()` and the
    terminal-owning `--continue` that come straight after it.
- **Nothing `sync` spawns can stop for a human unseen.** Every git subprocess runs under
  `noEditorEnv` — `GIT_EDITOR=true` and `GIT_SEQUENCE_EDITOR=true` in the ENVIRONMENT, which is
  the layer git reads before any config and the only one an operator's shell cannot outrank. A
  `-c core.editor=true` beats the config files and loses to a `GIT_EDITOR=vim` in an rc file, and
  losing costs a hang rather than an error: an editor spawned against a captured pipe has its
  screen output discarded while it reads the keyboard from `/dev/tty` directly, so the run stops
  dead with nothing on screen and the paused session never gets the closing message it was
  promised. What that leaves is everything git launches which is NOT an editor — a pinentry for a
  signed commit, a prompt from a `pre-commit` hook — so each `--continue` runs with the
  **terminal inherited**, where a question is visible and can be answered. **No timeout:** killing
  a rebase to escape a question buries a half-applied one in exchange for a keystroke, and SIGTERM
  reaches git rather than the grandchild already holding the tty.
- **Inheriting the terminal costs `stderr`, and the verdict is better without it.** Whether a
  rebase is done comes from `inProgressOperation` — the state directory, which is what git's own
  status reads — and not from a matched error string or from `REBASE_HEAD`, which is gone as soon
  as a step is staged. That also tells apart two states one string cannot: no operation and
  nothing conflicted means the rebase is OVER when a continue has just run, and means it never
  STARTED when found on the way in (a `pre-rebase` hook refusing, unstaged files the stash
  missed). Reading the second as the first is how a paused agent is told its branch moved while
  nothing happened at all.
- **`hangar open` lands each clone on a branch before it opens a single window**, through the same
  `landOnBranch` that `checkout-default` is built on — one implementation, so the two cannot end
  up with different ideas of which trees are safe to move. Order matters: one of those windows runs
  `claude`, and a session that starts before the checkout reads one tree while the developer
  looks at another. Severity is where they differ: a `CliError` from the landing is the ANSWER to
  `checkout-default` and only a warning here, after which the clone is opened on whatever branch
  it already has — refusing a window over a dirty tree would be the worse trade, and it is the
  same degradation `open` already applies to an editor that will not launch. `--branch <name>`
  overrides the default-branch resolution and nothing else about the landing; `--no-checkout`
  skips it entirely.
