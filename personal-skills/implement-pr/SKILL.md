---
name: implement-pr
description: >
  Takes the current branch's pull request as far as an agent can, unattended, and never sits
  idle while doable work remains. Works every open plan item, adds the issues it finds and is
  sure how to fix to the plan and fixes them too, and runs pr-readiness at checkpoints, feeding
  what it finds back into the plan. Every question it cannot answer goes into a question backlog
  in the plan instead of being asked. The backlog is shown only when the user asks for it, or
  once nothing more can be done without an answer. Invoked as
  /implement-pr [questions] [issue-key | plan-path].
argument-hint: '[questions] [issue-key | plan-path]'
disable-model-invocation: true
---

# /implement-pr — work the plan until only your decisions are left

**The goal is to take the pull request as far as an agent can.** Going idle while there is still
work this run could do is the failure this skill exists to prevent. A question, a long test run
or a locked commit gate is a reason to switch to other work, never a reason to wait. The run is
finished only when the next step needs the user, for everything that is left.

The plan file is the state of this run. Keep it current after every item, so that a compacted
or resumed session can carry on from the plan alone.

**This skill never publishes.** That means no `git push` in any form, no PR creation or update,
and no tracker write. **It works in this checkout only.** You may read a sibling clone, but never
write to one.

**`/implement-pr questions`** does no work at all. It finds the plan (step 1), shows the question
backlog (step 5), and works in whatever answers come back. Then it stops, unless the user says
to continue.

## 1. Find the plan and the rules

- **The plan.** Use the first of these that exists:
  1. the argument, when it is a path;
  2. `tmp/<KEY>/plan_<KEY>.md`. The key is the argument, or the branch's ticket, found the way
     `pr-readiness` Step 1 finds it;
  3. the newest `.claude/plans/*.md` that names this branch or key.

  If none of them exists, that is the one question allowed to stop the run before it starts:
  ask for the path, and stop.
- **The hard link.** Check it with
  `stat -f %l <plan>` on macOS, or `stat -c %h <plan>` on Linux. A count of 2 means the plan has
  a second name. Edit the plan in place. After an edit, if the count drops to 1, re-run the repo's
  plan-link helper (for example `node .claude/skills/jira-scope/jira-cache.mjs plan <KEY> <file>`)
  so the other name does not freeze at an old version.
- **The rules.** Read the repo's `CLAUDE.md` (or `CLAUDE.md` files nearer the changed code), the
  skills it points at, and the plan's own **Decisions** and **Verification** sections. Where they
  disagree with this skill, they win.
- **Commits.** Run `hangar-commit-gate status 2>/dev/null` and check how the repo wants commits
  made.
  - When commits are allowed, commit granularly as items finish, the way the repo's rules say.
  - When the gate is locked, make no commits, merges included. Keep the intended commit split in
    the plan instead.

## 2. Bring the plan into this layout once, then keep it

Append the section below to the plan if it is missing. If an older readiness or "blocked"
section exists, rewrite it into this layout. Each item sits under exactly one heading. **An item
never moves between headings**: ticking its checkbox, and recording an answer, are the only
changes it gets.

```markdown
## Implementation status

### Plan
- [x] <plan step>: <evidence: file, test summary, commit>
- [ ] <plan step> (waits on Q<n>, when it does)

### Added during implementation
- [ ] <issue>: <why it is needed for the PR> (<source: implementation | pr-readiness pass N | Q<n>>)

### Question backlog
- [ ] Q<n> (decision | action): <the exact question, or the action only the user can take>
  - blocks: <the items it holds back, and how much work that is>
  - options: <the plausible answers>; recommended: <yours, with the reason>
  - prepared: <what is already done so the answer costs one step>
- [x] Q<n> …: answered <answer>

### Commits
<the made ones by sha, or the intended granular split while the gate is locked>
```

## 3. Work loop

Pick the next open item from **Plan** or **Added during implementation** that waits on no open
question. Implement it, verify it the way the plan's Verification section says, then tick it in
the plan with its evidence. Repeat.

**An issue found along the way** (a bug, a missing test, a broken convention, a failing check)
goes under **Added during implementation**, and you fix it next or in order, but only when all
three of these hold:

1. **You know the fix**, and it is not one of several plausible fixes.
2. **It is needed for this PR.** It sits inside the plan's objectives, or the repo's rules require
   it of any PR that touches this code.
3. **It contradicts nothing** under **Decisions**, and it does not widen the PR's scope.

