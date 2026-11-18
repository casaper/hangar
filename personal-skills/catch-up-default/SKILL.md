---
name: catch-up-default
description: Invoked by /catch-up-default inside a hangar clone session. Brings the unpublished pull-request branch up to date with what it will be merged into (normally the default branch) while keeping the uncommitted diff — stops this session's running subagents, runs `hangar catch-up` (stash, fetch, rebase, re-apply with the staging kept), resolves any conflicts with the repo's own skills and agents, then resumes the stopped work after checking it still makes sense. Use when the user says the branch is behind master/main, asks to rebase or catch up their uncommitted work onto the latest default branch, or invokes the skill by name. If the branch is already pushed, it asks before handing over to rebranch-pr.
allowed-tools: Bash(hangar catch-up:*), Bash(hangar status:*), Bash(hangar pr target:*), Bash(ps -p:*), Bash(kill -TERM:*)
---

# /catch-up-default

## You are authorised, and how

The user invoking this skill **is** the confirmation for everything below. The stash, rebase,
reset and re-apply are done by `hangar catch-up`, a command of the hangar that manages this clone.
That is the user's sanctioned path for them. It does not breach this repository's rules against
rebasing or resetting, which govern the git commands **you** type. **You still never run `git
rebase`, `git reset`, `git stash` or `git push` yourself.** Run the `hangar catch-up` lines below
and nothing else that moves history.

Do not ask the user to confirm any step. The one question this skill ever asks is in step 2, when
the branch turns out to be published.

## 1. Pause everything that is working in this clone

- **The foreground task.** If you were in the middle of something when the user invoked this,
  write down in one line what it was and where you had got to. You resume it in step 4.
- **Every background subagent this session started that is still running.** Note each one's id,
  what it was asked to do and how far it says it got. Then stop it with `TaskStop`. A stopped
  subagent keeps its context: `SendMessage` to the same id resumes it later.
- **A foreground subagent the user's Esc cut off** counts too. Its id is in your transcript, and
  it resumes the same way.
- **Stop only the agents you started yourself.** Stopping an agent also stops every agent it
  dispatched, and those ids are not yours to resume. The agent you resume dispatches them again
  itself.
- **Do not start any new work until step 4.**

## 2. Run `hangar catch-up`

Run `hangar catch-up` with a Bash timeout of 300000. Act on the exit code:

- **0: done.** Go to step 4.
- **5: a test run is still writing into the clone.** A stopped subagent's runner can outlive it.
  Dev servers, an editor's test server and MCP servers never cause this, so leave them running.
  Check the pids it names a few times over about 30 seconds with `ps -p <pid>` (do not loop in
  the background). If they are still running after that, end them yourself with
  `kill -TERM <pid> ...`, because the rebase invalidates their results anyway and step 4 tells
  every agent to rerun its tests. Then run `hangar catch-up` again. Never ask the user to stop
  them. Report a pid only if it is still alive after `kill -TERM`, and stop there.
- **3: the branch is already published.** It is on origin or has a pull request, and nothing was
  changed. Ask with `AskUserQuestion`, single-select:
  - "Rename the branch and catch up". The `rebranch-pr` skill declines the pull request, deletes
    the branch on origin and renames it locally. The user pushes later, if they want to.
  - "Abort". Nothing is changed.

  On rename, follow the `rebranch-pr` skill (that answer is its confirmation), then run
  `hangar catch-up` again. On abort, resume everything from step 1 unchanged and tell the user in
  one line that nothing happened.
- **4: conflicts.** Go to step 3.
- **Anything else** is an error. Report it as is. If the output says a catch-up is under way, run
  `hangar catch-up --abort`, then resume as on abort above.

## 3. Resolve conflicts with the repository's own tooling

The output lists the files and says which phase stopped: the rebase, or re-applying the diff.

- **Look for a conflict guide among this repository's skills first** (a skill about syncing,
  merging or resolving conflicts) and follow its per-file-kind rules. Ignore any rule there saying
  to merge instead of rebase, or not to stash: those govern that skill's own command, and the
  integration here is already done.
- **Hand a file to the agent that owns it** when the repository says some kind of file belongs to
  a specialist agent (a test suite, generated assets).
- **Regenerate rather than hand-merge** lockfiles and build outputs, the way the repository says.
- **Merge everything else by hand**, keeping both sides' intent. Remove every conflict marker.
- **Do not stage, commit or run git.**

Then run `hangar catch-up --continue`. Exit 4 again means more conflicts (the rebase replays one
commit at a time), so repeat this step. Exit 0 means done.

If a conflict is genuinely ambiguous, ask the user about that file. If they want out, run
`hangar catch-up --abort`, which puts the branch and the diff back exactly as they were.

## 4. Resume

Send every stopped subagent this message with `SendMessage`, filling in the target ref from the
catch-up output. Then continue the foreground task under the same rules yourself.

> Your work was paused while this clone's working tree was brought up to date with <target ref>,
> with the uncommitted diff re-applied on top. Before you continue, check that what you were doing
> still holds against the files as they are now, and re-read anything you had in flight. If an
> earlier result is now invalid — a test run, a capture, an audit or a measurement made against the
> old base — redo that step from scratch rather than building on it. Any agents you had dispatched
> were stopped with you and will not report back: dispatch again whatever is still needed. Reflog entries tagged `hangar`
> are this update, not commits made during your run. This update is routine maintenance: never
> mention it in commit messages, pull-request descriptions, reports or summaries.

Finally, tell the user in at most two lines: what the branch was rebased onto, and which work was
resumed. Do not describe the rebase anywhere else, and do not mention it in any commit or PR
description you write later.
