---
name: bg-shorten-changed-comments
description: |
  Runs the shorten-changed-comments skill in a background subagent and relays only its short report, so the sweep's transcript (the diff scan, the reads, the per-block judgment) never enters this conversation's context. Prefer this over invoking shorten-changed-comments inline whenever the sweep is a side task to other work — a pre-commit pass, a clean-up after a refactor — or the user asks for it in the background, without blocking, or "via a subagent". Use shorten-changed-comments directly only when the user wants to pick the blocks or watch the judgment. Invoked as /bg-shorten-changed-comments [base-ref]; the base defaults to the branch's fork point.
argument-hint: '[base-ref]'
allowed-tools: Agent
---

# /bg-shorten-changed-comments [base-ref]

The same as typing
`Spawn a background subagent that runs shorten-changed-comments <base-ref> and reports back.`

Arguments: `$ARGUMENTS`

1. **Spawn exactly one subagent** with the `Agent` tool:
   - `subagent_type`: `general-purpose`
   - `description`: `shorten-changed-comments`
   - `prompt`:

     ```
     Run the shorten-changed-comments skill on $ARGUMENTS and report back.
     You are running in the background and cannot ask the user anything. At Step 1b take
     "Sweep all N" and say in the report that you did. Do not commit.
     ```

   Pass the arguments through verbatim, and with none, drop the `on` clause: the skill picks its
   own base.
2. **Do nothing else with the comments.** Do not run the finder script, do not run the sweep
   inline, do not poll the subagent. Tell the user in one line that it is running in the
   background, and that the files it sweeps should be left alone until it reports — its closing
   `git status` check compares against the tree it saw.
3. **When the subagent's notification arrives**, relay its report unchanged — the revert line
   included.
