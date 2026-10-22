---
name: bg-shorten-comment
description: |
  Runs the shorten-comment skill on one comment in a background subagent and relays its report when it finishes, so the session is not blocked while the comment is trimmed. Invoked as /bg-shorten-comment <file-path-ref> [low|medium|high]; the level defaults to shorten-comment's own medium.
argument-hint: '[file-path-ref] [low|medium|high]'
disable-model-invocation: true
allowed-tools: Agent
---

# /bg-shorten-comment [file-path-ref] [low|medium|high]

The same as typing
`Spawn a background subagent that runs shorten-comment <file-path-ref> <level> and reports back.`

Arguments: `$ARGUMENTS`

1. **No file reference in the arguments?** Ask which file and lines, and stop.
2. **Spawn exactly one subagent** with the `Agent` tool:
   - `subagent_type`: `general-purpose`
   - `description`: `shorten-comment <file name>`
   - `prompt`: `Run the shorten-comment skill on $ARGUMENTS and report back.`

   Pass the arguments through verbatim. Do not add a level the user did not give: shorten-comment
   applies its own default.
3. **Do nothing else with the comment.** Do not read the file, do not run shorten-comment inline,
   do not poll the subagent. Tell the user in one line that it is running in the background.
4. **When the subagent's notification arrives**, relay its report unchanged — shorten-comment's
   reporting contract already makes it one line per changed block.
