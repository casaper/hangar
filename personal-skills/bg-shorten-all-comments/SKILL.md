---
name: bg-shorten-all-comments
description: |
  Runs the shorten-all-comments skill on the files you name in a background subagent and relays only its short report, so the whole-file sweep's transcript (the block scan, the reads, the per-block judgment, any per-file workers) never enters this conversation's context. Prefer this over invoking shorten-all-comments inline whenever the clean-up is a side task to other work, or the user asks for it in the background, without blocking, or "via a subagent". Use shorten-all-comments directly only when the user wants to choose the level for a large file or watch the judgment. Invoked as /bg-shorten-all-comments <file> [<file>…] [low|medium|high]; the level defaults to medium.
argument-hint: '<file> [<file>…] [low|medium|high]'
allowed-tools: Agent
---

# /bg-shorten-all-comments <file> [<file>…] [low|medium|high]

The same as typing
`Spawn a background subagent that runs shorten-all-comments <files> <level> and reports back.`

Arguments: `$ARGUMENTS`

1. **No file paths in the arguments?** Ask which files, and stop. shorten-all-comments refuses to
   run without them, so there is nothing to spawn.
2. **Spawn exactly one subagent** with the `Agent` tool:
   - `subagent_type`: `general-purpose`
   - `description`: `shorten-all-comments <first file name>`
   - `prompt`:

     ```
     Run the shorten-all-comments skill on $ARGUMENTS and report back.
     You are running in the background and cannot ask the user anything. At Step 3 keep the
     level you were given, medium if none, and name in the report every file that was over ~30
     blocks. If the Agent tool is not available to you, sweep every file inline. Do not commit.
     ```

   Pass the arguments through verbatim. Do not add a level the user did not give.
3. **Do nothing else with the comments.** Do not read the files, do not run the sweep inline, do
   not poll the subagent. Tell the user in one line that it is running in the background, and
   that the named files should be left alone until it reports.
4. **When the subagent's notification arrives**, relay its report unchanged — the revert line
   included — and add one line that the sweep belongs in a commit of its own.
