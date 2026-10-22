---
name: bg-shorten-comment
description: |
  Runs the shorten-comment skill on one comment in a background subagent and relays only its short report, so the comment-shortening transcript (the block lookup, the reads, the judgment) never enters this conversation's context. Prefer this over invoking shorten-comment inline whenever the comment is a side task to other work, or the user asks for it in the background, without blocking, or "via a subagent". Use shorten-comment directly only when the user wants to watch or discuss the judgment itself. Invoked as /bg-shorten-comment <file-path-ref> [low|medium|high]; the level defaults to shorten-comment's own medium.
argument-hint: '[file-path-ref] [low|medium|high]'
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
