#!/usr/bin/env bash
# Share the per-ticket Jira cache across the three clones of the dvb_gn fleet.
#
# The repo's own `.claude/skills/jira-scope/jira-cache.mjs` hardcodes its cache at
# `<git toplevel>/tmp/<KEY>/` and offers no configuration. It only ever does
# `mkdirSync(..., {recursive:true})` on that path, which follows a symlink -- so
# replacing `tmp/<KEY>` with a symlink into a shared store makes every clone read and
# write the same ticket cache, with NO change to the tracked tooling.
#
# `tmp/` ITSELF IS NEVER SHARED, deliberately. It also holds the dev-server PID files
# (`tmp/ng_serve.pid`, `tmp/storybook.pid`), and `dev/run-with-pid.mjs` refuses to start
# a name that is already live. A shared `tmp/` would let only one clone run a dev server
# at a time and would let `pids.mjs --kill` reach into another clone. Only the per-ticket
# `tmp/<KEY>` directories are linked.
#
# What is shared, and the one caveat:
#   ticket_<KEY>.md, relation variants, Jira attachments -- clone- and branch-independent.
#                                                           This is the point of sharing.
#   plan_<KEY>.md            -- a hard link to the plan file; plans are already shared.
#   pr_description_<KEY>.md  -- derived from the WORKING-TREE DIFF, so it is genuinely
#                               per-clone. Sharing the directory shares this too:
#                               last-writer-wins if two clones work one ticket at once.
#
# Usage:
#   ./jira-cache-link.sh                 adopt + link every ticket dir found anywhere
#   ./jira-cache-link.sh ABC-1337 ABC-1400 ensure just these keys are linked in all clones
#   ./jira-cache-link.sh --dry-run [...]  show what would happen, change nothing
#
# Idempotent: safe to re-run. Never deletes a differing file -- a conflicting copy is
# kept beside the winner as `<name>.from-<clone>` and reported.
set -uo pipefail
shopt -s nullglob

STORE="${DVB_JIRA_CACHE:-$HOME/.claude/dvb-gn-jira}"
FLEET="${DVB_FLEET_ROOT:-$HOME/code/dvb_gn}"
CLONES=(clone_01 clone_02 clone_03)
KEY_RE='^[A-Z][A-Z0-9]+-[0-9]+$'

DRY=0
KEYS=()
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY=1 ;;
        -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)
            if [[ "$arg" =~ $KEY_RE ]]; then KEYS+=("$arg")
            else echo "not an issue key: $arg" >&2; exit 1; fi ;;
    esac
done

run() { if [ "$DRY" = 1 ]; then echo "      would: $*"; else "$@"; fi; }
conflicts=0

# No keys given: every key already in the store, plus every real ticket dir in any clone.
if [ ${#KEYS[@]} -eq 0 ]; then
    for p in "$STORE"/*; do [ -d "$p" ] && KEYS+=("$(basename "$p")"); done
    for c in "${CLONES[@]}"; do
        for p in "$FLEET/$c/tmp"/*; do
            b="$(basename "$p")"
            [ -d "$p" ] && [[ "$b" =~ $KEY_RE ]] && KEYS+=("$b")
        done
    done
    # dedupe
    if [ ${#KEYS[@]} -gt 0 ]; then
        mapfile -t KEYS < <(printf '%s\n' "${KEYS[@]}" | sort -u)
    fi
fi

if [ ${#KEYS[@]} -eq 0 ]; then echo "No ticket dirs found and none given. Nothing to do."; exit 0; fi

[ "$DRY" = 1 ] || mkdir -p "$STORE"
echo "store: $STORE"
echo "keys:  ${KEYS[*]}"

for key in "${KEYS[@]}"; do
    echo
    echo "== $key"
    [ "$DRY" = 1 ] || mkdir -p "$STORE/$key"

    for c in "${CLONES[@]}"; do
        tmp="$FLEET/$c/tmp"
        dir="$tmp/$key"
        [ "$DRY" = 1 ] || mkdir -p "$tmp"

        if [ -L "$dir" ]; then
            target="$(readlink "$dir")"
            if [ "$target" = "$STORE/$key" ]; then
                echo "   $c: already linked"
            else
                echo "   $c: WARNING symlink points elsewhere ($target) -- left untouched"
            fi
            continue
        fi

        if [ -d "$dir" ]; then
            echo "   $c: adopting real dir"
            for f in "$dir"/*; do
                n="$(basename "$f")"
                if [ ! -e "$STORE/$key/$n" ]; then
                    echo "      move $n -> store"
                    run mv "$f" "$STORE/$key/$n"
                elif cmp -s "$f" "$STORE/$key/$n"; then
                    echo "      $n identical to store -- dropping the clone copy"
                    run rm -f "$f"
                else
                    echo "      CONFLICT $n differs from store -- keeping store, saving clone copy as $n.from-$c"
                    conflicts=$((conflicts + 1))
                    run mv "$f" "$STORE/$key/$n.from-$c"
                fi
            done
            run rmdir "$dir"
        fi

        if [ ! -e "$dir" ]; then
            echo "   $c: linking"
            run ln -s "$STORE/$key" "$dir"
        fi
    done
done

echo
if [ "$conflicts" -gt 0 ]; then
    echo "$conflicts conflicting file(s) preserved as *.from-clone_0X in the store -- review and delete the loser."
else
    echo "No conflicts."
fi
[ "$DRY" = 1 ] && echo "(dry run -- nothing changed)"
exit 0
