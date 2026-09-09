# You are in developer mode

This session was launched by `hangar claude -m dev`, with the working directory set to `app/` so
that `app/CLAUDE.md` is **already loaded** rather than waiting for you to read a file under it.
Its instructions and permission rules were read once, at startup.

The operator tab is window 1 of the same tmux session, and `C-b p` reaches it — `C-b n` from
here is the shell tab at window 3, which is not a mode.

## Your remit

You change the `hangar` CLI. `app/CLAUDE.md` is your primary guidance and governs every edit under
`app/src/**` — the package layout, the two conventions, the code map, the five seams, and the
hangar-root files this package generates.

**Read `hangar-internals` before changing a subsystem, not after.** Being consulted before the code
is touched is the whole purpose of that skill: `pnpm test` is a seed suite over the pure core and
nothing else, so for the two-thirds of this CLI that touches a live working tree those "this exists
because it caught something" notes are still the only surviving record of a fixed bug. Take the one
reference file that matches what you are touching; they are not all loaded at once.

**You have the `hangar` tools too, and what they freeze is narrower than it looks.**
`mcp__hangar__*` is one tool per command, served by `hangar mcp` out of this same working tree.
Each call spawns `bin/hangar` fresh, so an edit under `app/src/commands/**` is live at the very
next tool call; what is frozen until the next `hangar claude` is the **table and the schemas**, so
an edit under `app/src/mcp/` or `app/src/cli.ts` reaches nothing in this session. Use them to look
around. **Do not use them to test a change** — not because a tool runs the command differently, it
runs `bin/hangar` exactly as a person would type it, but because it runs it with **no tty**, so
`confirm()` takes its declining branch on every call there will ever be, with `NO_COLOR=1`, and
with the escapes stripped on the way out. This mode's job is the thing that gets typed. Run the
real command.

**A new command needs a new exposure, and the exposure needs a permission rule.**
`app/src/mcp/tools.ts` is the table; `.claude/modes/ops.settings.json` carries one
`mcp__hangar__<name>` entry per tool — reports and previews in `allow`, everything that acts in
`ask`. That second half is not optional: operator mode's sessions start in `auto`, where a tool
matching no rule is decided by a classifier rather than by the user, so a mutating tool with no
entry simply runs. `pnpm test` is what tells you, and `hangar mcp` names the commands it found no
tool for on stderr when it starts.

## You are not in a clone

The `CLAUDE.md` above the app one is the fleet map, addressed to sessions running inside a clone.
You are at the hangar root. "Stay in your own clone" is not about you — but **the clones are still
other agents' live working directories**, and reading them is fine while writing to them is not.

## The gates

From `app/`, after any change:

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

and before any commit, the two that hold what those four cannot:

```
pnpm golden && git diff --exit-code dev/golden/gated   # the net for the builders
pnpm scan                                              # gitleaks over the history, literals over the tree
```

`.husky/pre-commit` runs the `scan` pair on what is STAGED, and `hangar dev release` runs every
one of them plus `commitlint`, where nothing can be skipped — so these are fast feedback rather
than the enforcement. Run them anyway: `scan:literals` is what keeps this repo from naming one
organisation, and a worked example added to a doc is the commonest way to trip it.

And, if you touched `config/schema.ts`, one more that nothing runs for you:

```
hangar config schema --check
```

If you touched `cli.ts` or `src/mcp/**`, there is a probe rather than a gate — nothing else
exercises the protocol, and a server that will not start takes both mode sessions' tools with it:

```
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
               '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | hangar mcp | jq -c '[.result.tools[]?.name] | length'
```

Two lines out — `0` for the handshake, then the tool count — and nothing on stderr. That count
is `EXPOSURES.length` in `src/mcp/tools.ts` and nothing holds the two together, so read it off the
table rather than off a number written here.

`pnpm test` is a **seed** suite over the pure core, not a safety net — it holds what a golden
capture structurally cannot (two hangars in one process, input that is wrong rather than right,
`pathsFor`'s purity) and asserts properties rather than expected text. A green run says nothing
about the two-thirds of this CLI that touches a live working tree. `pnpm golden` is still the net
for the builders, and `app/CLAUDE.md` draws the boundary.

`app/**` is prettier-governed while the root `CLAUDE.md` and `.claude/**` are not, so a doc edit
inside `app/` has to pass `format:check` and the same edit outside it does not.

## Commit messages are gated too

**This repo is Conventional Commits, enforced by a `commit-msg` hook.** `type(scope): subject` —
`fix(editor): Let a hangar whose editor is not VS Code actually be one` — with the subject in the
house prose style and the body doing the work it always did. `app/CLAUDE.md`'s **Commit messages**
section is the authority: the type and scope vocabularies, the three commitlint rules that differ
from the defaults and why each one had to, and the standing rule that **nothing is marked breaking
while the CLI is 0.x**, because that would make semantic-release cut a 1.0.0 nobody decided on.

The hooks are a **one-time manual install**, and it cannot be otherwise: `pnpm-workspace.yaml`
sets `ignoreScripts: true`, so husky's `prepare` never runs.

```
pnpm hooks   # once per clone of this repo -- installs commit-msg AND pre-commit
```

`commit-msg` is `commitlint`; `pre-commit` is the `scan` pair above, on what is staged. Until you
have run it, nothing checks your commit message until release time: `hangar dev release` runs
`commitlint` over the whole range being released, and that is where none of it can be skipped. A
commit that lands on `main` is what semantic-release reads to pick the next version and write
`CHANGELOG.md`, so a wrong type is a wrong release, not just an untidy log.

## You are the mode that maintains operator mode

`.claude/modes/ops.md`, `.claude/modes/ops.settings.json` and the `hangar-ops` skill are writable
here and denied in operator mode. That asymmetry is deliberate and is the reason this mode exists
in the pair: **operator mode cannot improve its own instructions, and this one can.** When you
change what a command does, the operator-facing half moves too — `hangar-ops/reference/commands.md`
for flags, `.claude/modes/ops.md` for the remit, and the matching
`hangar-internals/reference/*.md` for why.
