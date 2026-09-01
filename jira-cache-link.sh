#!/usr/bin/env bash
# Compatibility shim. The Jira cache linker is now `orch-util jira link`, which does the same
# thing but discovers the clones from the filesystem instead of a hardcoded list of three.
#
#   ./jira-cache-link.sh                 ->  orch-util jira link
#   ./jira-cache-link.sh ABC-1337         ->  orch-util jira link ABC-1337
#   ./jira-cache-link.sh --dry-run       ->  orch-util jira link --dry-run
#
# Kept so muscle memory and any existing note still work. Safe to delete once nothing calls it.
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
echo "note: jira-cache-link.sh is now \`orch-util jira link\` -- forwarding." >&2
exec "$here/bin/orch-util" jira link "$@"
