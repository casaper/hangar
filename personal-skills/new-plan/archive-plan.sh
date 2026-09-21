#!/bin/sh
# archive-plan.sh -- move a session's live plan file aside, stamped with where it came from.
#
# Claude Code binds exactly ONE plan file to a session, for that session's whole life. Entering
# plan mode again re-announces the same path; nothing on disk records the binding (the session
# file next door carries sessionId, cwd and version and no plan field), so the name cannot be
# changed by editing state and a second plan file cannot be conjured. The only way to start a
# second plan without losing the first is to move the first one out from under the harness.
#
# That was already possible by hand, and the reason it was not good enough is the reason this
# script exists: a plan copied aside is an orphan. It carries a random slug for a name and
# nothing saying which conversation produced it, so a week later it is unreadable provenance-wise
# even though every word of it is intact. So the move is only half the job -- the header is the
# other half, and the two happen together or not at all.
#
#   usage:  archive-plan.sh <path-to-live-plan-file>
#   prints: the path it archived to
#
# The live file is TRUNCATED rather than deleted. The harness will write to that path again and
# an existing empty file is the least surprising thing for it to find.

set -eu

plan=${1:-}
[ -n "$plan" ] || { echo "archive-plan: usage: archive-plan.sh <path-to-live-plan-file>" >&2; exit 2; }
[ -f "$plan" ] || { echo "archive-plan: no such plan file: $plan" >&2; exit 2; }
[ -s "$plan" ] || { echo "archive-plan: plan file is empty; nothing to archive: $plan" >&2; exit 3; }

# "Nothing to archive" is not the same thing as "zero bytes". /new-plan writes the new plan's
# `# ` heading the moment it truncates the old one, so a plan that has been titled and not yet
# written to is a ONE-LINE file rather than an empty one -- and archiving that leaves an orphan
# named after a plan nobody wrote. Blank lines and the first heading do not count as content;
# a second heading, or any prose at all, does.
if [ -z "$(awk '
    /^[[:space:]]*$/ { next }
    !seen && /^#[[:space:]]*[^[:space:]]/ { seen = 1; next }
    { print }
' "$plan")" ]; then
    echo "archive-plan: plan file has nothing but its title; nothing to archive: $plan" >&2
    echo "archive-plan: to retitle this plan, edit its '# ' heading -- do not archive it." >&2
    exit 3
fi

# --- which session is this? -------------------------------------------------------------------
# Walk ppid from this shell up to the `claude` process that spawned it and read its session file.
# Exact, unlike matching on cwd -- two sessions in one directory are ordinary here.
sessions="$HOME/.claude/sessions"
pid=$$
session_file=''
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    if [ -f "$sessions/$pid.json" ]; then
        session_file="$sessions/$pid.json"
        break
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') || pid=''
done

field() { # <file> <key>
    sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1" | head -1
}

sid=''
scwd=''
if [ -n "$session_file" ]; then
    sid=$(field "$session_file" sessionId)
    scwd=$(field "$session_file" cwd)
fi

# The transcript is found by globbing for the id rather than by re-deriving the project directory
# slug: that slug rewrites `/`, `.` and `_`, and getting one of them wrong yields a path that
# simply does not exist -- a wrong answer that looks like a right one.
transcript=''
if [ -n "$sid" ]; then
    for f in "$HOME"/.claude/projects/*/"$sid".jsonl; do
        [ -f "$f" ] && { transcript=$f; break; }
    done
fi

# --- what is it called? -----------------------------------------------------------------------
# The plan's own `# ` heading, not the harness's random slug. A plan that never got one keeps the
# slug rather than being named something invented.
title=$(sed -n 's/^#[[:space:]]\{1,\}//p' "$plan" | head -1)
slug=$(printf '%s' "$title" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//' \
    | cut -c1-60 \
    | LC_ALL=C sed 's/-$//')
[ -n "$slug" ] || slug=$(basename "$plan" .md)

# The archive is DATED -- `2026-09-10_-_some-title.md`. The `_-_` is not decoration: it is the
# prefix `hangar plans collect` reads as "already stamped", so an archive it sweeps into the
# shared plan directory later keeps the name it was given here instead of being re-dated from a
# filesystem timestamp that an atomic rewrite has already moved.
dir=$(dirname "$plan")
stem="$(date +%Y-%m-%d)_-_$slug"
target="$dir/$stem.md"
n=2
while [ -e "$target" ] || [ "$target" = "$plan" ]; do
    target="$dir/$stem-$n.md"
    n=$((n + 1))
done

tilde() {
    case "$1" in
        "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
        *) printf '%s' "$1" ;;
    esac
}

# --- move and stamp, in one step ----------------------------------------------------------------
# Written to a temp file in the same directory and renamed, so a failure half way through leaves
# the live plan untouched rather than leaving an archive with no header.
tmp="$dir/.archive-plan.$$.tmp"
trap 'rm -f "$tmp"' EXIT INT TERM

{
    printf '<!-- archived by /new-plan  %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)"
    [ -n "$sid" ] && printf '     session:    %s\n' "$sid"
    [ -n "$transcript" ] && printf '     transcript: %s\n' "$(tilde "$transcript")"
    [ -n "$scwd" ] && printf '     cwd:        %s\n' "$scwd"
    printf '     was:        %s\n' "$(tilde "$plan")"
    if [ -n "$sid" ]; then
        printf '     resume:     claude --resume %s\n' "$sid"
    else
        printf '     resume:     unknown -- no session file found from this process tree\n'
    fi
    printf -- '-->\n\n'
    cat "$plan"
} > "$tmp"

mv "$tmp" "$target"
trap - EXIT INT TERM
: > "$plan"

printf '%s\n' "$target"
