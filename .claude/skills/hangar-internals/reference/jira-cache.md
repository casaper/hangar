# The shared `tmp/` store, the Jira record store and the cache hook

`app/src/commands/tmp.ts` (607), `jira-records.ts` (373), `dedupe.ts` (311), `adopt.ts` (162) and
`commands/jira.ts` (432). Also covers `plans collect`, which shares the never-overwrite rules.

- **`hangar plans collect` and `tmp merge` move files between the clones and the fleet root.**
  Both are idempotent and neither ever overwrites: byte-identical copies collapse to one, anything
  that differs is kept beside the winner as `<name>.from-<clone>`, and anything a live session may
  still be writing is left where it is and reported. Run them again rather than forcing them.
  It also keeps **one record per ticket** in `tmp/jira-tickets/`, with every cached name a
  relative symlink to it — see **Shared `tmp/`** below, and note that a record carries no
  `relation:`/`relatedTo:` frontmatter, because one record cannot name one trunk.
  **`tmp merge` never touches a PID file — it does not move, link or even read one** — so every
  clone keeps its own `tmp/` directory and its own PID files in it, and a running dev server is no
  obstacle to running the command. Only the cache entries inside `tmp/` are shared, one symlink
  each. It moves every clone's cache into the store BEFORE it links any of it back, so a conflict
  copy created for the last clone still reaches the first. See **Shared `tmp/`** below.
  **Each clone runs `tmp merge --quiet` from a `SessionEnd` hook.** A clone that can reach the
  record store writes into it, so a ticket fetched there is already the fleet's one copy and
  needs no delivering; what the run does is converge what a flat-layout clone wrote and repair
  the names that should point at the store. It is `SessionEnd` and not a trigger on the write
  itself for a reason that cannot be tuned away: the pass leaves alone any copy written in the
  last two minutes, because it REPLACES content and a session may be mid-refresh — so a hook
  firing BECAUSE a ticket was just written would arrive inside its own exclusion window every
  time and do nothing. Nothing watches `tmp/` — the run happens once, at the end of a session,
  when nothing is mid-write.
  Quiet mode holds the whole narration and prints it only if something needs a human (a
  conflict copy, a name it could not link, a record whose frontmatter disagrees with its
  filename, a stray PID file); the two-minute guard is explicitly not one of those, because the
  next session end resolves it. The two `--quiet` commands are built differently and flush on
  opposite criteria — `plans collect` buffers locally and prints when something MOVED, `tmp merge`
  captures at the `ui.ts` level and prints only when something WARNED — so a third one copies
  whichever matches its outcome rather than unifying them. Not having the hook costs one wasted
  re-fetch in a sibling and never a wrong answer — `jira hook` reads `fetched_at:` out of the file
  and refuses to hand back anything older than the copy the clone already holds.

## Shared `tmp/`

Every clone **keeps its own `tmp/` directory**. What is shared is the content in it that belongs
to no clone in particular — the per-ticket Jira cache, the PR descriptions, whatever else the
skills leave there — which lives in the hangar's own `tmp/<name>` with `<clone>/tmp/<name>` a
**symlink per entry** in every clone. A ticket fetched in one clone reaches the others at the next
`hangar tmp merge`.

**The links go one level down, and `tmp/` itself is never a symlink.** `tmp/` also holds the
dev-server PID files: `dev/run-with-pid.mjs` refuses a name that is already live and
`node dev/pids.mjs --kill <name>` finds a server by that file, so a shared `tmp/` would let the
first clone to start a dev server block every other clone and let a kill reach into a sibling. With
the links one level down, **PID files are never moved, linked or even read** — a running dev
server is no obstacle to sharing, and nothing has to have landed on a clone's branch first.
Whether a clone writes `tmp/<name>.pid` or `tmp/_<clone>/<name>.pid` is its branch's business and
matters to nobody else. A `tmp` that IS a symlink is the shape an earlier version of `tmp merge`
produced: `tmp merge` turns it back into the clone's own directory of links, and `doctor` reports
it.

