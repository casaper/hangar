# Golden capture

Regenerate with `pnpm golden` from `app/`. Two halves, and only one of them is a gate.

## `gated/` — diff this

**Everything here is portable**: it derives from checked-in fixture configs with synthesised
clone indices, in temp directories, with `%HANGAR%`/`%HOME%`/`%SETUP%` normalised away. So it
renders identically in every clone of this repo on every machine, and `pnpm golden` in a fresh
clone is expected to produce **no diff at all**. A diff here is a finding, on the first run as
much as on any other.

- `gated/fixture/normalised/` and `gated/fixture-vscode/normalised/` — every artifact each
  fixture config would write, plus `manifest.txt` recording each one's **destination**, the
  discovery source that answered, and `EditorSelection.fellBack`. Paths matter as much as
  content: every path in this CLI is a bare `string`, so a builder rendering perfect text into
  the wrong file passes a content-only diff, and the manifest is what catches that. Both trees
  also hold the two hangar-ROOT generated files under `hangar-root/`: `.claude/settings.json`
  and `CLAUDE.local.md`. Both were tracked with an absolute home directory in them, and both
  reach a reader who cannot tell where the value came from — Claude Code fails silently on all
  three of the settings values, and the identity file is prepended to every clone session.
- `gated/commands/setup-dry-*.txt` — one per preset, rendered in an EMPTY temp directory: with
  no clones to read, `setup` is on the path a colleague's first run takes, and every value in
  the result is either asked for or admitted to be absent. It is not captured against this
  hangar deliberately — `setup` needs `--force` to re-render, and aiming that here would leave
  the live gitignored config one `-n` regression away from being destroyed by the net meant to
  protect it.

The gate is `pnpm golden && git diff --exit-code dev/golden/gated`.

**The one thing that legitimately differs between machines is the PLATFORM.** Each fixture's
`manifest.txt` carries the platform driver's own answers — the kind and application-support
directory, the capability record, and the VS Code window-state path — recorded here on macOS, so
a Linux run diffs those rows and nothing else. They are captured rather than
normalised away because the platform seam exists at all only because three `darwin`-only
assumptions survived unnoticed until this CLI was published; a capture that hid them would hide
the one thing they were added to make visible.

**Why two fixtures, and why neither agrees with the defaults.** While a config agrees with the
schema defaults, "read the config file" and "fell into a catch and used the defaults" produce
identical output — so a capture whose values match the defaults cannot tell a wired reader from
a swallowed error. Each fixture therefore disagrees with the defaults *and* with the other one,
key by key, so no single swallowed error can satisfy both. `dev/fixture.config.yaml` is the
Zed-shaped one: no app subdirectory, one workspace directory, a literal install command, a
non-zero port offset. `dev/fixture-vscode.config.yaml` is the shape the default editor actually
takes: `rootPathKeys` consumed by the VS Code family, two `workspaceDirs` (so a second workspace
file is rendered per clone), a non-empty `appDir`, a `manager:` install step, a symlink with
`skipIfDirMissing`, and a zero port offset.

**An expected diff is not a failure, but it must be enumerated in advance.** Making a config key
live for the first time is *supposed* to change a fixture half — that change is the proof. Write
down the expected delta before making the change; an unenumerated line in a fixture diff is the
finding.

## `advisory/` — read this, never gate on it

Two different things land here, and only the first is what "advisory" usually means:

- **It moves.** Branches, last commits, how many entries the shared `tmp/` holds. `doctor --all`,
  `status --all`, `list` and the `tmp`/`plans` dry runs all read live state, so a green diff of
  one proves less than it looks like it does. Shas and dates are scrubbed to keep a diff
  readable.
- **It is stable but not portable.** `advisory/hangar/{verbatim,normalised}/` is every artifact
  THIS hangar would write, and `advisory/commands/{ports,config-show,config-validate,`
  `colours-sync-dry}.txt` read this config and this clone list. Byte-stable from one run to the
  next on this machine — and different in every other hangar, which is why gating on them made a
  colleague's first `pnpm golden` a 120-file diff. `config validate` is the one that could not
  simply be re-pointed at a fixture: the example-vs-live comparison is its whole value, and a
  fixture in a temp directory has no committed example to compare with.

Nothing was lost in moving the hangar half here except its `verbatim/` tree, and that was
covered twice: it existed to catch a builder writing correct text to the wrong path, which is
what each fixture's `manifest.txt` records line by line.

**This half is gitignored**, which is why it never shows up in a diff: tracking it would dirty
every `git status` after a regeneration and bury the one diff that matters. So a dirty
`dev/golden/` always means the **gate** moved.
