#!/bin/sh
# Capture this hangar's golden output. Run from `app/`: `pnpm golden`.
#
# Two captures, and the distinction between them is the whole design:
#
#   GATED    -- derived from a CHECKED-IN fixture config and a synthesised clone index, in a
#               temp directory, with %HANGAR%/%HOME% normalised away. Byte-stable across days
#               AND identical in every clone of this repo on every machine, so
#               `git diff --exit-code dev/golden/gated` is a real gate for everyone rather than
#               for whoever recorded it.
#   ADVISORY -- everything else, for either of two reasons. It MOVES (a branch, a last commit,
#               how many entries the shared tmp/ holds) -- `hangar list` changed twice in the
#               hour this net was written, and a check that is red in normal operation is a
#               check nobody reads. Or it is stable but NOT PORTABLE: this hangar's own artifact
#               tree and the four commands that read this config and these clones. Useful to
#               eyeball, never a gate.
#
# The fixture trees are the real net. Most COMMANDS turn out to be advisory, which is worth
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
# ADVISORY, and the reason is portability rather than instability: this capture is byte-stable,
# but every byte of it describes THIS hangar's config, this machine's home directory and these
# clones. Gating on it made the first `pnpm golden` in anyone else's clone of this repo a
# 116-file diff that looks like a broken tool. The shapes it uniquely covered moved into
# `dev/fixture-vscode.config.yaml`; what stays here is a useful thing to eyeball, not a gate.
"$bin" dev golden --out "$out/advisory/hangar" >/dev/null

# --- 2. the hostile fixtures ---------------------------------------------------------------
# Each is copied into its own temp directory under the name `hangar.config.yaml`, because a file
# by that name inside this repo would be a nested hangar marker. Only the NORMALISED tree is
# kept: the verbatim one names a temp directory that differs on every run.
#
# `pwd -P` matters: on macOS `mktemp -d` hands back a /var path while the working directory
# resolves to /private/var, so HANGAR_ROOT and the upward walk would name the same directory
# two different ways and the manifest would read `/private%HANGAR%`.
#
# TWO of them, and the second is not a variant. A fixture that disagrees with the schema
# defaults proves the config file was read; two fixtures that also disagree with EACH OTHER are
# what no single swallowed error can satisfy. `dev/fixture-vscode.config.yaml`'s header lists
# the seven shapes it is the only capture of -- the ones the maintainer's own hangar used to be
# the only capture of, back when that capture was gated.
fixture_dirs=''
trap 'rm -rf $fixture_dirs' EXIT INT TERM

run_fixture() {
  # $1 config file under dev/, $2 name under gated/
  dir="$(cd "$(mktemp -d)" && pwd -P)"
  fixture_dirs="$fixture_dirs $dir"
  cp "dev/$1" "$dir/hangar.config.yaml"
  (cd "$dir" && HANGAR_ROOT="$dir" "$bin" dev golden --out "$dir/out" --indices 1,2,3) >/dev/null
  mkdir -p "$out/gated/$2"
  # The temp root IS that fixture's hangar root, so %HANGAR% has already replaced it in place.
  cp -R "$dir/out/normalised" "$out/gated/$2/normalised"
}

run_fixture fixture.config.yaml fixture
run_fixture fixture-vscode.config.yaml fixture-vscode

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

# These four are byte-stable and still ADVISORY, which is the second reason a capture lands
# there: they read THIS hangar's config and clone list, so their content is this machine's. The
# `config validate` one is the case worth stating, because it is the most valuable of the four
# and could not be recaptured against a fixture without losing what makes it valuable: its job
# is to notice that the COMMITTED `hangar.config.example.yaml` drifted from the gitignored live
# file, and a fixture in a temp directory has no committed example to compare against. A gate
# built on it there would be strictly weaker while reading as though it were the same check.
capture advisory ports ports --json
capture advisory config-show config show
capture advisory config-validate config validate
capture advisory colours-sync-dry colours sync -n

# --- 3b. `setup -n` in an EMPTY directory ---------------------------------------------------
# The one command whose whole job is a repo this hangar is not, so it is captured against a
# fresh temp directory rather than against this hangar. Two reasons, and the second matters:
#
#   * With no clones there is nothing to derive from, which is exactly what a colleague's first
#     run looks like -- and the path that used to emit `envrcDirs: ['.', '', 'tests/...']` and
#     then reject its own file. Byte-stable for the same reason: no disk state to read.
#   * `setup` needs `--force` to render over an existing config, and pointing that at THIS
#     hangar on every `pnpm golden` run would put the live gitignored config one `-n` regression
#     away from being overwritten by the regression net itself.
#
# One capture per preset, because a preset is the only thing that varies the roles and the
# per-clone variables, and the schema rejects role bases that would collide -- a preset shipping
# that is a config nobody can load, and this is where it shows.
setupdir="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf $fixture_dirs "$setupdir"' EXIT INT TERM
for preset in generic node-web sql-postgrest; do
  # `--id` is what makes this byte-stable: without it the id is derived from the directory
  # basename, which `mktemp -d` randomises, and the capture changed on every regeneration.
  NO_COLOR=1 "$bin" setup --yes --force -n --id goldensetup \
    --origin 'git@bitbucket.org:acme/warehouse_sql.git' --preset "$preset" \
    --hangar "$setupdir" 2>&1 |
    sed -e "s|$setupdir|%SETUP%|g" | normalise > "$out/gated/commands/setup-dry-$preset.txt" || true
done

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
MD

echo "golden: wrote $out (gate: git diff --exit-code $out/gated)"
