#!/bin/sh
# Repo hygiene: no organisation identifier, no machine path, no pasted password.
#
# Deliberately NOT a `node:test` case. `app/CLAUDE.md` scopes `pnpm test` to the pure core against
# a SYNTHETIC root -- `test/fixture.ts` exists so that no assertion can read this machine -- and
# this check has the opposite job: it reads the live tracked tree and nothing else.
#
# It complements `pnpm scan:secrets` rather than duplicating it. gitleaks was measured here against
# a canary of seven planted credentials: it caught the Atlassian token, an `ATBB` Bitbucket token,
# an AWS key id, a GitHub PAT and a quoted `db_password`, and MISSED both plain
# `USER_READWRITE_PASSWORD=<human-chosen value>` lines, because low entropy defeats its
# `generic-api-key` rule. That is one of this hangar's four real credentials and the exact shape a
# person pastes, so the password pattern below is the half gitleaks provably does not cover.
#
# `git grep` searches TRACKED files, so an untracked scratch file is not a failure.
set -eu
set -f  # no globbing: these patterns and their hits are full of `*` and `[`

cd "$(git rev-parse --show-toplevel)"

status=0
report() {
  printf '\n%s\n' "$1"
  printf '%s\n' "$2" | sed 's/^/  /'
  status=1
}

# Two exclusions, both structural.
#
# `app/pnpm-lock.yaml` is base64 integrity hashes, one of which contains `DVB`; nothing in it is
# prose. This script is the file that DEFINES the forbidden patterns, so it necessarily contains
# every one of them -- it flagged itself on the commit that introduced it. gitleaks still scans
# it, so a credential pasted in here is not invisible; only this check's own patterns are.
SKIP1=':(exclude)app/pnpm-lock.yaml'
SKIP2=':(exclude)app/dev/scrub-check.sh'

# --------------------------------------------------------------------------------------------
# Organisation and project identifiers.
#
# The hangar id `dvb_gn` is deliberately absent: it is an opaque slug naming no organisation, and
# it is load-bearing in the `~/.claude/<id>-*` artifact names and the `hangar_dvb_gn_colour` shell
# function. Everything below names a real company, repository, ticket or person.
# --------------------------------------------------------------------------------------------
# Each alternative is written so it does not MATCH ITSELF as a literal string. The single-
# character classes are semantically identical, cost nothing, and are what stops a bulk
# find-and-replace over the tree from rewriting this line and leaving a gate that detects nothing
# while still exiting 0.
IDENTIFIERS='datav[a]ult|dvb[-_]gui|gui[-_]next|__D[V]B_|DN-[0-9]'

hits=$(git grep -n -I -E "$IDENTIFIERS" -- . "$SKIP1" "$SKIP2" || true)
[ -z "$hits" ] || report 'organisation, project or ticket identifiers in tracked files:' "$hits"

# --------------------------------------------------------------------------------------------
# One machine's home directory. `$HOME`, `~` and the documented placeholders are the right forms.
# --------------------------------------------------------------------------------------------
HOMEPATHS='/(Users|home)/[a-z][a-z0-9_-]*/'
ALLOW_HOME='/(Users|home)/(someone|you|me|user|USERNAME)/'

homes=$(git grep -n -I -E "$HOMEPATHS" -- . "$SKIP1" "$SKIP2" | grep -Ev "$ALLOW_HOME" || true)
[ -z "$homes" ] || report "one machine's home directory in tracked files:" "$homes"

# --------------------------------------------------------------------------------------------
# A password with a LITERAL value, which is the shape gitleaks misses.
#
# The value must look like a value: at least six characters of the alphabet a pasted credential
# is drawn from. That excludes every legitimate form, each of which appears in this repo --
# `=$SOMETHING` (a reference), `=` (deliberately empty, which is what the Playwright symlink
# exists to override), `=""`, and `=<a placeholder>` in prose describing this very check. An
# optional opening quote is allowed, so `PASSWORD="hunter2"` is still caught.
#
# Uppercase only. `db_password = "..."` is lowercase and gitleaks DOES catch that one; widening
# this to match it too would flag every `password` in prose and teach people to ignore the gate.
# --------------------------------------------------------------------------------------------
PASSWORDS='[A-Z_]*(PASSWORD|PASSWD|SECRET)[A-Z_]*=["'"'"']?[A-Za-z0-9._/+-]{6,}'

pw=$(git grep -n -I -E "$PASSWORDS" -- . "$SKIP1" "$SKIP2" || true)
[ -z "$pw" ] || report 'a password or secret with a literal value:' "$pw"

# --------------------------------------------------------------------------------------------
# The hangar root's package.json stays SCRIPTS-ONLY.
#
# That file is an ancestor of every clone, and a clone root has no package.json of its own -- so
# whatever is declared here is what Node reads for every clone file outside the app subdirectory.
# `"type": "module"` at this level has already flipped `clone_NN/.claude/hooks/*.js` to ESM and
# killed every one of them at session start; a dependency here would put a `node_modules` above
# every clone, so a require that should fail loudly would instead resolve into the fleet's tree.
#
# This is the check because the obvious guard does not work: a `preinstall` script that exits 1
# was tried and MEASURED, and pnpm 10 does not run it -- not even when there is a dependency to
# install (probed with one, `pnpm run preinstall` fires, `pnpm install` does not). npm skipped it
# too. So an empty `node_modules` can still appear here; what must never happen is this file
# growing something to put in it.
# --------------------------------------------------------------------------------------------
if [ -f package.json ]; then
  pkg=$(grep -n -E '"(dependencies|devDependencies|type|workspaces|packageManager)"[[:space:]]*:' package.json || true)
  [ -z "$pkg" ] || report 'the hangar root package.json must declare scripts and nothing else:' "$pkg"
fi

if [ "$status" -eq 0 ]; then
  echo 'scan:literals ok -- no identifier, machine path or pasted password in the tracked tree'
fi
exit "$status"
