---
name: shorten-all-comments
description: |
  Sweeps EVERY comment in the files you name — not just the ones a diff touched — applying the shorten-comment judgment to each, editing in place behind a revertable snapshot. Use when the user names files and asks to clean up all their comments: "shorten all the comments in this file", "the JSDoc in these three services is bloated", "strip the comment noise from grid.component.ts". Requires one or more file paths and refuses to run without them; there is no "sweep the branch" mode, because a whole-file pass rewrites comments that predate the branch. For comments a diff touched, use shorten-changed-comments; for one comment the user points at, use shorten-comment.
argument-hint: '<file> [<file>…] [low|medium|high]'
allowed-tools: Read, Edit, Grep, Glob, Bash, Agent, AskUserQuestion
---

# Whole-File Comment Sweep

`shorten-changed-comments` asks "what did this branch touch?". This skill asks "what is in these
files?" — every comment, however old. That makes it the right tool for a deliberate clean-up and
the wrong one for a pre-commit pass.

**The blast radius is the thing to keep in mind.** These edits land on comments nobody in this
session wrote, they rewrite `git blame` for those lines, and mixed into feature work they make a
branch hard to review. Hence the count gate in Step 3 and the commit rule in Step 6.

## Step 1: Paths, or stop

```bash
node .claude/skills/shorten-all-comments/find-all-comments.mjs <path> [<path>…]
```

**Paths are required.** With none, the script exits 1 and so do you — do not substitute a guess,
do not fall back to the changed files, and do not offer to sweep the whole directory. If the user
asked for a sweep without naming files, ask which files.

| Situation                                    | What happens                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no paths                                     | exit 1 with usage. Ask the user which files.                                                                                                             |
| some paths missing or unlexable              | each is named under `Skipped`, the rest proceed. **Repeat the skipped list to the user** — a silently dropped file reads as swept.                       |
| every path missing                           | exit 1. Report it; sweep nothing.                                                                                                                        |
| a directory                                  | refused. Pass a shell glob (`'src/app/foo/*.ts'`) or name the files.                                                                                     |
| an excluded path (`*.spec.ts`, `.claude/**`) | included, with a `NOTE:` line. Naming a file **is** the Step 0 override in `shorten-comment` — say once that it is normally out of scope, then continue. |

Blocks come back **bottom-to-top within each file**, and that is the order to edit in: every span
still on the list stays correct as edits land below it. Directive comments (`eslint-disable`,
`@ts-expect-error`, `prettier-ignore`, `#region`) are filtered out — they carry machine meaning and
are never edited, at any level.

Each block carries an `oldString` already grown to be unique in its file. **Use it as the Edit
`old_string`.** A whole-file sweep is exactly where near-duplicate comments cluster, and Edit
refuses a non-unique match.

## Step 2: Snapshot before any edit, and before any worker

This skill edits without asking per comment, so the snapshot is what makes that safe. Take it
**before the first Edit and before dispatching any subagent** — a worker that starts editing while
the parent is still setting up its safety net has none.

```bash
git status --porcelain > /tmp/all-sweep-before.txt
hangar-waypoint save "pre whole-file comment-sweep snapshot"
hangar-waypoint covers <every file you are about to edit>
```

A waypoint records the whole tree — **untracked files included** — as a commit on
`refs/hangar-waypoints/<branch>`, without touching the working tree or the index. It is not a stash:
nothing appears in `git stash list`, and no stray `git stash pop` can consume it.

Then verify two things rather than assuming them:

1. **Non-mutation.** Re-run `git status --porcelain`; it must match `/tmp/all-sweep-before.txt`
   exactly. If not, stop and report — the snapshot step must never disturb in-flight work.
2. **Coverage.** `covers` exits non-zero and names any file the snapshot does not hold. **This
   check is not a formality in this skill**: a waypoint is built with `git add -A`, which honours
   `.gitignore`, and naming a file explicitly is the documented scope override here — so this skill,
   unlike `shorten-changed-comments`, can legitimately be pointed at a gitignored path such as one
   under `models/generated/`.

If `covers` reports a file, back it up by hand before editing it:

```bash
BACKUP="$(git rev-parse --git-dir)/comment-sweep-backup"
for f in <each file covers named>; do
  mkdir -p "$BACKUP/$(dirname "$f")" && cp "$f" "$BACKUP/$f"
done
```

The gate is coverage, not command success: **every file about to be edited must be recoverable —
from the waypoint or from the backup directory.** If one is neither, do not edit it.

## Step 3: Say the numbers before editing

Report the per-file block counts to the user **before the first edit**, in one line each. Then:

- **Under ~30 blocks in every file** — proceed. This skill was invoked with explicit paths, which
  is the consent; do not re-ask per file.
