---
name: pr-readiness
description: >
  Judges whether the current branch's pull request is actually done, and brings it up to date on
  the way. Checks every objective in the ticket and the plan against the diff, classifies the
  existing test coverage (unaffected, still passing, passing because of this change, unknown),
  re-runs Jest and Storybook ONLY where their status is unknown, checks the repo's documentation
  rules, integrates the pull request's target branch (rebase when nothing is published, merge
  otherwise), and regenerates the PR description when it has gone stale. Use whenever the user
  asks "is this PR done?", "is it ready for review?", "check my pull request", "anything missing
  before I mark it ready?", "can this go out?".
when_to_use: The branch has, or is about to have, a pull request, and the question is whether it is finished.
argument-hint: '[issue-key]'
allowed-tools: Read, Grep, Glob, Bash, Edit, Skill, Agent, AskUserQuestion
---

# Is this pull request done?

One report at the end, and every verdict in it carries its evidence. A ✅ without a file, a
commit, a test summary or an artifact behind it is a guess, and a guess is reported as ❓.

**This skill never publishes.** No `git push` in any form, no `hangar pr create` or `update`, no
marking a pull request ready. When the branch needs pushing or the description needs uploading,
say so and name the command. The user runs it.

**It works in this checkout only.** In a hangar clone, reading a sibling is fine and writing to
one never is.

## Step 1 — gather the facts, change nothing

```sh
git branch --show-current
git status --porcelain
git rev-parse --abbrev-ref @{u} 2>/dev/null   # empty: never pushed
git log --oneline --not --remotes             # what is local only
hangar-commit-gate status 2>/dev/null         # a locked gate means no commits, merges included
```

- **The issue key.** Take it from the argument if one was given. Otherwise take it from the
  branch name, using the repo's own key pattern: the one its pr-description collector uses, its
  `CLAUDE.md`, or the "issue keys" row of the `CLAUDE.local.md` above it. `ABC-1323` in
  `feature/ABC-1323_add_export` is the shape. With no key, the objectives come from the plan and
  the commits alone, and the report says so.
- **Which clone this is**, from `CLAUDE.local.md`, if there is one. That gives the index the
  `hangar` commands below take.
- **The pull request.** Run `hangar list` and read this clone's row: the number, draft, build and
  review, with reviewers and approvals. If the row is stale, run `hangar pr refresh <index>` first.
  Outside a hangar, use the repo's forge CLI if it has one, or record "PR state unknown".

## Step 2 — the objectives

Read what the work was supposed to do:

- **The ticket.** Use the repo's ticket-sync skill, or the cached record it keeps under
  `tmp/<KEY>/`. Read the parent and sub-task records it links too. **Never hand-edit a cached
  record**: in a hangar every one is a symlink into a store the whole fleet shares.
- **The plan**, if one was written for this key. It is usually under `tmp/<KEY>/`, or in the
  repo's plans directory.
- **The existing PR description's "not done" section**, if there is one. It is what the author
  already admitted.

Turn these into one numbered **objective list**: acceptance criteria quoted verbatim, the bug as
described, and the plan's steps. Then take the diff against the target, which Step 3 determines.
Before any integration, `git diff --stat <merge-base>..HEAD` is enough. Give every objective one
verdict:

| verdict      | means                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| done         | implemented, and you can point at it: `file:line`, a commit, a test    |
| partial      | some of it is there; say exactly what is missing                       |
| not started  | nothing in the diff addresses it                                       |
| out of scope | deliberately not done here; quote where that was decided, or ask       |

Also look for the signals a finished branch should not carry: added `TODO`/`FIXME`, `.only`,
`.skip`/`xit`/`xdescribe`, `console.log`, commented-out code. Use the repo's pr-description
collector if it reports them, otherwise grep the added lines (`git diff <base>..HEAD -U0 | grep
'^+'`).

## Step 3 — bring the branch up to its target

**The target is the branch the pull request merges INTO, not automatically the default branch.**
A pull request can target a release branch, or another branch in a stack.

```sh
git fetch origin
NO_COLOR=1 hangar sync <index> -n     # dry run: prints `target` and `strategy`, changes nothing
```

The dry run asks the forge for the pull request's destination and applies the fleet's rule for
choosing rebase or merge. **Never run `hangar sync` without `-n` from inside the clone.** It
stashes the tree it runs in and sends a pause message into this very session. Outside a hangar,
the target is the PR's destination if the forge CLI can say, otherwise `origin/HEAD`.

**Do not integrate** in any of these cases:

- the tree is dirty. Ask the user whether to commit first or skip integrating;
- the commit gate is locked;
- a rebase, merge or cherry-pick is already in progress.

Report which one it was.

Otherwise act on the strategy the dry run printed:

| strategy     | do                                                                                    |
| ------------ | ------------------------------------------------------------------------------------- |
| `up-to-date` | nothing                                                                               |
| `ff-only`    | `git merge --ff-only origin/<target>`                                                 |
| `rebase`     | `hangar-rewrite rebase <target>`, with the **bare** branch name, never `origin/…`     |
| `merge`      | `git merge origin/<target>`                                                           |

