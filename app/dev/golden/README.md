# Golden capture

Regenerate with `pnpm golden` from `app/`. Two halves, and only one of them is a gate.

## `gated/` — diff this

Derived from the config and the clone index alone, so it is byte-stable across days:

- `gated/hangar/{verbatim,normalised}/` — every artifact this hangar would write, plus
  `manifest.txt` recording each one's **destination**, the discovery source that answered, and
  `EditorSelection.fellBack`. Paths matter as much as content: every path in this CLI is a bare
  `string`, so a builder rendering perfect text into the wrong file passes a content-only diff.
  It also holds the two hangar-ROOT generated files under `hangar-root/`: `.claude/settings.json`
  and `CLAUDE.local.md`. Both were tracked with an absolute home directory in them, and both reach
  a reader who cannot tell where the value came from — Claude Code fails silently on all three of
  the settings values, and the identity file is prepended to every clone session.
- `gated/fixture/normalised/` — the same capture against `dev/fixture.config.yaml`, a config
  whose every value differs from this hangar's *and* from the schema defaults. Normalised only:
  the verbatim copy names a temp directory. **This is the half that certifies anything.** While
  a config agrees with the defaults, "read the file" and "fell into a catch and used the
  defaults" produce identical output.
- `gated/commands/` — the command outputs that are genuinely derived. `setup-dry-*.txt` is one
  per preset, rendered in an EMPTY temp directory: with no clones to read, `setup` is on the
  path a colleague's first run takes, and every value in the result is either asked for or
  admitted to be absent. It is not captured against this hangar deliberately — `setup` needs
  `--force` to re-render, and aiming that here would leave the live gitignored config one `-n`
  regression away from being destroyed by the net meant to protect it.

The gate is `pnpm golden && git diff --exit-code dev/golden/gated`.

**In a hangar that is not this one, only the fixture half is portable.** `gated/fixture/` derives
from a checked-in config with synthesised clone indices and `%HANGAR%`/`%HOME%` normalised away, so
it renders identically anywhere. `gated/hangar/` is a capture of THIS hangar's real config and real
clones, so a fresh clone of a published hangar repo diffs against it on the very first run — even
in the normalised half, because the content describes this config. That is not a reason to drop it
(it is the half that caught the unanchored `clone_*/` gitignore rule, which had silently swallowed
121 of this baseline's 136 files); it means a new hangar regenerates that half once and commits it
as its own baseline, and the fixture half is what a change to the CLI is gated on.

**An expected diff is not a failure, but it must be enumerated in advance.** Most of Track F
makes a key live for the first time, and the fixture half is *supposed* to change when it does
— that change is the proof. Write down the expected delta before making the change; an
unenumerated line in a fixture diff is the finding.

## `advisory/` — read this, never gate on it

Moves with what the clones are doing: branches, last commits, how many entries the shared
`tmp/` holds. Shas and dates are scrubbed to keep a diff readable. `doctor --all`,
`status --all` and the `tmp`/`plans` dry runs all live here — worth knowing before trusting a
green command diff.

**This half is gitignored**, which is why it never shows up in a diff: tracking it would dirty
every `git status` after a regeneration and bury the one diff that matters. So a dirty
`dev/golden/` always means the **gate** moved.
