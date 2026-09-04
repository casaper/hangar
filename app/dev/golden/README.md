# Golden capture

Regenerate with `pnpm golden` from `app/`. Two halves, and only one of them is a gate.

## `gated/` — diff this

Derived from the config and the clone index alone, so it is byte-stable across days:

- `gated/hangar/{verbatim,normalised}/` — every artifact this hangar would write, plus
  `manifest.txt` recording each one's **destination**, the discovery source that answered, and
  `EditorSelection.fellBack`. Paths matter as much as content: every path in this CLI is a bare
  `string`, so a builder rendering perfect text into the wrong file passes a content-only diff.
- `gated/fixture/normalised/` — the same capture against `dev/fixture.config.yaml`, a config
  whose every value differs from this hangar's *and* from the schema defaults. Normalised only:
  the verbatim copy names a temp directory. **This is the half that certifies anything.** While
  a config agrees with the defaults, "read the file" and "fell into a catch and used the
  defaults" produce identical output.
- `gated/commands/` — the three command outputs that are genuinely derived.

The gate is `pnpm golden && git diff --exit-code dev/golden/gated`.

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
