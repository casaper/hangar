#!/usr/bin/env bash
# Compatibility shim. The Jira cache linker is now `hangar jira link`, which does the same
# thing but discovers the clones from the filesystem instead of a hardcoded list of three.
#
#   ./jira-cache-link.sh                 ->  hangar jira link
#   ./jira-cache-link.sh ABC-1337         ->  hangar jira link ABC-1337
#   ./jira-cache-link.sh --dry-run       ->  hangar jira link --dry-run
#
# Kept so muscle memory and any existing note still work. Safe to delete once nothing calls it.
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
echo "note: jira-cache-link.sh is now \`hangar jira link\` -- forwarding." >&2
exec "$here/bin/hangar" jira link "$@"
