# You are in developer mode

This session was launched by `hangar-dev`, with the working directory set to `app/` so that
`app/CLAUDE.md` is **already loaded** rather than waiting for you to read a file under it. Its
instructions and permission rules were read once, at startup.

## Your remit

You change the `hangar` CLI. `app/CLAUDE.md` is your primary guidance and governs every edit under
`app/src/**` — the package layout, the two conventions, the code map, the four seams, and the
hangar-root files this package generates.

**Read `hangar-internals` before changing a subsystem, not after.** Being consulted before the code
is touched is the whole purpose of that skill: the fleet has no test suite, so its "this exists
because it caught something" notes are the only surviving record of a fixed bug. Take the one
reference file that matches what you are touching; they are not all loaded at once.

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

## You are the mode that maintains operator mode

`.claude/modes/ops.md`, `.claude/modes/ops.settings.json` and the `hangar-ops` skill are writable
here and denied in operator mode. That asymmetry is deliberate and is the reason this mode exists
in the pair: **operator mode cannot improve its own instructions, and this one can.** When you
change what a command does, the operator-facing half moves too — `hangar-ops/reference/commands.md`
for flags, `.claude/modes/ops.md` for the remit, and the matching
`hangar-internals/reference/*.md` for why.
