---
name: granular-commits
description: >
  Turns a pile of working-tree changes into a small set of granular, logically coherent commits —
  proposes the grouping first, stages per group, and writes one message per commit. Use whenever
  there is more uncommitted work than belongs in one commit: "I have a load of changes, pack them
  into nice commits", "split this diff into sane commits", "commit all of this, granularly",
  "group these changes and commit them". Also the commit half of the `commit-gate` skill, which
  invokes it after its checklist passes. For one commit's message only, use `commit`; for
  correcting a commit already made, use `fix-commit`.
when_to_use: Uncommitted work spans more than one concern and needs splitting into granular commits.
argument-hint: '[issue-id]'
allowed-tools: Read, Grep, Glob, Bash, Edit, Explore, AskUserQuestion, Agent, mcp__jira__jira_get
---

# Granular commits

One job: decide **what goes in which commit**, stage it, and commit it. Three skills share this
area and the boundary is worth keeping straight — `commit` owns the message **format** (Conventional
Commits, types, scopes, body shape), the `commitix` agent generates a message for an
already-staged diff, and this skill owns the **grouping and the staging**. Point at the other two
rather than restating them.

It runs in the main session, never as a subagent: the grouping and the Jira attribution both depend
on knowing what was built and why, which a fresh agent can only re-derive from the diff — worse
groups, worse messages.

## Step 1 — see all of it

```sh
git status --porcelain          # untracked files are part of the work
git diff --stat                 # unstaged
git diff --cached --stat        # already staged, if anything is
```

Anything already staged was staged for a reason. Do not silently fold it into your first group —
say what it is and ask, or `git restore --staged` it and let the grouping decide.

## Step 2 — propose the grouping, before staging anything

A table, agreed with the user first:

| Commit | Files | Why these together |
| ------ | ----- | ------------------ |

- **One concern per commit.** Everything in a commit covers the same part of the work. A new class,
  its Jest specs, its Playwright coverage, its docs, the npm dependency it needed and the tooling
  change that made it possible all belong **together** — that is one concern, however large. A
  one-line typo fix next to it is a different one, however small. Size follows from the concern; it
  is never the criterion.
- **No unrelated things in one commit.** This is the rule the whole skill exists to enforce.
- **Fewest commits that break none of the above.** Granular does not mean many.
- **Scope may be narrower than the diff.** If the user agreed to commit only part of the work, the
  rest stays uncommitted — and the report says what was left.

## Step 3 — decide the verification stance, and say which one you are in

Whether a commit is allowed to go out unverified depends entirely on how you got here.

**Verified tree** — you arrived from `commit-gate` Phase 1, or the user has just run build, lint,
Jest and typecheck green over the whole tree. The commits are then a _partition of a verified tree_.
**Do not build or test per commit** — it is far too slow, and this is the deliberate, earned
relaxation of Git Workflow Rule 6. "Each commit would build on its own" is best effort.

**Nothing verified** — the standalone case. The commits are unverified, and the report must say so
in those words. Do not claim a commit builds when nothing checked it. Rule 6's actual remedy —
check the SHA out in a throwaway `git worktree` and build there — matters most for a commit that
**splits one file across commits**, because a green working tree proves nothing there: the tree
holds both halves, the commit holds one. Name that commit, offer the check, and let the user decide;
running a build they did not ask for is its own kind of wrong.

## Step 4 — stage

- `git add <paths>` per group. Re-read `git diff --cached --stat` and confirm it matches the row you
  proposed, **before** committing.
- **Splitting one file across commits:** `git add -p` is interactive and unavailable here. Write the
  hunk to a patch file and `git apply --cached <patch>`. Take
  `hangar-waypoint save "pre-split snapshot"` first — it records the whole tree, untracked files
  included, without touching the tree or the index. It is on PATH in every clone and at the hangar
  root, which a script living in one repo is not.
- **To unstage: `git restore --staged <file>`.** `git reset` is denied in every form, and reaching
  for it is the reflex that hits a wall mid-split.

## Step 5 — one message per commit

Format lives in `.claude/skills/commit/SKILL.md`. Three rules govern the _content_ and are this
skill's own, because a wrong one here is invisible in review:

1. **The Jira key must match the work, not the branch.** If the staged diff really is this ticket's
   work, its key. If it is genuinely another ticket's, **that** ticket's key. A pull request that
   honestly shows unrelated work is far better than one whose commits claim a ticket they do not
   implement.
2. **No fitting ticket means no key at all.** An invented or placeholder key (`DN-XXXX`) is never an
   option — it is worse than having none.
3. **The body explains why, and the context the diff cannot show.** Not what the diff already says.
   No code examples, no narration of the changes.

## Step 6 — check and report

```sh
node .claude/skills/commit-gate/check-commits.mjs [<range>]   # only where the repo ships it
```

This skill is personal, so it is active in every repo on this machine and that file is not. Run it
where it exists and say nothing where it does not.

It lives under `commit-gate` but takes any range and is useful after any batch: it catches a
dependency change without its lockfile, a spec landing before the subject it tests, and a commit
whose Jira key differs from the branch's. **Granularity itself is not checkable** — it is semantic,
and commitlint-style tools validate message shape only. A differing key is reported, not condemned.

Then report: the SHAs and subjects in order, the verification stance from Step 3, and **what is
still uncommitted**. A leftover that goes unmentioned reads as "everything is committed".

## Notes

- **Never push**, and never rewrite history. A commit that turns out wrong is corrected by a new
  commit — `.claude/skills/fix-commit/SKILL.md`.
- **A commit is not a checkpoint here.** Do not commit a group "so the work isn't lost" before the
  grouping is agreed; that is what a waypoint is for.
- **Under an active commit gate this skill is reached through `commit-gate`, not directly.** The
  gate's checklist is what earns Step 3's first branch, and its `PreToolUse` hook denies commits
  until the gate releases.
