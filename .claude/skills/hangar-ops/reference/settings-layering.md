# Claude Code settings layering across the fleet

Which value belongs in which of the three settings files, and the one timing rule that catches
everyone. The hangar's `CLAUDE.md` carries the short version; this is the enumeration.

Only two things differ per clone: **`theme`** and the **Storybook health-check port** in
`permissions.allow`. Everything else in `.claude/settings.local.json` is byte-identical across
every clone (verify with `jq -S 'del(.theme)|del(.permissions.allow)' … | shasum`).

- `~/.claude/settings.json` (user) holds the genuinely global preferences —
  `skillListingBudgetFraction`, `prefersReducedMotion`, the `Explore` and `mcp__dash-api__*`
  allows, the `Read(~/.ssh/**)` deny. Do **not** move fleet-scoped keys up here: this machine has
  other projects, and `autoMemoryDirectory`, `plansDirectory`, `statusLine` and
  `enabledMcpjsonServers` would leak the fleet onto them.
- `clone_NN/.claude/settings.local.json` (untracked) holds the fleet-scoped keys, identical in
  every clone: the shared memory directory, the two `SessionEnd` hooks (one runs `plans collect`;
  the other runs `tmp merge --quiet` so this clone's new Jira cache entries reach the store),
  the `PreToolUse` hook that serves a cached Jira ticket from the record store (additive — Claude
  Code merges it with the repo's own tracked `PreToolUse` guard rather than replacing it), the
  shared statusline, the six MCP servers
  (`playwright`, `jira`, `yfiles-api`, `angular-cli`, `primeng`, `ag-mcp`), the `frontend-design`
  plugin off, the `.env.shared` deny, and the two iTerm2 keys (`terminal.explorerKind`,
  `terminal.external.osxExec`).
- `.claude/settings.json` is **tracked and shared** — never put a per-clone or personal value there.

## The hangar root's own settings

`.claude/settings.json` at the hangar root is **tracked and committed** — it holds no personal
values, which is why it is not a `.local.json`. It carries exactly two keys:
`autoMemoryDirectory` (the shared fleet memory, which every clone also points at, so a memory
written from either side is immediately visible on the other) and `plansDirectory: "plans"` (the
fleet root *is* the project root for a session started there, so it writes straight into the shared
archive).

**It carries no `permissions` block, deliberately.** Every `hangar` command prompts, including
`hangar list`. That is the fleet's choice: `hangar doctor` and `hangar doctor --fix` differ by one
flag, and Claude Code's Bash patterns match by prefix, so there is no way to pre-approve the report
without also pre-approving the writer. Ask each time.
