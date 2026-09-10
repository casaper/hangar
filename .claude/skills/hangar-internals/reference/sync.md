# `sync`, its two other names, `checkout-default`, and the two forge writes

The most dangerous command in the CLI and the two that share its machinery.
`app/src/commands/sync.ts` (882 lines) and `checkout-default.ts` (328); the shared landing step is
`landOnBranch`. `pr create` and `pr update` are here too, at the end: they are the only commands
that write to the FORGE rather than to a working tree, which is a different blast radius reached
through the same Bitbucket adapter.

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

## `pr create` and `pr update`: the only writes that leave the machine

`app/src/commands/pr.ts`, with `pr-description.ts` beside it for the body and `bitbucket.ts` for
the two requests. Everything above this heading can be undone in the clone it happened in. A pull
request cannot: it is visible to the whole team the moment it exists, and a pull request opened
ready for review has already notified its reviewers by the time anybody reads the command's output.
Every decision below follows from that one asymmetry.

- **The existence guard is the one place a soft lookup failure becomes an abort.**
  `openPullRequests` never throws -- offline, tokenless, a 401 and malformed JSON all arrive as
  `{ok: false, reason}` -- and every other caller in the CLI treats that as "carry on without it",
  which is right for a read: `sync` falls back to the default branch and says the target is a
  guess. As an EXISTENCE guard the same value means "we do not know whether one exists", and
  carrying on there turns a network timeout into a duplicate pull request somebody has to decline.
  So `pr create` stops and prints the reason. The query is deliberately OPEN-only, so a branch
  reused after its first pull request merged can still get a second -- `pickPullRequest`'s own
  reasoning, from the other direction.
- **A branch that already has one open is reported at exit 0, not refused.** "Unless one already
  exists" is what makes the command safe to re-run without first working out whether the last run
  got that far, and an error exit would make every wrapper treat the idempotent case as a failure.
- **What Bitbucket answered is what gets reported, never what was sent.** That API silently accepts
  and drops fields it does not recognise: the create FORM's `title=` and `description=` query
  parameters were documented as working for months, on a probe whose source branch had nothing for
  Bitbucket to derive a title from, and they had never worked at all. So both writes parse the
  response through the same parser a read uses (`parseDetail`, shared by the list, the `POST` and
  the `PUT` -- a second parser would be free to disagree about a field, which is exactly what the
  read-back is looking for), and `readBackDisagreements` compares the answer with the request.
- **`draft` is the one disagreement that is fatal, and it has a ladder** -- kept even though the
  create call's `draft` field is documented, because a documented field is not a measured one and
  the cost of being wrong here is one-way. A wrong title is worth a
  warning and is fixable on the page; a pull request that opened ready for review is not. So
  `pr create` opens a DRAFT by default (`--ready` is the positive opt-in, so the safe state is the
  one you get by saying nothing), reads `draft` back, asks a second time through an update if it
  came back wrong, reads it back again, and only then fails -- naming the pull request that now
  exists and is not a draft. `pr update` leaves the draft state exactly as it is unless `--draft`
  or `--ready` names it: silently publishing a draft while fixing a typo in its description is the
  surprise that rule exists to prevent.
- **The `PUT` is a read-modify-write, and `reviewers` is why.** Atlassian's documentation for the
  update call is three sentences long and says nothing about what happens to a field the body
  omits, so whether a partial update preserves or clears `reviewers` is not answered by either
  published spec -- and finding out costs somebody's review assignments. So `PullRequestEdit`
  names every field it sends and `pr update` fills the unchanged ones from `pullRequestDetail`. The
  one optional member is `draft`, absent meaning "leave it alone", which also keeps an ordinary
  update from tripping over that field at all if it turns out not to be writable here.
- **The body is read from `summary.raw` and only then from `description`.** The two published
  specs declare `summary` -- a rendered-content object -- on the way out, while `description` is
  the name the create and update calls TAKE and appears only in the prose of `POST /pullrequests`.
  The live API returns both, byte-identical (same sha256 over 3235 characters, `markup: markdown`).
  Preferring the documented one matters here because this is a read-modify-write: a body that read
  as empty would replace somebody's description with nothing.
- **Every endpoint, field and enum these two commands use was checked against the published
  OpenAPI document**, and it is worth knowing which one: `api.bitbucket.org/swagger.json` is
  Swagger 2.0 and `developer.atlassian.com/cloud/bitbucket/swagger.v3.json` is the same content
  as OpenAPI 3.0 (171 paths in both, and identical on every point checked -- the second is not a
  newer or better-maintained source). `draft` on the create call is documented there, as are
  `close_source_branch`, `reviewers` and `description`; `state` on the pull-request list is
  documented with the four-value enum this code now maps in full. Two things these documents do
  NOT carry, both established by measurement rather than reading: that `q` overrides the `state`
  parameter, and that `fields` -- which every call here uses -- is not declared as a parameter
  anywhere in either document, only in the REST intro's prose.
