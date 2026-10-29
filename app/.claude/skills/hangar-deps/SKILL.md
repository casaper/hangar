---
name: hangar-deps
description: Runs a dependency sweep of the hangar CLI package (app/package.json, its lockfile and the pnpm pin) — measures with `pnpm deps:survey`, takes every update past the 14-day release floor inside its current line, runs every gate, and commits it as chore(deps) on main without pushing. Use whenever the user asks to update, bump or refresh the hangar's dependencies or packages, asks "any safe updates?", "can we take the undici fix yet?", "is TypeScript 7 possible now?", wants a `pnpm audit` finding fixed, or asks when a held or waiting package clears. Not for a clone's own (Angular) dependencies, and not for `git pull`-style updates of the hangar repo itself.
---

# Dependency sweep for the hangar CLI

A sweep moves `app/`'s dependencies as far as is safe **today**, and says exactly when the rest
can move. Safe has three parts, and every step below serves one of them:

- **The floor** — nothing published less than `minimumReleaseAge` ago (14 days, in
  `app/pnpm-workspace.yaml`) is installed. That window is when a compromised release usually gets
  caught and unpublished. Never lower it, pass a config override, or exempt one package unless the
  user explicitly says so for that package.
- **The line** — a sweep stays inside each package's current major (or the line a hold sets).
  A new major is a decision with its own changelog to read, so it is asked about, never taken.
- **The gates** — every gate in `app/CLAUDE.md` passes after the move, plus the two that only a
  dependency change needs (schema and changelog baseline).

The rules behind these (caret restoring, peer ceilings, `@types/node`, the pnpm pin) are in
`app/CLAUDE.md`'s dependency-sweep section, which is already in context. This skill is the
procedure.

## 1. Preflight

```bash
git status --short          # must be empty; a sweep's commit holds nothing else
git branch --show-current   # main
command -v pnpm && date --version | head -1   # direnv loaded: pnpm on PATH, GNU date
```

If the tree is dirty, stop and say so — do not stash someone's work to make room. Everything
happens in `app/`; a clone's dependencies are that clone's agent's business.

## 2. Measure

```bash
pnpm -s deps:survey
```

Its report is the plan. Do not re-derive dates or peer ranges by hand. That hand work is what this
script replaces, and it was where earlier sweeps went wrong. Sections:

- **TAKE** — past the floor, inside the line. Take every row.
- **WAITS** — the next release in the line and the UTC time it clears. Report it.
- **HELD** — a standing hold (`reference/holds.md`). `still blocked` → leave it. `UNBLOCKED` →
  stop and ask: lifting a hold is a migration with its own plan, not a bump.
- **MAJOR AVAILABLE** — ask; never take it in a sweep.
- **AUDIT** — each advisory's fix and when it clears. A fix past the floor lands through the
  transitive update in step 3; one still inside the floor waits, like everything else.
- **CURRENT** — nothing to do.

If TAKE is empty and no AUDIT fix is past the floor, there is nothing to sweep: report the WAITS
and AUDIT dates and stop. No empty commit.

## 3. Apply

For each TAKE row (in `app/`):

```bash
pnpm add <pkg>@<version>        # -D for a (dev) row
```

`savePrefix: ''` writes an exact pin. When the survey says _range was a caret_, put the `^` back
in `package.json` by hand and run `pnpm install`, so the change stays a bump.

**The pnpm row is different**: corepack reads `packageManager`, not the lockfile. Edit
`"packageManager": "pnpm@<version>"` by hand, then grep for the old version and move the ones that
name the pin (`app/CLAUDE.md` does): `grep -rn '<old>' CLAUDE.md ../.envrc.hangar`.

Then the transitive sweep, which is also what lands audit fixes:

```bash
pnpm update                     # bare: leaves the manifest alone; pnpm 12 rejects --depth
pnpm peers check                # only the standing conventional-commits-parser line is expected
git diff --stat                 # package.json and pnpm-lock.yaml, nothing else
```

A new unmet peer is a finding: undo the package that introduced it (step 4's recovery) and
report it.

## 4. Gate

From `app/`, all of them, in this order (cheapest first):

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm golden && git diff --exit-code dev/golden/gated
pnpm scan
hangar config schema --check                       # zod is the schema's second input; run always
pnpm changelog && git diff --exit-code ../CHANGELOG.md   # the changelog toolchain's own check
pnpm audit                                         # re-read: did the fixes land?
hangar ports >/dev/null && hangar config validate  # a runtime smoke; dotenv, yaml, zod load here
```

`pnpm test`'s summary lines start with `ℹ` (`ℹ pass 451`), not `#`.

**A red gate**: find the package responsible (usually obvious from the error, else bisect the
TAKE list), put it back with `git checkout package.json pnpm-lock.yaml`, re-apply the others,
and `pnpm install`. Then re-gate. Report the one that failed and why. Do not change `src/` to
make a bump fit without asking: that is a code change wearing a `chore` label.

## 5. Commit

One commit, straight to `main` (dev mode's rule). The type is `chore(deps)`.

```
chore(deps): Take dotenv 18.0.8 and the undici 7.30.1 advisory fix

<each TAKE row old -> new, and the transitives that moved>

Waits on the floor: <pkg version and its clear date, from WAITS and AUDIT>. Held, re-measured
today: <each HELD row's evidence line>. Asked, not taken: <any MAJOR AVAILABLE>.

typecheck, lint, format:check, test (<n>), golden, scan, the schema check and the changelog
baseline are clean.

Co-Authored-By: …
```

The body is the regression record, so make it specific. Wrap at 100, and never start a line with
a lone word and a colon (`Held:`), because commitlint reads that as a footer. **Never push.** End
by telling the user that `main` is ahead and that pushing is theirs:
`! git -C <hangar root> push`.

## 6. Record

If a hold's evidence changed in a way that matters (its unblock fact came true, or the reason
moved), update `reference/holds.md` in the same commit, in the present tense. Describe how
things stand now, not what used to be true.
