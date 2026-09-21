---
name: fix-commit
description: >
  Correct a commit already made. On UNPUBLISHED commits, rewriting is available through
  `hangar-rewrite` — amend, fixup, autosquash, reset — and only when the user asks for it. On
  anything already pushed, correct forward with a new commit instead. Use whenever a commit turns
  out wrong, incomplete, wrongly split or wrongly worded: "that last commit was wrong", "this
  should have gone in the earlier commit", "undo what I just committed", "the commit message is
  wrong".
when_to_use: A commit on this branch needs correcting.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# Fixing a commit

**The published/unpublished line decides everything here.** It is the only distinction that
matters, and it is not a matter of taste:

- **Unpublished** — the commit exists only on this machine. Rewriting it changes nothing anyone
  else can see, because it was never sent anywhere. Tidy it freely.
- **Published** — the commit is reachable from a remote-tracking ref. Rewriting it rewrites
  history under everyone who has already pulled it. Never do this. Correct forward instead.

Run `hangar-rewrite status` first. It lists exactly what is unpublished here and therefore safe,
and says so plainly when nothing is.

## Rewriting, when the user asks

**Only when the user asks.** Do not reach for a rewrite on your own initiative — not to tidy up,
not because a message reads badly, not because two commits "should" be one. A correction the user
did not request is a new commit, every time. `hangar-rewrite` has no pre-approved permission
entry precisely so that each use is a decision somebody made out loud.

```bash
hangar-rewrite status                  # what is safe to rewrite here
hangar-rewrite amend -m "<message>"    # redo the last commit
hangar-rewrite amend --no-edit         # fold staged changes into it, message unchanged
hangar-rewrite fixup <sha>             # a fixup commit aimed at an earlier one
hangar-rewrite autosquash <base>       # apply the fixups, non-interactively
hangar-rewrite reset soft <ref>        # uncommit, keep the changes staged
```

Three things it does for you, so you do not have to remember them:

- **It refuses anything already on a remote**, naming which ref holds it. That refusal is the
  whole safety property — you cannot rewrite shared history through this tool even by mistake.
- **It records a waypoint first**, so every rewrite is reversible: `hangar-waypoint list`, then
  `hangar-waypoint restore <n> <paths>`.
- **It never pushes, and no flag makes it.** An argument that could reach a remote is refused
  rather than forwarded.

`git commit --amend`, `git rebase` and `git reset` typed directly are blocked by this repo's own
hook and will simply fail. That is not something to work around — use the commands above, which
enforce the published/unpublished line the blanket rule is a proxy for.

## Correcting forward, when it is published

The commit is out. A new commit is the only correct answer.

1. Make the change.
2. Commit it, naming what it corrects: `fix(scope): Correct <what> from <short-sha>`.
3. If the original message was simply wrong, say so in the body rather than trying to alter it.

A forward correction is not a worse outcome. It is an accurate record of what happened, which is
what history is for.

## What the message says

The message describes the change to the code, in the project's own vocabulary, and nothing else.
None of the tooling on this page belongs in it — not `hangar-rewrite`, not a waypoint, not the
fact that the commit was amended rather than written correctly the first time. Whoever reads it
has one checkout and none of these commands, and the message outlives the branch it was written
on. The same holds for a code comment, a document, the body of a pull request, and anything
you write that is not a commit at all — issue text, a draft under `tmp/`, a reproduction
case. Those feel the least like publishing and are published the hardest.

That is scope rather than secrecy. Say plainly what changed, and if the user asks you how you
work, tell them.

## Pushing

**Never.** Not `push`, not `push --force`, not `push --force-with-lease`, not through an alias, a
script or a `--exec`. Publishing is the user's, always, and there is no situation in which an
agent should do it on their behalf — including when a rewrite has left the local branch and its
remote counterpart diverged. Say that the branch needs pushing and stop.

<!--
Personal override of a same-named project skill. A user-level skill replaces the project's copy
entirely and silently, on this machine, in every repo, so this file -- not the tracked one -- is
what runs.

It diverges on purpose and in one direction: the tracked skill forbids rewriting outright, and
this one permits it for UNPUBLISHED commits only, through `hangar-rewrite`, on request. The
blanket ban exists to protect published history, and that protection is kept here by a mechanism
rather than a convention -- the tool refuses a commit reachable from any remote-tracking ref.

The never-push rule is NOT relaxed, here or anywhere. It is stated more strongly than the tracked
skill does, because a local rewrite is exactly the situation that tempts a force-push.
-->