- **`pr update` rewrites only pull requests the token owner authored, and that is enforced HERE.**
  The API permits anyone with write access to rewrite anyone's, so there is no permission to
  delegate this to: `tokenOwner` asks `GET /2.0/user` and the answer is compared with the pull
  request's `author.uuid`. Both go through `bareUuid`, because Bitbucket brackets uuids in some
  payloads and not in others and comparing the raw strings fails in the SAFE direction -- "not
  yours" for your own pull request, which nobody would investigate. A token that cannot answer
  `/2.0/user` at all (a repository-scoped access token) is a REFUSAL rather than a skipped check.
- **Which clone comes from where the command was run, and inside a clone it cannot be overridden.**
  `cloneForCwd` first; an argument naming a different clone is refused, and from the hangar root
  the argument is required. This is the fleet's own "stay in your own clone" rule reaching the one
  command whose mistake is published -- a pull request opened for the branch next door is on
  somebody's review queue before anybody notices. It is also why there is no `--all`.
- **Origin is fetched before it is judged, on the dry run too.** `onOrigin` and `ahead` read
  remote-tracking refs, and a stale one gives exactly the wrong answer: a branch reported as
  unpushed that was pushed an hour ago, or -- far worse -- as pushed while the last three commits
  are local, which opens a pull request that reads as complete and is missing the work its
  description describes. Only `refs/remotes` moves, so no local branch and no file in the working
  tree is touched, which is what makes it acceptable under `-n`. Both refusals print the `push`
  command and neither offers to run it: pushing is the user's own action.

### The description is delegated, and the freshness rule is the shared store's fault

A reviewer-facing description is not something a deterministic CLI can write, so `pr create` does
not try. The repo's own agent writes one into the shared `tmp/` store and `pr-description.ts`
FINDS it -- the same split `resolve-conflicts.ts` makes for a merge conflict, through the same
`claude-headless.ts` runner, which was extracted from that file rather than copied when this
became its second caller.

- **The root searched is the CLONE's own `tmp/`, not the hangar's shared store**, and that is the
  difference between this working and not. Every entry under a clone's `tmp/` is a symlink into the
  store, so the clone root reaches everything the store holds -- but a ticket directory the clone's
  agent created during the session that is still running is a REAL directory there, unmerged:
  `tmp merge` runs at `SessionEnd`, which is strictly after the moment somebody wants a pull
  request for the branch they have just had described. Searching the shared store instead finds
  nothing in exactly the normal case, spawns a run, and then reports that the run left no
  description. It is also the narrower read -- another clone's description for the same ticket is
  the last-writer-wins hazard, and this way it is not consulted until that clone's session has
  ended.
- **The filename is matched, never constructed.** Hangar manages any repo: this fleet alone has
  used `pr-ABC-1323.md` at the top level and `ABC-1323/pr_description_ABC-1323.md` in the ticket's
  own directory. So both are matched by pattern against the issue key `inferTicket` already derives
  from the branch, in exactly two places -- the top level and the key's own directory -- because
  the shared store here holds a couple of hundred ticket directories and a walk would be paid on
  every invocation. A `.from-<clone>` conflict copy is skipped: `tmp merge` writes one for the copy
  that did NOT win, so picking one up would publish the losing half of a conflict.
- **A branch with no issue key gets the flat fallback, marked UNTRUSTED.** That name belongs to no
  branch in particular and every clone writes into this store, so the command prints the path and
  the title it read and warns before anything is published. Refusing outright would leave a chore
  branch no route through the command at all.
- **Stale is the description's mtime against the branch tip's committer timestamp**, and it is a
  real failure rather than a corner: `tmp/` is shared across every clone and last-writer-wins, so a
  description written before the last commit is the normal way this goes wrong. The units are the
  trap -- `git log --format=%ct` is SECONDS and an mtime is milliseconds, and a caller that forgot
  to multiply makes every description on disk read as fresh for ever, which looks exactly like the
  feature working. `test/pr-create.test.ts` pins what that mistake would look like.
- **`forge.prDescriptionPrompt` is optional with no default**, and absent means the delegation is
  off. A built-in default would put one repository's slash command in a published CLI and make
  every other hangar spawn a run with nothing to do.
- **A clone with a live session is not regenerated into.** Two agents in one working directory is
  this fleet's worst failure, and the session already there has the conversation that produced the
  branch, so it is better placed to write the description anyway. `--include-busy` is for when the
  "live session" is a shell somebody left open.
- **`-n` never spawns the run**, and the MCP tools cannot reach it at all: `pr_create` and
  `pr_update` fix `--no-describe`. A regeneration is one to three minutes of streamed progress
  with a line the operator can type into it; through a tool call that is a request which blocks for
  minutes and then dies at the caller's timeout mid-run, with none of the stream reaching anybody
  -- and being able to watch it is the whole reason it streams. The tool refuses and names the
  command to type, the same trade `ALWAYS_HIDDEN` already makes for `--quiet`.
