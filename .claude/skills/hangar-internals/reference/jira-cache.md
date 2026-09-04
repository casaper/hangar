# The shared `tmp/` store, the Jira record store and the cache hook

`app/src/commands/tmp.ts` (607), `jira-records.ts` (373), `dedupe.ts` (311), `adopt.ts` (162) and
`commands/jira.ts` (432). Also covers `plans collect`, which shares the never-overwrite rules.

- **`hangar plans collect` and `tmp merge` move files between the clones and the fleet root.**
  Both are idempotent and neither ever overwrites: byte-identical copies collapse to one, anything
  that differs is kept beside the winner as `<name>.from-clone_NN`, and anything a live session may
  still be writing is left where it is and reported. Run them again rather than forcing them.
  It also makes **one record per ticket** in `tmp/jira-tickets/`, with every cached name a hard
  link to it — see **Shared `tmp/`** below, and note that a relation copy loses its
  `relation:`/`relatedTo:` frontmatter when it is linked, because one inode cannot name two
  trunks.
  **`tmp merge` never touches a PID file — it does not move, link or even read one** — so every
  clone keeps its own `tmp/` directory and its own PID files in it, and a running dev server is no
  obstacle to running the command. Only the cache entries inside `tmp/` are shared, one symlink
  each. It moves every clone's cache into the store BEFORE it links any of it back, so a conflict
  copy created for the last clone still reaches the first. See **Shared `tmp/`** below.
  **Each clone runs `tmp merge --quiet` from a `SessionEnd` hook**, so a ticket first fetched in
  one clone reaches the others when that session ends. It is `SessionEnd` and not a trigger on
  the write itself for a reason that cannot be tuned away: the store pass deliberately leaves
  alone any copy written in the last two minutes, so a hook firing BECAUSE a ticket was just
  written would arrive inside its own exclusion window every time and do nothing. Nothing
  watches `tmp/` — the run happens once, at the end of a session, when nothing is mid-write.
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
skills leave there — which lives in `~/code/dvb_gn/tmp/<name>` with `clone_NN/tmp/<name>` a
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
anything that differs is kept beside the winner as `<name>.from-clone_NN` (and is then linked
everywhere like any other entry — review the pair and delete the loser), and a link that already
points where it belongs is left alone rather than rebuilt. It shares everything except PID files
and dotfiles — a **blocklist**, so a file a skill starts caching tomorrow is shared without
anyone editing a table. `-n` previews, and names any entry two clones both offer, since which of
the two wins is decided from what is on disk and a dry run has moved nothing.

**One ticket lands in the store under several names, and `tmp merge` collapses them onto one
file.** The `jira-scope` skill gives a directory only to the ticket the user asked about, so a
ticket fetched as a relation is written into the asking ticket's directory:
`ABC-1325/ticket_ABC-1325_relates_to_ABC-1323.md` **is ABC-1323**. The **last** issue key in a
filename is what the file contains; the keys before it only say how it was reached (and the same
holds for an attachment — `ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png` is ABC-1191's
attachment). Three things follow:

- **Every ticket has ONE record: `tmp/jira-tickets/ABC-1234.md`**, and every cached name for that
  ticket is a **hard link** to it — its own `tmp/ABC-1234/ticket_ABC-1234.md` and every
  `tmp/<TRUNK>/ticket_<TRUNK>_<relation>_ABC-1234.md`. One ticket is one inode however many
  investigations reached it. This directory is deliberately **not** linked into the clones like
  every other store entry: no skill owns that path, and a symlink in `clone_NN/tmp/` would
  invite an agent to write into it.

  **The record cannot carry `relation:`/`relatedTo:`, and that is a proof rather than a taste.**
  Those keys name the trunk a copy was reached from, and a ticket reachable from two trunks
  would need one inode holding two different `relatedTo:` values. So the record is the winning
  copy with those two lines removed, and each relation copy loses them when it is linked. The
  filename still says `_relates_to_`, and the trunk's own `relations:` / `parent:` /
  `subtasks:` frontmatter still states the relation and its label, so nothing is unrecoverable —
  it is printed every time it happens. Nothing in the skill reads a cached record (`sync.mjs`
  has no `readFileSync` at all), so the stripped keys change what a reader sees and nothing else.

  **A ticket's OWN record wins over a relation copy regardless of age**; `fetched_at:` only ranks
  peers. That is the rule the old freshest-wins collapse lacked, and its absence is what put
  ABC-1259's and ABC-1323's own records into a state where they read as though they hung off
  another ticket. The store makes it unreachable rather than merely warned about. A copy written
  in the last two minutes is left alone — a session may be mid-refresh, and this pass replaces
  content — and a copy whose `id:` disagrees with its filename is reported and never linked.

  The one thing that does **not** collapse: **a ticket with attachments, cached under two
  different trunks.** Asset references in the body are trunk-specific
  (`ticket_ABC-1323_relates_to_ABC-1191_asset_shot.png`), so one shared record cannot carry
  correct references for both; the copy whose references differ is kept as its own file and
  reported. Tickets with no attachments — most of them — link freely.

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
  `jira-scope` wrote the bare names, the newer `jira-ticket-sync` contract writes the `_at` ones,
  and matching only one sent every synced file to the file-mtime fallback. Markdown only: a
  differing pair of _assets_ under one name is a download that went wrong, not a newer
  rendering, so neither is preferred. `-n` prints every choice before any of it happens.