`hangar tmp merge` is idempotent and never overwrites: byte-identical copies collapse to one,
anything that differs is kept beside the winner as `<name>.from-<clone>` (and is then linked
everywhere like any other entry — review the pair and delete the loser), and a link that already
points where it belongs is left alone rather than rebuilt. It shares everything except PID files
and dotfiles — a **blocklist**, so a file a skill starts caching tomorrow is shared without
anyone editing a table. `-n` previews, and names any entry two clones both offer, since which of
the two wins is decided from what is on disk and a dry run has moved nothing.

**One ticket is reached under several names, and every one of them points at one file.** The
tracker skill gives a directory only to the ticket the user asked about, so a ticket reached as a
neighbour is named inside the asking ticket's directory. A cached name therefore says which
ticket the FILE holds, never which one was asked about.

**Two namings are live at once, and that is structural rather than transitional.** The skill is
tracked and branch-versioned, so a clone on an older branch writes the flat naming while its
siblings write the store one:

    store   ABC-1349/ticket.md              ABC-1349/ticket_relation_ABC-1343.md
    flat    ABC-1349/ticket_ABC-1349.md     ABC-1349/ticket_ABC-1349_relates_to_ABC-1343.md

In the store naming the trunk key is not in the filename at all — `ticket.md` takes its key from
the DIRECTORY — and a neighbour carries the KIND (`parent`, `subtask`, `sibling`, `relation`)
rather than Jira's own label, because the direction belongs in the record and a filename can
contradict it. In the flat naming the **last** key is what the file holds and the keys before it
only say how it was reached. Either way an attachment belongs to the key immediately before
`_asset_`.

**`ticketNameOf` in `jira-records.ts` is the one owner of that question, and it takes the
containing directory as well as the name.** Three callers ask it — the record walk, the grouping,
and the freshest-wins collapse that must leave records alone — and it is one function rather than
a test each of them applies, because a miss here is SILENT. When the skill moved the key out of
the filename nothing matched, the walk returned nothing, and the store pass returned **before
printing its own heading**: not doing less, doing nothing, while the command reported success and
every gate stayed green. The absence of that heading in `tmp merge -n` is what tells a dark pass
from an idle one. Change the predicate without changing the collapse's copy of it and records
fall into the freshest-wins rule the store exists to override — quietly, and in the other
direction.

**A name is never rewritten from one naming to the other, only re-pointed.** The older skill asks
for its own spelling back, so a renamed file would send it fetching for ever. Both names
coexisting in one directory, pointing at one record, is the correct state.

Four things follow:

