---
name: shorten-changed-comments
description: |
  Sweeps every comment you added or edited in a diff and applies the shorten-comment judgment to each one, editing in place after taking a revertable snapshot. Use this whenever comments across several files need reviewing rather than one specific comment — "clean up the comments I added", "shorten all the new comments", "sweep the comments before I commit", "did I leave any bloated JSDoc in this branch". Trigger it proactively before committing any change that touched comments in build code, since CLAUDE.md's shorten-comment rule requires every added or modified comment to pass the shorten-comment test. Also reach for it after a large refactor, after generating code with doc blocks, or when the user asks whether the comments on this branch are in good shape. For a single comment the user points at directly, use shorten-comment instead.
argument-hint: '[base-ref, e.g. master — optional; defaults to this branch'"'"'s fork point]'
allowed-tools: Read, Edit, Grep, Glob, Bash, Skill, AskUserQuestion
---

# Changed-Comment Sweep

CLAUDE.md's shorten-comment rule requires every comment added or modified in build code to survive the
shorten-comment test. Doing that by memory fails in the direction you'd expect: the comment
written 40 tool calls ago is the one that slips through. This skill finds the comments
mechanically from the diff, so judgment is spent on deciding rather than on remembering.

Division of labour: the bundled script decides **which** comments changed and **where exactly they
are**, you decide **what** each one deserves. Never eyeball a diff for comments by hand — `//` hides inside URLs and string
literals, and a `+ * prose` line gives no hint which block it belongs to.

## Step 1: Find the changed comments

```bash
node .claude/skills/shorten-changed-comments/find-changed-comments.mjs
```

**The default scope is the whole branch**: this branch's **fork point** — the closest of
`origin/master` and any `origin/release*` by commits ahead — against the working tree, so
committed and uncommitted comment changes are swept in one pass. The script prints the base it
chose, the candidates it compared and how many commits ahead you are, on the first two lines. Read
them; they are what the findings cover.

`origin/*` and not the local branches, deliberately: a local `master` nobody has fetched for a week
produces a diff against the wrong point with nothing in the output to show it.

| You want                                | Pass             |
| ------------------------------------------ | ------------------ |
| everything on this branch (the default) | nothing          |
| **uncommitted changes only**            | `--base HEAD`    |
| a specific fork point                   | `--base <ref>`   |
| machine-readable output                 | `--json`         |
| tracked files only                      | `--no-untracked` |

**Fork point is not the PR target**, and on a release branch the two differ — a fix branched off
`release9` may well target `master`. Fork point is nonetheless the right base _for a sweep_, because
it is what "the comments on this branch" means; the PR target only decides where they land.
`.claude/skills/pr-description/SKILL.md` covers that distinction at length.

> **There is no automatic scope widening any more, and its removal is the point.** The previous
> version defaulted to uncommitted-vs-HEAD and escalated to branch scope _only when the working
> tree came up empty_ — so one comment tweaked in the tree hid the other thirty on the branch, and
> the report still said "swept". A partial sweep reported as a full one is worse than no sweep. If
> you catch yourself wanting the old behaviour, that is `--base HEAD`.

Each touched comment block is printed with its file, line span, kind, the line of code it is
attached to, and a `not unique` flag when the comment text alone appears more than once in its file.

It already handles the parts that are easy to get wrong:

- **File scope** — test, story, config, generated, mock-infrastructure, Playwright and doc files
  are filtered out. The list lives in `.claude/skills/shorten-comment/comment-lexer.mjs`, beside
  the Step 0 prose of `shorten-comment/SKILL.md` that it mirrors.
- **Directive comments** — `eslint-disable`, `prettier-ignore`, `@ts-expect-error`,
  `istanbul ignore`, `#region` and friends are reported separately and marked
  `"directive": true`. These carry machine meaning: shortening one breaks lint or type-checking.
  Leave them exactly as they are, even when they look verbose.