If any of the three fails, it becomes a **decision** in the question backlog, and the item it
holds back is marked `waits on Q<n>`. Then move on.

**These always become an action in the backlog, never part of the work:**
- pushing, or creating or updating the PR;
- disarming the commit gate;
- writing to the tracker;
- an end-to-end run the plan did not authorise;
- anything in another clone;
- installing or removing dependencies the plan did not name;
- anything the repo's rules say needs the user.

**A blocked item is rarely blocked whole.** Do every part of it that does not depend on the
answer. Then prepare the rest so that the user's answer, or their action, costs one step, and
note under the question's `prepared` what you did:
- the code for the recommended answer, sketched in the plan;
- the commit messages, written out;
- the exact command for the user to run.

**Order the work so that questions are needed as late as possible.** Whatever waits on no
question comes first. Of the items that do wait on one, do their independent parts before
anything else that is left.

While a long run is going (a test suite, a build, a subagent), start it in the background and
work an independent item instead of waiting.

## 4. pr-readiness checkpoints

Invoke the `pr-readiness` skill at these points:

- **First pass:** once every **Plan** item is ticked or waits on a question. Running it earlier
  only reports the plan back as "not started".
- **Each later pass:** after you finish the items the previous pass added, and only if code
  changed since that pass.

**Within this run, pr-readiness asks nothing.** Where it would ask the user (a dirty tree before
integrating, an end-to-end run, a decision about a rule), add the question to the backlog and let
it carry on with the rest. It already refuses to integrate on a dirty tree or a locked gate, so a
mid-run pass stays safe. Never publish anything that pass names.

Take each ❌, ⚠️ or ❓ row and each missing objective it reports:
- **It passes the three-part test:** add it under **Added during implementation**, tagged
  `pr-readiness pass N`, and go back to the work loop.
- **It fails the test:** add it to the question backlog.

**Within this run, a finding that passes the test is fixed**, failing tests included. That
overrides pr-readiness's "do not fix without asking": you were asked, by `/implement-pr`.

**Stop the checkpoints** after the first pass that adds nothing new you can fix. A finding
already in the backlog does not count as new. There is no fixed number of passes, but a pass that
repeats the previous pass's findings is the last one.

## 5. The question backlog

**Hold every question back.** Never call `AskUserQuestion` mid-run, never end a progress update
with a question, and never stop to wait for an answer. A question goes into the backlog and
nowhere else.

The backlog is shown in exactly two cases:

1. **The user asks for it** at any point. That covers "what are the questions?", "what do you
   need from me?", "show the backlog", or `/implement-pr questions`.
2. **Nothing more can be done without an answer**, which is when the idle check in step 6 has
   passed.

**Showing it:**
- List every open entry, ranked by how much work it unblocks, each with what it blocks, your
  recommended answer and what is already prepared. Actions go last, with the exact command.
- Then ask the top decisions in one `AskUserQuestion`. It holds at most four, so lead each with
  your recommended answer. The rest wait for the next round.
- The user may answer some, all or none. Whatever they leave stays open.

**Working an answer in:**
- Tick the entry and record the answer.
- Copy the decision into the plan's **Decisions** section, because the three-part test checks
  against that section from now on.
- Clear the `waits on` mark from the items it unblocks, and add any new work it implies under
  **Added during implementation**, tagged `Q<n>`.

**When the user asked mid-run**, go straight back to the work loop afterwards. Asking for the
questions never ends the run.

## 6. The end

The run ends only when every open item waits on a question, or there are no open items at all.
Before you treat it as over, do the **idle check**. Each line that fails is work, so do it, and
come back here afterwards:

- every check in the plan's Verification section, and the repo's typecheck, lint and format,
  ran after the last edit to the files it covers;
- the repo's documentation and comment rules are met for every changed path (use its skills for
  that, such as a comment sweep);
- the PR description has been regenerated locally if the repo has a skill for it. Uploading it
  stays the user's;
- every backlog entry has its independent part done and the rest prepared (step 3);
- the last pr-readiness pass ran after the last code change.

Then:

1. **Re-check the plan file.** Every tick has its evidence, and the hard link is intact.
2. **Report:**
   - the last pr-readiness table and verdict;
   - what this run did, by item;
   - what it added to the plan, and from which source.
3. **Show the question backlog** (step 5).
4. **Work every answer in, then go back to step 3.** Show the next round of the backlog only once
   the answered work is done and the idle check has passed again. Publishing, which means the
   push and the PR, stays with the user: name the exact command instead of running it.