- **A single file over ~30 blocks** — ask, but ask about the **level**, not about permission. A
  types file or a long service legitimately holds 50–70 blocks (`formly.types.ts` has 69), and that
  volume is often exactly why someone reached for this skill; a yes/no gate there reads as the
  skill refusing to work. Offer: `medium` as asked / `low` for a smaller diff on comments nobody in
  this session wrote / a named subset. Recommend `low` when the file is shared API.

## Step 4: Level

**Default `medium`** — the unmodified `shorten-comment` judgment. Honour `low` or `high` when the
user names one; `low` is worth _suggesting_ for a file that is shared API or that the user did not
write, since it never deletes a whole block. The level definitions live in
`.claude/skills/shorten-comment/SKILL.md`; do not restate or reinterpret them here.

## Step 5: Judge and apply

Read `.claude/skills/shorten-comment/SKILL.md` **once**, then judge every block against it. Do not
re-invoke it per comment — the criteria are identical each time, and reloading them per block burns
context for nothing. Each comment is still judged **on its own merits and against its own attached
code**; that is what "individually" means here.

**One file at a time, serially, bottom-to-top — and read each file once**, judging all of its
blocks from that one read. A `Read` per block buys nothing the file read did not already give you.

**Three or more files: one worker per file.** Dispatch a `general-purpose` subagent per file, at most
**4 in flight**, each given its file's block list and told to read the criteria itself. This is the
sanctioned exception to CLAUDE.md's "do not use the Agent tool unless a skill asks for it" — this
skill is asking. Fewer than three files: do it inline, no subagents.

Four constraints on the workers:

- The **parent** owns Step 2. A worker never snapshots and never dispatches further workers.
- Workers **`Read` the SKILL.md** rather than calling the `Skill` tool — skill-tool availability
  inside a subagent is not something to depend on.
- A worker prompt must not contain the string `playwright-regression-tests`. The
  `playwright-domain-is-playix-only` hook blocks any non-playix dispatch whose prompt carries it,
  even a mention that only excludes it.
- A worker reports in the **Reporting** form — one line per changed block, no rationale, no progress
  commentary — and the parent concatenates those lines without re-narrating them.

The refactor case does not auto-apply, at any level: when a comment exists only because an
identifier is opaque or a block needs extracting, trimming fixes nothing and deleting loses
information. Renaming is a code change the user did not ask for, so **leave the comment untouched
and report it** with `file:line` and the rename you would suggest. Never let a flagged comment
vanish from the report — that reads as "clean".

## Step 6: Report, and commit it alone

```bash
git status --porcelain   # should differ from /tmp/all-sweep-before.txt only in files you swept
```

In the form `shorten-comment`'s **Reporting** section defines — one line per changed block, no
rationale on any of them. The `git status` comparison itself is silent unless it differs:

```markdown
Swept <N> blocks across <M> files at `<level>` (whole-file).

- `path/file.ts:42` — removed
- `path/file.ts:17-20` — 4→1

Flagged: `path/other.ts:88` — suggest renaming `k` → `retryBackoffMs`
Left: 12 unchanged, 3 directive.
Not swept: `path/gone.ts` — no such file.
Revert: `hangar-waypoint restore 0 <paths>` (`diff 0` first); anything `covers` named, from
`.git/comment-sweep-backup/`.
```

A file that was skipped is named, never dropped silently — that reads as swept. Name the paths in
the revert line too, never revert wholesale: the waypoint holds the user's in-flight work alongside
your edits, and restoring the tree is their call.

**Commit the sweep on its own** — it rewrites blame on comments that predate the branch, which is
unreviewable folded into feature work and cannot be reverted separately. A `docs` commit naming the
files; message style is `commitix`'s business.

## Notes

- **Formatting is a clean-up step.** Do not format per file. Run
  `node .claude/skills/format/format.mjs <the files you touched>` **once at the end**, or leave it
  to `lint-staged` at commit. Low-level JSDoc style is auto-fixed; wrap points are not — those are
  Step 5 of `shorten-comment`.
- **Zero blocks is a valid result.** A file with no comments reports none. Say so; do not go looking
  for other files to justify the run.
- **The parallel path is unexercised.** The inline serial path (one or two files) has been run; the
  one-worker-per-file path has not, so nothing has yet proved that a worker's Edits land where the
  parent's Step 6 `git status` can see them. On the first run of three or more files, check that
  before trusting the report — and fall back to serial if it does not hold.
- **Which skill?** One comment the user pointed at → `shorten-comment`. Comments a diff touched →
  `shorten-changed-comments`. Every comment in named files → this one.

<!--
Personal override of a same-named project skill; see shorten-comment's footer for how the
shadowing works and where the rationale is tracked.

Snapshots go through `hangar-waypoint`, which every clone has on PATH and which is pre-approved,
so a sweep runs end to end without a permission prompt.
-->
