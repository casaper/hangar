# You are in developer mode

This session was launched by `hangar claude -m dev`, with the working directory set to `app/` so
that `app/CLAUDE.md` is **already loaded** rather than waiting for you to read a file under it.
Its instructions and permission rules were read once, at startup.

The operator tab is the other window of the same tmux session, and `C-b n` reaches it.

## Your remit

You change the `hangar` CLI. `app/CLAUDE.md` is your primary guidance and governs every edit under
`app/src/**` — the package layout, the two conventions, the code map, the five seams, and the
hangar-root files this package generates.

**Read `hangar-internals` before changing a subsystem, not after.** Being consulted before the code
is touched is the whole purpose of that skill: `pnpm test` is a seed suite over the pure core and
nothing else, so for the two-thirds of this CLI that touches a live working tree those "this exists
because it caught something" notes are still the only surviving record of a fixed bug. Take the one
reference file that matches what you are touching; they are not all loaded at once.

**You have the `hangar` tools too, and a caution comes with them.** `mcp__hangar__*` is one tool
per command, served by `hangar mcp` from this same working tree — so an edit under `app/src/mcp/`
reaches the server at its next start, which is the next `hangar claude`, not now. Use them to look
around. **Do not use them to test a change**: a tool call is not what a user types, and this mode's
job is the thing that gets typed. Run the real command.

## You are not in a clone

The `CLAUDE.md` above the app one is the fleet map, addressed to sessions running inside a clone.
You are at the hangar root. "Stay in your own clone" is not about you — but **the clones are still
other agents' live working directories**, and reading them is fine while writing to them is not.

## The gates

From `app/`, after any change:

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

and, if you touched `config/schema.ts`, a fifth that nothing runs for you:

```
hangar config schema --check
```

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

The hook is a **one-time manual install**, and it cannot be otherwise: `pnpm-workspace.yaml` sets
`ignoreScripts: true`, so husky's `prepare` never runs.

```
pnpm hooks   # once per clone of this repo
```

Until you have run it, nothing local checks your commit message — only the `commitlint` job in
`.github/workflows/release.yml` does, after the push. A commit that lands on `main` is what
semantic-release reads to pick the next version and write `CHANGELOG.md`, so a wrong type is a
wrong release, not just an untidy log.

## You are the mode that maintains operator mode

`.claude/modes/ops.md`, `.claude/modes/ops.settings.json` and the `hangar-ops` skill are writable
here and denied in operator mode. That asymmetry is deliberate and is the reason this mode exists
in the pair: **operator mode cannot improve its own instructions, and this one can.** When you
change what a command does, the operator-facing half moves too — `hangar-ops/reference/commands.md`
for flags, `.claude/modes/ops.md` for the remit, and the matching
`hangar-internals/reference/*.md` for why.
