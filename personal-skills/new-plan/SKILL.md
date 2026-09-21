---
name: new-plan
description: Invoked by /new-plan [optional title]. Archives the session’s current plan file under its own title, stamped with the session it came from, then starts a fresh plan in the same conversation and leaves the session in plan mode. Use whenever a new plan is wanted without losing the old plan or the conversation.
---

# /new-plan [optional title]

## What this is for

Claude Code binds **one plan file to a session, for the life of that session**. Entering plan mode
again re-announces the same path — it never allocates a second one — so planning something new in
the same conversation means overwriting the plan that is already there.

The two obvious ways out are both wrong:

- **Start a new session.** Keeps the plan, loses the conversation.
- **Copy the plan aside and overwrite.** Keeps both, but the copy is an orphan: a random slug for
  a name, and nothing in it saying which conversation produced it.

`/new-plan` is the third way. The live plan file is moved out from under the harness, renamed to
its own `# ` heading and stamped with the session id, the transcript path and a `--resume` line,
so the archive answers "where did this come from" on its own. The conversation is untouched, and
the session is left in plan mode with an empty plan file, ready for the new one.

## Procedure

**1. Find the live plan file. Do not guess it.** Its absolute path is stated in the plan-mode
system message already in context — the `## Plan File Info` block, or a line reading *"A plan file
already exists at …"* / *"A plan file exists at … from your previous planning session"*. Never
glob the plans directory for it and never assume `~/.claude/plans`: a project that sets
`plansDirectory` puts it somewhere else entirely.

**2. If you find no such path, do not infer that there is no plan.** Two different situations
look alike here and they need opposite answers:

- **No plan mode at all** — nothing in context restricts you to a plan file. There is nothing to
  archive: say so in one line and go straight to step 6, which is the whole of what is left to do.
- **Plan mode is running but you cannot find the path** — there is a read-only/plan-file
  restriction in context and no path you can read off it. **Stop and ask.** Do not archive
  anything and do not call `EnterPlanMode`: acting here would either declare a live plan absent
  or move the wrong file.

**3. Archive it, in one call:**

```
~/.claude/skills/new-plan/archive-plan.sh '<the absolute plan path from step 1>'
```

It prints the dated path it archived to, and truncates the live file. It refuses rather than
guessing — a missing argument, a file that is not there, a file that is empty, a file holding
nothing but its own `# ` heading — and its message says which of the four it was. The last two
both mean `/new-plan` has already run and there is nothing to save.

**If the call is refused because plan mode is read-only**, do not work around it and do not fall
back to copying the file with a tool. Print the command for the user to run themselves:

```
! ~/.claude/skills/new-plan/archive-plan.sh '<the absolute plan path>'
```

and wait for them. This is the only write `/new-plan` performs, and it has to be a real one.

**4. Report it in one line** — the archived path, nothing else. No summary of the old plan.

**5. Write the new plan's heading, before anything else.** The script leaves a zero-byte file
behind, and an empty plan file is exactly what the next plan-mode entry will be told to go and
read. So `# <title>` goes in immediately — the title the user gave after `/new-plan`, or your own
one-line reading of what they just asked for, which they can correct. Nothing else goes in.

Until real content is written under it, that heading is all the plan is, and step 3 will refuse to
archive it — so `/new-plan` run twice in a row says "nothing but its title" rather than filing an
empty plan. Retitling is an edit to the heading, not another `/new-plan`.

The title matters beyond decoration: the live file's name belongs to the harness and cannot be
changed, so the heading you write now is what names **this** plan when its own turn to be archived
comes. A plan with no heading gets archived under the harness's random slug, which is the outcome
this skill exists to avoid.

**6. Call `EnterPlanMode` as the last tool call of the turn, and then stop.** `/new-plan` ends in
plan mode on every path — including the "nothing to archive" one — and by the time a new plan is
wanted the session is usually back in `default`, because the last plan was approved.

- Call it **unconditionally**, without checking which mode you are in. It needs no permission, has
  no "already in plan mode" guard, and re-announces the plan file step 3 just reset, so making the
  call when plan mode is already on costs one line and buys a fresh `## Plan File Info` block. (If
  the harness does ask, the answer is yes.)
- It is the one call here that **cannot be made from a subagent** — it refuses outright in an
  agent context. Run this skill in the main session; never delegate it.
- Make it the **last** call, and end the turn on the one-line report from step 4. Plan mode's own
  instructions — the plan file block and the phase workflow — arrive on the NEXT turn, so anything
  planned after this call in the same turn is planned without them. Do not start exploring, and do
  not write anything into the new plan beyond the heading.

**7. Do not carry the old plan forward.** Do not read the archive, and do not merge its content or
its scope into the new plan unless the user explicitly asks. It was set aside on purpose.

## What cannot be re-bound

A session gets **one plan file, named once, for its whole life**, and no state anywhere can be
edited to change that:

- The name comes from the session's **first** prompt (`<summary>-<two random words>.md`), so the
  live file goes on describing whatever the conversation opened with, however far it has moved on.
- The binding is an in-memory map keyed by session id. It is discarded only by `/clear` or a fork,
  re-derived only on a filename collision, and even then a path already announced to the model
  keeps its name. No session file, state file, setting, slash command or hook re-points it; the
  only on-disk trace of the binding is the append-only transcript.
- So do not go hunting for state to fix, and do not replace the live plan file with a symlink to a
  better-named one: plan writes go through Claude Code's own storage layer, and `plansDirectory` is
  containment-checked with symlinks resolved, so that is unverified at best and silently writes
  somewhere nobody is watching at worst.

Attribution is therefore something this skill does at **archive** time and cannot do before it:
the `# ` heading names the plan, and the provenance header records which conversation produced it.
That is what step 5 is for — the moment the live file is empty is the one moment its eventual name
is free. (Verified against Claude Code 2.1.267.)

## Where the archives pile up

An archive lands beside the live plan, in whatever directory `plansDirectory` resolves to for that
project, dated `YYYY-MM-DD_-_<title>.md` so a directory of them reads in order. Nothing in this
skill collects them afterwards. In this hangar: a clone session's archives are swept into the
shared `plans/` by `hangar plans collect` at `SessionEnd`, which reads that date prefix as already
stamped and keeps the name; developer mode's stay in `app/.claude/plans/`, which nothing drains
and git ignores.

## What this must never touch

Nothing under `~/.claude/sessions/`, nothing under `~/.claude/projects/`, no project file, and no
`/clear`. The conversation, the transcript and the session id all stay exactly as they were — that
is the entire point of not simply starting a new session.

## Standing approval, if you want it

The script's path is under `$HOME`, so a rule naming it belongs in **`~/.claude/settings.json`**:

```json
"permissions": { "allow": ["Bash(~/.claude/skills/new-plan/archive-plan.sh:*)"] }
```

Not in a project's `.claude/settings.local.json` — a generated one gets rewritten and the rule
goes with it — and not in a tracked `.claude/settings.json`, which would put a home directory into
somebody else's checkout.
