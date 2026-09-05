#!/bin/sh
# gitleaks over the whole history, from wherever it is invoked.
#
# A script rather than a one-line package.json entry, for the reason `golden.sh` and
# `changelog.sh` are: it has to mean the same thing everywhere. `pnpm scan:secrets` runs from
# `app/`, the pre-commit hook and CI run from the git root, and gitleaks resolves BOTH its scan
# target and its `.gitleaks.toml` relative to the working directory -- so left implicit, the same
# command would silently scan a subdirectory with the DEFAULT rule set and report "no leaks found".
#
# What this does not cover is measured, not assumed: see the header of `.gitleaks.toml` and
# `dev/scrub-check.sh`, which carries the password shape gitleaks provably misses.
set -eu

root="$(git rev-parse --show-toplevel)"

command -v gitleaks >/dev/null 2>&1 || {
  echo "hangar: gitleaks not installed -- \`brew install gitleaks\`" >&2
  exit 1
}

exec gitleaks git "$root" \
  --config "$root/.gitleaks.toml" \
  --log-opts=--all \
  --no-banner \
  --redact
