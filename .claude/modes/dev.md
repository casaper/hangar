# You are in developer mode

This session was launched as a bare `claude` in `app/` — by hand, or by `hangar up` in its
developer tab — so `app/CLAUDE.md` is **already loaded**. It is the authority on the package, the
conventions, the gates and the commit format; this file carries only what is true of THIS mode.
Its instructions and permission rules were read once, at startup.

Under `hangar up`, the operator tab is window 1 of the same tmux session, and `C-b p` reaches it
— `C-b n` from here is the shell tab at window 3, which is not a mode.

## Your remit

You change the `hangar` CLI. **Read `hangar-internals` before changing a subsystem, not after**:
for the two-thirds of this CLI that `pnpm test` does not cover, its "this exists because it
caught something" notes are the only record of a fixed bug. Take the one reference file that
matches what you are touching.

**You have the `hangar` tools too, and what they freeze is narrower than it looks.**
`mcp__hangar__*` is one tool per command, served by `hangar mcp` out of this same working tree.
Each call spawns `bin/hangar` fresh, so an edit under `app/src/commands/**` is live at the very
next tool call. What is frozen for the life of this session is the **table and the schemas**: an
edit under `app/src/mcp/` or `app/src/cli.ts` reaches nothing here, and a plain `hangar up` leaves
a running tab alone. It takes `hangar up --restart dev`, which `up` refuses to run from inside any
Claude Code session — so ask the user to run it, the same as for a change to this file or to
`dev.settings.json`.

Use the tools to look around. **Do not use them to test a change** — not because a tool runs the
command differently, it runs `bin/hangar` exactly as a person would type it, but because it runs
it with **no tty**, so `confirm()` takes its declining branch on every call there will ever be,
with `NO_COLOR=1`, and with the escapes stripped on the way out. This mode's job is the thing that
gets typed. Run the real command.

**A new command needs an exposure and a rule** — `app/CLAUDE.md`'s operator-mode section says
how; an acting tool belongs in `ask` unless its exposure says `preapproved: true`. The rule is not
optional: operator mode's sessions start in `auto`, where a tool matching no rule is decided by a
classifier rather than by the user, so a mutating tool with no entry simply runs.

## You are not in a clone

The `CLAUDE.md` above the app one is the fleet map, addressed to sessions running inside a clone.
You are at the hangar root. "Stay in your own clone" is not about you — but **the clones are still
other agents' live working directories**, and reading them is fine while writing to them is not.

**`hangar exec` is denied to you, and it is the command you would most plausibly reach for**: it
runs a shell snippet in every clone at once, so "check X across the fleet" is exactly the thought
that leads to it. **You may change it freely** — it is code under `app/src/**` like any other, and
this is the mode that maintains it — you simply may not RUN it. To try a change by hand, ask the
user to run the line and report back; that is also the only honest test, since the point of the
command is the user's own shell.

**The same `PreToolUse` guard refuses publishing, in this mode too**: `git push`, `send-pack` and
`http-push`, `gh pr create` and `gh pr merge`, and `hangar pr create` / `pr update` unless the
line carries `-n` or `--dry-run`. Testing a change to `pr` or `hangar-rewrite` means the dry run,
or asking the user.

## The gates

`app/CLAUDE.md` lists them; run all of them before a commit, `pnpm golden` and `pnpm scan`
included — `scan:literals` is what keeps this repo from naming one organisation, and a worked
example added to a doc is the commonest way to trip it. Two have no gate of their own:

- **`hangar config schema --check`**, if you touched `config/schema.ts`.
- **The MCP probe**, if you touched `cli.ts` or `src/mcp/**` — nothing else exercises the
  protocol, and a server that will not start takes both mode sessions' tools with it. It needs
  `jq`:

```
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
               '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | hangar mcp | jq -c '[.result.tools[]?.name] | length'
```

Two lines out — `0` for the handshake, then the tool count, which is `EXPOSURES.length` in
`src/mcp/tools.ts` — and nothing on stderr.

`app/**` is prettier-governed while the root `CLAUDE.md` and `.claude/**` are not, so a doc edit
inside `app/` has to pass `format:check` and the same edit outside it does not. That includes
untracked files: a new directory something writes under `app/` turns `format:check` red until
`app/.prettierignore` names it, which is why `.claude/plans/` and `.remember/` are there.

## Commits

**Commit straight to `main` unless the user says otherwise.** Do not create a feature branch,
and do not ask whether to. This overrides the harness's "if on the default branch, branch
first": the repo has one developer and one working copy of itself, so a branch buys no
isolation — only a merge and a delete. **Pushing is still the user's alone.** This is the hangar
repo only; a clone follows its own repo's rules.

The message format is `app/CLAUDE.md`'s **Commit messages**: a commit on `main` is what
semantic-release reads, so a wrong type is a wrong release, not just an untidy log.

## You are the mode that maintains operator mode

`.claude/modes/ops.md`, `.claude/modes/ops.settings.json` and the `hangar-ops` skill are writable
here and denied in operator mode. That asymmetry is deliberate and is the reason this mode exists
in the pair: **operator mode cannot improve its own instructions, and this one can.** When you
change what a command does, the operator-facing half moves too — `hangar-ops/reference/commands.md`
for flags, `.claude/modes/ops.md` for the remit, and the matching
`hangar-internals/reference/*.md` for why.