**A ticket fetched in the last hour is not fetched again.** `hangar jira hook` is a
`PreToolUse` hook, wired into each clone's untracked `.claude/settings.local.json` by absolute
path (`doctor` checks it, `--fix` wires it). It reads the Bash command Claude Code is about to
run; when every file a `jira-ticket-sync/sync.mjs` run would write is already on disk and inside
the TTL, it hard-links from the record store whatever is missing and **denies** the command,
telling the agent what it got instead. Five properties are the whole design:

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
  `jira-scope/jira-cache.mjs name`, one subprocess per file. `paths.mjs` calls itself the single
  owner of every filename in that directory, it is tracked and branch-versioned, and an
  untracked copy of `stemFor` here would drift the first time a branch changed a relation slug.
- **It never hands back a worse copy than the clone already has.** This is the case immediately
  after any real fetch: `sync.mjs` replaces the inode, so the clone holds the fresh copy while
  the store still holds the previous one until the next `tmp merge`. Linking then would put the
  OLDER record over the newer file and report it as cached. So a destination whose own
  `fetched_at:` is at least as fresh as the store record's is left exactly where it is and
  counted as satisfied — the file that run would have written is present and fresh, just not by
  way of the store.
- **Whether Jira changed cannot be known without asking Jira**, so the TTL (`--ttl <minutes>`,
  default 60) is the whole of the freshness guarantee. `JIRA_SYNC_NO_CACHE=1` in front of the
  command bypasses the hook — an env var and not a flag, because `sync.mjs` dies on an unknown
  flag.

None of this needs anything from the clones. Their `.claude/` is shared with every other
contributor and must work without this fleet, so the record store appears in no tracked file: the
skill writes exactly what it always wrote, and `tmp merge` and the hook do the rest.

The old per-key mechanism — `tmp/<KEY>` linked into `~/.claude/dvb-gn-jira` by
`hangar jira link` — is **gone**, and so are that command and the pass that drained the old store
into this one. The store is `~/code/dvb_gn/tmp`, and `tmp merge` links every entry rather than
only the `DN-####` directories (which left `pr-*.md` and `author-aliases.md` unshared in whichever
clone made them).

This needs **no change to the tracked skill tooling**:
`.claude/skills/jira-scope/jira-cache.mjs` hardcodes `<git toplevel>/tmp/<KEY>` with no
configuration, but only ever does `mkdirSync(..., {recursive: true})` on it, which follows a
symlink.

`ticket_<KEY>.md`, its relation variants and Jira attachments are clone- and branch-independent,
which is the point. **A PR description is not** — it is derived from the working-tree diff, so it
is shared as a side effect and is last-writer-wins when two clones work one ticket at once. One
ticket normally belongs to one clone, so this is bounded, but do not trust a PR description you
did not just generate in this clone.

`tmp/` is gitignored by the tracked `tmp/` rule, which matches the real directory and everything
under it — the per-entry links included. So nothing about `tmp` belongs in `.git/info/exclude`;
that file is back to hiding `/CLAUDE.local.md` alone. A clone that still carries the old `/tmp`
line is fine — it excludes something already ignored.
