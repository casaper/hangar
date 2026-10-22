---
name: spawn-bg
description: |
  Runs whatever prompt follows the command in a fresh background agent and relays its report when it finishes, so the session stays free and the work's transcript stays out of this conversation. Invoked as /spawn-bg <prompt>.
argument-hint: '<prompt>'
disable-model-invocation: true
allowed-tools: Agent
---

# /spawn-bg <prompt>

The same as typing `Spawn a background subagent that <prompt> and reports back.`

Prompt: `$ARGUMENTS`

1. **No prompt?** Ask what to run, and stop.
2. **Spawn exactly one agent** with the `Agent` tool:
   - `subagent_type`: `general-purpose`
   - `description`: a 3–5 word summary of the prompt
   - `prompt`: the prompt above **verbatim**, then `Report back when done.`
3. **Brief it on what the prompt points at, and nothing else.** A fresh agent sees none of this
   conversation. If the prompt refers to something only this conversation knows — "this file",
   "the error above", "the plan", an `@` reference — append a `Context:` section after the
   prompt that spells it out: absolute paths, the exact error text, the branch or clone. Never
   reword the prompt itself, and add nothing it does not refer to.
4. **Do none of the work inline.** Do not read files for it, do not poll the agent. Tell the user
   in one line that it is running in the background.
5. **When the agent's notification arrives**, relay its report. If it failed or stopped short,
   say so plainly rather than smoothing it over.