- **Every ticket has ONE record: `tmp/jira-tickets/ABC-1234.md`**, and every cached name for that
  ticket is a **relative symlink** to it — `../jira-tickets/ABC-1234.md`, from whichever trunk
  directory reached it.

  **That directory IS linked into every clone, and writing through the link is the mechanism.**
  The skill resolves the record store beside the per-ticket directories and writes every record
  there, so a record written in a clone already is the fleet's one copy rather than something a
  later merge has to collect. A clone that cannot reach it keeps a private store instead, whose
  records are then the only copies of themselves — `foldCloneStore` folds one back, and does so
  itself rather than through `adoptInto`, whose hash compare would keep a difference as
  `ABC-1234.from-clone_NN.md` **inside** the canonical store, under a name no pass reads as a
  record and no later merge would ever find.

  **`storeLinkTarget` is deliberately not `relative()` of the two absolute paths.** A cached name
  always sits one level under a `tmp/` holding the store beside it, so `../jira-tickets/<KEY>.md`
  is the answer from any trunk directory — and it is the only answer that survives how a clone
  reaches one. `<clone>/tmp/ABC-1349` is an absolute symlink into the hangar's own `tmp/`, so the
  link is created in the hangar's directory whatever path named it, and `..` there is the
  hangar's `tmp/`. Computed from the clone's absolute path it would answer
  `../../../tmp/jira-tickets/ABC-1349.md`, which from where the link actually sits climbs out to
  the filesystem root. `linkToStore` resolves the staged link and compares it with the record
  before putting it in place, so a broken assumption is a refusal rather than a cache of links
  that quietly reach nothing.

  **A symlink also makes a rewrite reach every name by itself.** `writeStoreRecord` replaces the
  store record's inode, and a symlink names a path — so nothing needs re-pointing when the
  record changes. A hard link would have to be remade after every write, and asking whether one
  is still in place is a question about two inodes rather than about the name itself.

  **The record cannot carry `relation:`/`relatedTo:`, and that is a proof rather than a taste.**
  Those keys name the trunk a copy was reached from, and a ticket reachable from two trunks would
  need one record holding two different `relatedTo:` values. So the record is the winning copy
  with those two lines removed. The skill writes them whenever it fetches a ticket AS a
  neighbour, naming whichever trunk happened to reach it first, so the strip is a normalisation
  this pass performs rather than a disagreement with the skill: the clone side documents the
  record as carrying neither. How a trunk reached a ticket is in the link's NAME, and the trunk's
  own `relations:` / `parent:` / `subtasks:` frontmatter still states the relation and its label,
  so nothing is unrecoverable — and it is printed every time it happens. Nothing in the skill
  reads a cached record (`sync.mjs` has no `readFileSync` at all), so the stripped keys change
  what a reader sees and nothing else.

  **A ticket's OWN record wins over a neighbour regardless of age**; `fetched_at:` only ranks
  peers. That is the rule the old freshest-wins collapse lacked, and its absence is what put two
  tickets' own records into a state where they read as though they hung off another ticket. The
  store makes it unreachable rather than merely warned about.

  Which of the two says so depends on the naming, and they never both apply to one file: in the
  store naming the NAME is authoritative, because a neighbour link resolves to that ticket's own
  record and carries no `relation:` key at all; in the flat naming the FRONTMATTER is, because a
  flat neighbour is a distinct file with its own. Reading only the frontmatter would call every
  store neighbour an own record and hand the winner rule the wrong pool. A copy written in the
  last two minutes is left alone — a session may be mid-refresh, and this pass replaces content —
  a copy whose `id:` disagrees with its filename is reported and never linked, and a link that
  reaches no record at all is reported too: reading through one throws, so it falls out of the
  grouping and would otherwise be repaired by nothing and mentioned by nobody.

  The one thing that does **not** collapse: **a FLAT copy of a ticket with attachments, cached
  under two different trunks.** There an asset is named after the path it was reached by
  (`ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png`), so one shared record cannot carry
  correct references for both; the copy whose references differ is kept as its own file and
  reported. The store names an asset after the ticket that OWNS it
  (`ABC-1191_asset_shot.png`, beside that ticket's own record), which is what makes those
  references correct from either trunk and lets the record collapse like any other.

  `assetRefsIn` reads both spellings, and missing one is not a quiet loss of precision: the cache
  hook checks that every reference resolves beside the destination before it denies a fetch, so a
  pattern matching nothing would let it deny one having linked no attachments at all.

- **Byte-identical files elsewhere in the store are hard-linked**, by `jdupes -L` (`-A` skips
  dotfiles, `-X noext:pid` keeps PID files out, and it treats already-linked files as
  non-duplicates, so a re-run does nothing). Not reimplemented and not `fdupes`, which has no
  hard-link action at all. **Attachments** are what this is for now that ticket records have
  their own store: a 4 MB recording fetched under two relation paths is one file twice.
  **Install it (`brew install jdupes`) or the pass is skipped with a warning** — the rest of the
  merge is unaffected.
- **Everything else about a ticket that differs under one canonical name** — `plan_<KEY>.md`,
  `pr_description_<KEY>.md` — still collapses onto the **freshest** copy, where freshest-wins is
  the whole of the right answer. Freshness is `fetched_at:` / `fetched:` frontmatter (Jira's
  `updated_at:` is only a fallback — it is written on a ticket's own file and left off the
  relation copies, so it cannot rank the two against each other). **Both spellings are read:**
  the bare names and the `_at` ones, since both generations of the cache are on disk at once, and
  matching only one sent every synced file to the file-mtime fallback. Markdown only: a
  differing pair of _assets_ under one name is a download that went wrong, not a newer
  rendering, so neither is preferred. `-n` prints every choice before any of it happens.

  **The whole frontmatter block is read, and no fixed window will do.** A record's block is a
  neighbourhood listing, so its length is a function of how many parents, sub-tasks, siblings and
  relations the ticket has — which is data this repo does not own. A window ending inside the
  block finds no closing delimiter, nothing matches, and freshness silently becomes the file's
  mtime. That is not a slightly worse answer:
  **the cache hook REFUSES to serve a record whose timestamp came from mtime**, since an mtime is
  not evidence about when the tracker was asked — so a window one line too small turns the whole
  ticket cache off, with the hook wired, present, reported green by `doctor`, and declining every
  time. Measured against a 4096-character window on a live store: the closing delimiter sat at
  character 4398 of a 6515-character record, and **every** record in the store missed it. A
  bigger number only moves the bug to the first ticket with enough relations, and a window buys
  no I/O anyway — the whole file is read either way and a slice would only shorten what the regex
  sees.

**A ticket fetched in the last hour is not fetched again.** `hangar jira hook` is a `PreToolUse`
hook, wired into each clone's untracked `.claude/settings.local.json` by absolute path — **but only
where `tracker.kind` is not `none`** (see below). It reads the Bash command Claude Code is about to
run; when every file a `tracker.syncScript` run would write is already on disk and inside the TTL,
it points whatever is missing at the record store and **denies** the command, telling the agent what
it got instead. Five properties are the whole design:

- **It fails open.** A flag it does not know, a frontmatter shape it cannot read, a record with
  no parsable timestamp, a shell construct in the tail — all exit silently and let the fetch
  happen. A hook that wrongly denies leaves an agent unable to read a ticket for reasons
  invisible from inside the clone. `--explain` prints the reason it declined, which is the only
  way to debug something that is silent by design; `-n` decides without linking.
- **All or nothing.** A run writes the trunk AND its parent, sub-tasks and relations, so the
  neighbourhood is read out of the CACHED trunk's own frontmatter and every one of those tickets
  must also be in the store and fresh. An OLD-format record has those keys absent rather than
  empty, and absent is declined — reading it as "no neighbours" would turn a full sync into one
  linked file.
- **It never reimplements the naming.** Where each file belongs comes from that clone's own
  `tracker.namerScript`, one subprocess per file. In this hangar that is
  `jira-scope/jira-cache.mjs name`; `paths.mjs` calls itself the single owner of every filename
  in that directory, it is tracked and branch-versioned, and an untracked copy of `stemFor` here
  would drift the first time a branch changed a relation slug.
- **It never hands back a worse copy than the clone already has.** This is the case after a fetch
  a flat-layout clone made: the write replaces the inode, so the clone holds the fresh copy while
  the store still holds the previous one until the next `tmp merge`. Linking then would put the
  OLDER record over the newer file and report it as cached. So a destination whose own
  `fetched_at:` is at least as fresh as the store record's is left exactly where it is and
  counted as satisfied — the file that run would have written is present and fresh, just not by
  way of the store.
- **Whether Jira changed cannot be known without asking Jira**, so the TTL is the whole of the
  freshness guarantee. It comes from `tracker.cache.ttlMinutes`, and `--ttl <minutes>` overrides
  it. `<tracker.cache.bypassEnvKey>=1` in front of the command bypasses the hook — an env var and
  not a flag, because the sync script dies on an unknown flag.

## The hook is wired only where a tracker is declared

`tracker.kind` has defaulted to `none` since the schema was written, and every consumer that reads
tracker DATA branches on it — `issueUrl`, this hook's own decline, `tmp merge`'s record-store pass,
`status`'s issue row, `secrets.ts`'s `ATLASSIAN_*` variables, `setup`'s blank-means-none question
and both `CLAUDE.local.md` builders. **The wiring did not.** `withJiraHook` read no config, so a
hangar with no tracker got the hook in every clone anyway, `doctor` reported it *missing* when it
was correctly absent, and `--fix` installed it.

`status`'s issue row had the same shape of bug and is fixed with it: its own header claimed it
distinguished "no key in this branch" from "this hangar has no tracker", while the no-key arm
returned before anything read the config. So a tracker-less clone was told its BRANCH was named
wrong — a complaint about a convention that hangar never adopted — and a branch carrying a
key-shaped token was told `tracker.baseUrl` was missing, which names the one key that is not the
reason. The `kind` check now comes first, and `statusOf` skips `inferTicket` entirely when there
is no tracker: a branch with no key in its name sends it to `git merge-base` and `git log`, so
`status --all` was spending two subprocesses per clone deriving a key for a row that could only
ever say there is no tracker.

That is the same defect as the four literals below, one level up: obeyed in the one hangar that
happens to want it, and imposed on every other. It is not dangerous — the decline above is the
first thing this hook does, before any filesystem walk — but a `PreToolUse` matcher on `Bash`
starts a Node process on **every Bash tool call in every clone**, and paying that forever to be
told "this hangar declares no tracker" is not a cache.

So `withJiraHook` reconciles: it filters its own matchers, then appends only when a tracker is
declared. Switching a hangar from `jira` to `none` therefore REMOVES the hook at the next
`doctor --fix` rather than leaving it wired, which matters because a running session never sees a
settings change — the clone keeps spawning the process until it restarts either way, and without
the removal it would keep doing so for good. `hangar-internals/reference/doctor.md` has the row,
and why the removal test is deliberately weaker than the presence test.

## The four `tracker.*` keys this hook runs on, and what they do NOT make configurable

`cache.bypassEnvKey`, `cache.ttlMinutes`, `syncScript` and `namerScript` are read from the
config. All four were literals for a long time — `JIRA_SYNC_NO_CACHE`, 60, and this repo's two
skill paths — beside a schema that declared every one of them. That is the same defect
`forge.tokenEnvKey` turned out to be, and it fails the same way: **it is obeyed in the one hangar
whose config happens to spell the same literal, and silently ignored everywhere else.**

`bypassEnvKey` reached furthest, because the hangar-root `CLAUDE.md` is prepended to every clone
session and tells agents that setting `tracker.cache.bypassEnvKey` in front of the command
bypasses the cache. Its schema DEFAULT is `HANGAR_TRACKER_NO_CACHE`, so a hangar that omitted the
key was told one name by `hangar config show` and obeyed another — a denial with no clue why.

Two things stay fixed on purpose:

- **The ARGV CONTRACT.** Whatever `syncScript` names is still invoked `<script> <KEY>… [flags]`
  with `--no-relations`/`--no-assets`/`--quiet`/`--json` the only flags recognised, and whatever
  `namerScript` names is still asked `name <TRUNK> [relation] [KEY]` and expected to print one
  path. These keys make the PATHS configurable, not the interface. A script that answers
  differently is not a plug-in replacement.
- **No fallback when either is absent.** Both are optional in the schema, and an absent one is a
  normal fail-open decline (`this hangar declares no tracker.syncScript`). Falling back to
  `.claude/skills/…` would be the same literal `add-clone` used to carry for `forge.originUrl`,
  where the fallback meant another hangar silently got this fleet's repo.

The command is matched on the **last two segments** of the declared path, so `node
.claude/skills/issue-sync/sync.mjs UI-42` and a bare `node issue-sync/sync.mjs UI-42` both hit —
an agent types it both ways, and the fixed literal it replaced was a two-segment tail too.

None of this needs anything from the clones. Their `.claude/` is shared with every other
contributor and must work without this fleet, so the record store appears in no tracked file: the
skill writes exactly what it always wrote, and `tmp merge` and the hook do the rest.

The old per-key mechanism — `tmp/<KEY>` linked into `~/.claude/<id>-jira` by
`hangar jira link` — is **gone**, and so are that command and the pass that drained the old store
into this one. The store is the hangar's own `tmp/`, and `tmp merge` links every entry rather than
only the `DN-####` directories (which left `pr-*.md` and `author-aliases.md` unshared in whichever
clone made them).

**Whether a destination is already pointing at the store is asked as a link TARGET, not by
comparing two inodes.** The inode compare answered `undefined` for a path it could not stat, so
two failures compared equal — a store record that vanished between the plan and the link made
every destination look linked, and the hook denied the fetch while naming files that were not
there. That is the one outcome a cache must never produce, since an agent then cannot read a
ticket for a reason invisible from inside the clone.

`ticket_<KEY>.md`, its relation variants and Jira attachments are clone- and branch-independent,
which is the point. **A PR description is not** — it is derived from the working-tree diff, so it
is shared as a side effect and is last-writer-wins when two clones work one ticket at once. One
ticket normally belongs to one clone, so this is bounded, but do not trust a PR description you
did not just generate in this clone.

`tmp/` is gitignored by the tracked `tmp/` rule, which matches the real directory and everything
under it — the per-entry links included. So nothing about `tmp` belongs in `.git/info/exclude`;
that file is back to hiding `/CLAUDE.local.md` alone. A clone that still carries the old `/tmp`
line is fine — it excludes something already ignored.
