---
name: implement-pr
description: >
  Takes the current branch's pull request as far as an agent can, unattended, and never sits
  idle while doable work remains. Works every open plan item,
  adds the issues it finds and is sure how to fix to the plan and fixes them too, runs
  pr-readiness at checkpoints and feeds what it finds back into the plan, and never stops on a
  question while other work remains — questions are recorded in the plan and asked together at
  the end. Invoked as /implement-pr [issue-key | plan-path].
argument-hint: '[issue-key | plan-path]'
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

Append the section below to the plan if it is missing. If an older readiness section exists,
rewrite it into this layout. Each item sits under exactly one heading. **An item never moves
between headings**: ticking its checkbox is the only change it gets.

```markdown
## Implementation status

### Plan
- [x] <plan step>: <evidence: file, test summary, commit>
- [ ] <plan step>

### Added during implementation
- [ ] <issue>: <why it is needed for the PR> (<source: implementation | pr-readiness pass N>)

### Blocked on you
- [ ] <the exact question or action>: <what it unblocks>; <recommended answer>

### Commits
<the made ones by sha, or the intended granular split while the gate is locked>
```

## 3. Work loop

Pick the next open item from **Plan** or **Added during implementation**. Implement it, verify it
the way the plan's Verification section says, then tick it in the plan with its evidence. Repeat.

**An issue found along the way** (a bug, a missing test, a broken convention, a failing check)
goes under **Added during implementation**, and you fix it next or in order, but only when all
three of these hold:

1. **You know the fix**, and it is not one of several plausible fixes.
2. **It is needed for this PR.** It sits inside the plan's objectives, or the repo's rules require
   it of any PR that touches this code.
3. **It contradicts nothing** under **Decisions**, and it does not widen the PR's scope.

If any of the three fails, the issue goes under **Blocked on you**, phrased as a question with
your recommended answer. Then move on.

**These actions always go under Blocked on you, never into the work:**
- pushing, or creating or updating the PR;
- disarming the commit gate;
- writing to the tracker;
- an end-to-end run the plan did not authorise;
- anything in another clone;
- installing or removing dependencies the plan did not name;
- anything the repo's rules say needs the user.

**Never stop on a question.** A question gets recorded, and then you take the next open item
that does not depend on it. While a long run is going (a test suite, a build, a subagent), start
it in the background and work an independent item instead of waiting.

**A blocked item is rarely blocked whole.** Do every part of it that does not depend on the
answer. Then prepare the rest so that the user's answer, or their action, costs one step:
- the code for the recommended answer, sketched in the plan;
- the commit messages, written out;
- the exact command for the user to run.

## 4. pr-readiness checkpoints

Invoke the `pr-readiness` skill at these points:

- **First pass:** once every **Plan** item is ticked or blocked. Running it earlier only reports
  the plan back as "not started".
- **Each later pass:** after you finish the items the previous pass added, and only if code
  changed since that pass.

**Within this run, pr-readiness follows this skill's stopping rule.** Where it would ask the user
(a dirty tree before integrating, an end-to-end run, a decision about a rule), record the
question under **Blocked on you** and let it carry on with the rest. It already refuses to
integrate on a dirty tree or a locked gate, so a mid-run pass stays safe. Never publish anything
that pass names.

Take each ❌, ⚠️ or ❓ row and each missing objective it reports:
- **It passes the three-part test:** add it under **Added during implementation**, tagged
  `pr-readiness pass N`, and go back to the work loop.
- **It fails the test:** add it under **Blocked on you**.

**Within this run, a finding that passes the test is fixed**, failing tests included. That
overrides pr-readiness's "do not fix without asking": you were asked, by `/implement-pr`.

**Stop the checkpoints** after the first pass that adds nothing new you can fix. A finding
already recorded under **Blocked on you** does not count as new. There is no fixed number of
passes, but a pass that repeats the previous pass's findings is the last one.

## 5. The end

The run ends only when every open item is under **Blocked on you**, or there are no open items
at all. Before you treat it as over, do the **idle check**. Each line that fails is work, so do
it, and come back here afterwards:

- every check in the plan's Verification section, and the repo's typecheck, lint and format,
  ran after the last edit to the files it covers;
- the repo's documentation and comment rules are met for every changed path (use its skills for
  that, such as a comment sweep);
- the PR description has been regenerated locally if the repo has a skill for it. Uploading it
  stays the user's;
- every **Blocked on you** item has had its independent part done and the rest prepared (step 3);
- the last pr-readiness pass ran after the last code change.

Then:

1. **Re-check the plan file.** Every tick has its evidence, and the hard link is intact.
2. **Report:**
   - the last pr-readiness table and verdict;
   - what this run did, by item;
   - what it added to the plan, and from which source.
3. **Ask the blocked questions** in one `AskUserQuestion`. Rank them by how much work each one
   unblocks, with at most four questions, each led by your recommended answer. List the rest in
   the report.
4. **Work every answer** back into the plan, then continue from step 3 of this skill.
   Publishing, which means the push and the PR, stays with the user: name the exact command
   instead of running it.
