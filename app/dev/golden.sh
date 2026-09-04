#!/bin/sh
# Capture this hangar's golden output. Run from `app/`: `pnpm golden`.
#
# Two captures, and the distinction between them is the whole design:
#
#   GATED    -- output derived from the config and the clone index alone. Byte-stable across
#               days, so `git diff --exit-code dev/golden/gated` is a real gate.
#   ADVISORY -- output that moves with what the clones are actually doing (a branch, a last
#               commit, how many entries the shared tmp/ holds). Captured because it is useful
#               to eyeball, NEVER diffed as a gate: `hangar list` changed twice in the hour
#               this net was written, and a check that is red in normal operation is a check
#               nobody reads.
#
# The builder trees are the real net. Most COMMANDS turn out to be advisory, which is worth
# knowing before trusting a green command diff: `doctor --all`, `status --all` and `tmp merge -n`
# all read live state.
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
hangar_root="$(CDPATH= cd -- .. && pwd -P)"
out=dev/golden
bin="$hangar_root/bin/hangar"

# Longest prefix first: the hangar root lives under $HOME.
normalise() {
  sed -e "s|$hangar_root|%HANGAR%|g" -e "s|$HOME|%HOME%|g"
}

# Advisory output only: collapse the two things that move on every commit, so a human reading
# an advisory diff sees the change they care about rather than forty shas.
scrub() {
  sed -E -e 's/\b[0-9a-f]{9,40}\b/%SHA%/g' -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}/%DATE%/g'
}

rm -rf "$out"
mkdir -p "$out/gated/commands" "$out/advisory/commands"

# --- 1. this hangar's artifacts, verbatim and normalised -----------------------------------
"$bin" dev golden --out "$out/gated/hangar" >/dev/null

# --- 2. the hostile fixture ----------------------------------------------------------------
# Copied into a temp directory under the name `hangar.config.yaml`, because a file by that name
# inside this repo would be a nested hangar marker. Only the NORMALISED tree is kept: the
# verbatim one names a temp directory that differs on every run.
# `pwd -P` matters: on macOS `mktemp -d` hands back a /var path while the working directory
# resolves to /private/var, so HANGAR_ROOT and the upward walk would name the same directory
# two different ways and the manifest would read `/private%HANGAR%`.
fixture="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$fixture"' EXIT INT TERM
cp dev/fixture.config.yaml "$fixture/hangar.config.yaml"
(cd "$fixture" && HANGAR_ROOT="$fixture" "$bin" dev golden --out "$fixture/out" --indices 1,2,3) \
  >/dev/null
mkdir -p "$out/gated/fixture"
# The temp root is the fixture's hangar root, so %HANGAR% has already replaced it in place.
cp -R "$fixture/out/normalised" "$out/gated/fixture/normalised"

# --- 3. commands ---------------------------------------------------------------------------
capture() {
  where=$1
  name=$2
  shift 2
  if [ "$where" = advisory ]; then
    NO_COLOR=1 "$bin" "$@" 2>&1 | normalise | scrub > "$out/advisory/commands/$name.txt" || true
  else
    NO_COLOR=1 "$bin" "$@" 2>&1 | normalise > "$out/gated/commands/$name.txt" || true
  fi
}

capture gated ports ports --json
capture gated config-show config show
capture gated colours-sync-dry colours sync -n

capture advisory list list
capture advisory status status --all
capture advisory doctor doctor --all
capture advisory plans-collect-dry plans collect -n
capture advisory plans-stamp-dry plans stamp -n
capture advisory tmp-merge-dry tmp merge -n
capture advisory ide-vscode-sync-dry ide vscode sync -n

cat > "$out/README.md" <<'MD'
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
MD

echo "golden: wrote $out (gate: git diff --exit-code $out/gated)"