**Rebase only what nobody else has.** The pull request having reviewers, or the branch having
been pushed at all, means merge, whatever the dry run said. `hangar-rewrite rebase` enforces this
itself: it refuses when any commit in the range is reachable from a remote-tracking ref. **Exit
2** means it hit a conflict, aborted, and left the branch exactly as it was. **Any non-zero exit
means merge instead** (`git merge origin/<target>`): a published commit, a merge commit in the
range, even a branch name it mistakes for a remote. The one exception is "No origin/<target>
here", which means fetch and try again. Whatever it refused, the branch was left untouched.

A merge that conflicts is resolved **here, in this tree**: read both sides and keep what each
side meant. Conclude with `git add` and `git commit --no-edit`, and never with a force of any
kind. If a conflict cannot be resolved with confidence, `git merge --abort` and report it.

**Record what integration brought in:** `git diff --name-only ORIG_HEAD HEAD`, or the list of
upstream commits. Step 4 needs it.

## Step 4 — would the pipelines still pass?

**Judge evidence against the tree as it is NOW, after Step 3, and re-run only what is unknown.**
Re-running a suite that has already passed on this exact code is wasted time. Skipping one
because an OLDER run passed is the failure this step exists to catch.

A run counts as **known** only if one of these holds:

1. **This session ran it**, after the last edit to any file it covers, and you saw its summary
   line (for Jest, `Tests:` and `Test Suites:`, never a truncated tail).
2. **An artifact proves it.** A JUnit report, a results JSON or a coverage summary counts when:
   - it is identified by its suite names, not its filename, since two runners may write the same
     file;
   - its OWN timestamp is newer than the tip commit AND the working-tree mtime of every file it
     covers;
   - it records zero failures.
3. **Committed result files** for the spec, newer than the change, where the repo commits them.

**Integration can undo a "known".** If Step 3 brought in upstream changes to files the branch's
own files import, render or are tested alongside, earlier evidence for those suites becomes
unknown. Anything ambiguous is unknown.

Classify the coverage **per spec, story or test file** that touches the changed code, for every
runner the repo has:

| class                  | means                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| unaffected             | nothing it exercises changed, on this branch or in the integration |
| still passing          | exercises changed code; known passing (above)                      |
| passing because of it  | new or changed on this branch; known passing                       |
| unknown                | none of the above; run it                                          |
| failing                | known failing; this blocks                                         |

Then run the unknowns, **scoped**, through the repo's own skills. Find them under
`.claude/skills/` and follow their instructions over anything written here:

- **Jest** (or the repo's unit runner). Run the specs related to the changed files
  (`--findRelatedTests <files>`, or the path pattern the repo's jest skill documents). Run the full
  suite only when shared or core code changed, so that "related" is not a bounded set. Run the
  repo's typecheck too if its test runner does not type-check.
- **Storybook** (build and interaction tests). Use the repo's storybook skill, against THIS
  checkout's own dev server and port. If it is not running, say so or start it the way that skill
  says. Never point at a server you did not start in this checkout. A new or changed component
  with no story is a documentation finding, not a test pass.
- **End-to-end** (Playwright or similar). It is slow, and many repos let only a designated agent
  run it. Look in `.claude/agents/` and the repo's rules for which agent that is. **Ask the user
  before starting it**, and name the specs you would run.

If a run fails, report the failures verbatim, with file and test name. Do not fix them without
asking: this skill judges readiness, and a fix is a new piece of work.

## Step 5 — documentation

Read the repo's `CLAUDE.md` (and any `CLAUDE.md` nearer the changed files) for its documentation
rules. Check each rule against the changed paths. Typical rules:

- a requirements or README file per component or module;
- a story for every new or changed component;
- user-facing or training docs for a changed flow;
- API docs for a changed endpoint;
- the comment-quality rule, which usually has its own skill;
- a changelog, where the repo keeps one by hand.

Report each rule as met or missing, **by path**. Do not write the documentation unless the user
asks.

## Step 6 — the PR description

Find where the repo's pr-description skill writes its file (usually `tmp/<KEY>/`). Re-run that
skill when any of these holds:

- the file does not exist;
- it is older than the tip commit;
- Step 3 integrated anything, or commits were added since it was written;
- an objective's verdict disagrees with what the description says is done or not done.

Otherwise report it as current, with its mtime.

Regenerating writes a local file. **Uploading it is the user's**: name `hangar pr update`
(or `create`, if there is no pull request yet) and stop.

## Step 7 — the report

One table first:

| area            | verdict | evidence                                                   |
| --------------- | ------- | ---------------------------------------------------------- |
| objectives      | ✅ ⚠️ ❌ | n of m done; the missing ones by number                    |
| leftovers       |         | TODO / `.only` / `.skip` found, by `file:line`             |
| sync            |         | target, strategy, what was done (commit sha)               |
| unit tests      |         | known from where, or what was run and its summary line     |
| storybook       |         |                                                            |
| end-to-end      |         | per spec, or "declined, would run: …"                      |
| documentation   |         | rules met / missing, by path                               |
| PR description  |         | current, or regenerated (path)                             |
| review state    |         | draft or not, reviewers, approvals, build                  |

Then the objective list with its verdicts, then **"Left for you"**: the push (with the exact
line, `git push` or, after a rebase of a branch never pushed, `git push -u origin <branch>`),
uploading the description, a declined end-to-end run, any rule that needs a decision. End with
one sentence: ready for review, or not, and the single biggest reason why not.