- **Block expansion** — a single changed line inside a JSDoc block surfaces the whole block, so
  you judge the comment rather than a fragment.
- **Untracked files** — new files count as fully changed, since every comment in them is new.
- **Strings, regexes and templates** — a `/` inside a URL, a quoted literal or an escaped regex is
  not mistaken for a comment. Never eyeball a diff for this yourself.
- **`<script>` / `<style>` in HTML** — lexed as JS/CSS, not just for `<!-- -->`. Standalone assets
  such as `angular/src/assets/*.html` carry real `//` comments inside `<script>`.
- **A unique `old_string` per block** — `--json` carries one, already grown by whole lines until it
  matches nothing else in its file. Edit refuses a non-unique `old_string`, and roughly one block
  in 200 needs this. Use it rather than retyping the comment from a Read.

## Step 1b: Offer the selection, once

Ask **one** question, and only when the script found **more than five** blocks — a dialog about
three comments is friction, not consent. Use `AskUserQuestion` with these three options, first one
recommended:

| Option                                  | What you then do                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sweep all _N_**                       | Go to Step 2 and sweep everything. Ask nothing further.                                                                                     |
| **Show me the list first, then I pick** | Print the numbered list (file:span + the comment's first line), then say: _reply with the numbers to **skip**, or "go" to sweep all_. Wait. |
| **Only the ones I name**                | Sweep nothing until the user names blocks.                                                                                                  |

The reply to the middle option is **free text, not another dialog** — that is what escapes
`AskUserQuestion`'s four-option ceiling, and why a checkbox list of every block is not what this
skill offers. There is no way to pre-check options in `AskUserQuestion`, so a genuine
all-checked-by-default checkbox dialog cannot be built; the recommended first option is the
one-keypress equivalent.

**Over ~40 blocks, say the number in the question itself** so the choice is informed — do not add a
second gate, and never silently process a subset.

## Step 2: Snapshot before editing anything

This skill edits without asking per comment, so the snapshot is what makes that safe. Take it
**before the first Edit**, and only proceed once every file you are about to touch is covered.

```bash
git status --porcelain > /tmp/sweep-before.txt   # for the guard in Step 5
hangar-waypoint save "pre comment-sweep snapshot"
```

A waypoint records the whole tree — **untracked files included** — as a commit on
`refs/hangar-waypoints/<branch>`, without touching the working tree or the index. It is not a stash:
nothing appears in `git stash list`, and no stray `git stash pop` can consume it.

Verify non-mutation rather than assuming it: re-run `git status --porcelain` and confirm it is
identical to `/tmp/sweep-before.txt`. If the working tree changed, stop immediately and report it —
the snapshot step must never disturb in-flight work.

Coverage needs no manual backup step here, and the reason is worth keeping so nobody re-adds one. A
waypoint is built with `git add -A`, so the only thing it cannot hold is a **gitignored** path — and
this skill can never reach one. Its candidate set is the branch diff plus
`git ls-files --others --exclude-standard`, and `--exclude-standard` drops ignored files; untracked
files do appear, and a waypoint holds those as readily as tracked ones. The Step 0 override in
`shorten-comment` does not change this: it widens which of those files get trimmed, never which
files enter the set. `shorten-all-comments`, which takes paths from the user, has no such guarantee
and keeps its `covers` assertion.

## Step 3: Load the judgment criteria once

Invoke the `shorten-comment` skill (or read `.claude/skills/shorten-comment/SKILL.md`) **once** at
the start of the sweep. Its criteria then apply to every block in the batch — invoking it per
comment just reloads identical text and burns context.

What carries over from it: the refactoring-first check (Step 1), the WHY test and TSDoc tag table
(Step 3), the decide table (Step 4), the **aggressiveness levels**, and the formatting rules
(Step 5) — single-line vs multi-line form, clause-driven wrap points, `//` for inline comments.

**A sweep runs at `medium` unless the user asked otherwise**, and `medium` is that skill's
unmodified judgment. Honour `low` or `high` if they named one, and say which level you ran at in the
Step 5 report — the same comment legitimately gets three different verdicts.

## Step 4: Judge and apply, block by block

**Read each file once, and judge every block in it from that one read.** The judgment turns on what
the code already communicates and the script's one line of context is a hint, not enough — but a
`Read` per block buys nothing the file read did not already give you. Work file by file,
bottom-to-top within each file, so every span still on the list stays correct as edits land below it.

| Verdict                                | Action                                                |
| ----------------------------------------- | -------------------------------------------------------- |
| Survives the WHY test, concise         | Leave it. Say nothing about it beyond the tally.      |
| Survives but verbose                   | **Rewrite** shorter, same meaning.                    |
| Nothing survives                       | **Remove** the block and its surrounding blank lines. |
| Comment exists because code is unclear | **Flag, do not edit** — see below.                    |

The refactor case is the one that does not fit auto-apply. When a comment only exists because an
identifier is opaque or a block needs extracting, trimming the comment fixes nothing and deleting
it loses information. Renaming the identifier is a code change the user did not ask for
(CLAUDE.md's "do not implement a fix the user did not ask for" rule), so leave the comment untouched and report it with `file:line` and the rename
or extraction you would suggest. Never silently drop these — a flagged comment that disappears
from the report reads as "clean".

Keep each Edit to the comment itself. **Use the
`oldString` from `--json` as the Edit `old_string`** — for a block flagged `not unique` it is the
only form Edit will accept, and where it was grown, the extra lines are context to reproduce
unchanged. Do not reformat or adjust neighbouring code by hand, and do not format after each file — low-level
JSDoc style (asterisk alignment, line spacing, tag gaps) is auto-fixed by the formatter. If
the sweep leaves style drift, run `node .claude/skills/format/format.mjs <the files you
touched>` **once at the end**, or leave it to `lint-staged` at commit.

## Step 5: Report

Confirm the working tree only changed in the ways you intended. **Say nothing about this unless it
differs:**

```bash
git status --porcelain    # should differ from /tmp/sweep-before.txt only in files you edited
```

Then report in the form `shorten-comment`'s **Reporting** section defines — one line per changed
block, no rationale on any of them:

```markdown
Swept <N> blocks across <M> files at `<level>`. Scope: <the script's first line, verbatim>.

- `path/file.ts:42` — removed
- `path/other.ts:17-20` — 4→1

Flagged: `path/third.ts:88` — suggest renaming `k` → `retryBackoffMs`
Left: 6 unchanged, 2 directive.
Revert: `hangar-waypoint restore 0 <paths>` — `diff 0` to inspect first.
```

Name the paths in that revert line, never revert wholesale — restoring the tree is the user's call,
and the waypoint holds their in-flight work as well as your edits. `restore` writes the working tree
without touching the index, which is what you want here.

## Notes

- **Permission prompts.** Every waypoint verb is allow-listed, `restore` included, so a sweep runs
  end to end without one. `restore` earns that by recording an undo waypoint before it writes, so
  it cannot be the step that loses work — but _deciding_ to roll back the user's tree is still
  theirs. Offer it, name the paths, and let them say go.
- **Nothing found is a valid result.** If no changed comments survive filtering, say so plainly.
  Do not widen the scope to manufacture findings — and note that a branch touching only `.md`,
  `.claude/**`, specs or config legitimately reports zero, because those files are out of scope.
- **Single comment?** Use `shorten-comment` directly — it takes a `<file>:<line>` and resolves the
  block itself. **Whole files, comments regardless of whether the diff touched them?** That is
  `shorten-all-comments`, which takes the paths as arguments.

<!--
Personal override of a same-named project skill; see shorten-comment's footer for how the
shadowing works and where the rationale is tracked.

Snapshots go through `hangar-waypoint`, which every clone has on PATH and which is pre-approved,
so a sweep runs end to end without a permission prompt.
-->
