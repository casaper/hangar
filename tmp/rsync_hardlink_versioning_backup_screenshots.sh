#!/usr/bin/env zsh
#
# Accumulating backup of the fleet's Playwright screenshots, with hard-linked history.
#
#   <hangar>/tmp/playwright_screenshots      SOURCE. Every clone's
#                                            tests/playwright-regression-tests/output/screenshots
#                                            is a symlink to this one directory, so any clone's
#                                            test run writes AND DELETES in here.
#   <hangar>/tmp/screenshots_union           THE DELIVERABLE. The newest content ever seen for
#                                            every path ever seen. Nothing is ever deleted from
#                                            it. This is what rclone uploads.
#   <hangar>/tmp/screenshots_versions/<UTC>  History: hard-linked snapshots of the union, taken
#                                            only when something changed. Only the files that
#                                            changed cost bytes.
#
# Usage:
#   rsync_hardlink_versioning_backup_screenshots.sh              ingest, snapshot, upload
#   rsync_hardlink_versioning_backup_screenshots.sh -n           preview: writes nothing
#   rsync_hardlink_versioning_backup_screenshots.sh --verify      report only: counts and linkage
#   rsync_hardlink_versioning_backup_screenshots.sh --no-upload   local half only
#   rsync_hardlink_versioning_backup_screenshots.sh -q            cron: only refusals and errors
#   rsync_hardlink_versioning_backup_screenshots.sh --relink      give existing snapshots their
#                                                                 hard links back (content kept)
#
#   SCREENSHOTS_KEEP=30   prune all but the newest 30 snapshots (default 0 = keep every one)
#   SCREENSHOTS_FORCE=1   ingest even while a suite looks like it is still writing
#
# ---------------------------------------------------------------------------------------------
# Why this shape, measured on this hangar rather than assumed:
#
# * NO `--delete` ON THE INGEST PASS. That flag is what the previous version got wrong: it made
#   the backup track deletions, so a screenshot a clone removed was removed here too. Measured
#   at the time of the rewrite: 8 files existed in the old mirror and no longer in the source,
#   i.e. the next run would have destroyed exactly the files this backup exists to keep.
#
# * THE UNION OWNS ITS OWN INODES -- never `--link-dest` against the SOURCE. Playwright rewrites
#   a screenshot in place, and 4404 of the 4442 source files were measured at nlink=2 (an earlier
#   experiment hard-linked them elsewhere), so anything sharing an inode with the source is a
#   backup that silently changes under you. The union costs its own ~1.1G and that is the point.
#
# * `--checksum` AND NO `-t` (hence -rlpgoD rather than -a). A test run rewrites files with fresh
#   mtimes but frequently identical bytes; --checksum is what stops those from being treated as
#   changes, and NOT preserving times is what stops rsync from "fixing up" the mtime of an
#   otherwise identical file -- which would report as a change, snapshot every run, and refill
#   the disk. Measured churn between two real states: 239 of 4442 files, so a snapshot costs
#   ~5% of the tree.
#
# * NEVER `--inplace`. rsync writes a temp file and renames it, which is the whole reason the
#   already-linked snapshots stay immutable when the union is updated.
#
# * A SNAPSHOT IS VERIFIED TO HAVE ACTUALLY LINKED, and a snapshot that did not is DELETED and
#   the run fails. Two full byte copies (~2.4G) were found sitting in screenshots_versions from
#   earlier runs, so this failure is real, it is silent, and a warning did not stop it twice.
#
# * File inspection uses zsh's zstat builtin, never `stat`: the hangar's .envrc puts GNU
#   coreutils ahead of the BSD tools, and `stat -f` means "format" to BSD and "filesystem" to
#   GNU, so an external stat breaks depending on which directory you launch from.
# ---------------------------------------------------------------------------------------------

emulate -L zsh
setopt err_exit no_unset pipe_fail
zmodload -F zsh/stat b:zstat

# cron hands a job PATH=/usr/bin:/bin. There is no rclone there at all, and /usr/bin/rsync is
# openrsync rather than the one this script is written against -- so a crontab line that looks
# right fails at the first command. Put the Homebrew prefix in front here rather than expecting
# every caller to remember it; the hangar's own .envrc resolves the prefix the same three ways.
typeset BREW=${HOMEBREW_PREFIX:-/opt/homebrew}
[[ -d $BREW/bin ]] && path=( $BREW/bin $path )

# ---- locate the hangar -----------------------------------------------------------------------
# ${0:A} resolves the symlink this file is when reached through a clone's tmp/, so every entry
# point lands on the same real script; then walk up to the marker that defines a hangar.
typeset SELF=${0:A}
typeset HANGAR=${SELF:h}
while [[ $HANGAR != / && ! -f $HANGAR/hangar.config.yaml ]]; do HANGAR=${HANGAR:h}; done
[[ -f $HANGAR/hangar.config.yaml ]] || {
  print -ru2 -- "refusing: no hangar.config.yaml above $SELF"; exit 1 }

typeset SCREENSHOTS=playwright_screenshots
typeset SOURCE="$HANGAR/tmp/$SCREENSHOTS"
typeset UNION="$HANGAR/tmp/screenshots_union"
typeset VERSIONS="$HANGAR/tmp/screenshots_versions"
typeset LEGACY_MIRROR="$HANGAR/tmp/screenshots_mirror"
typeset UPLOADED="$VERSIONS/.last_uploaded"
typeset LAST_RUN="$VERSIONS/.last_run"
typeset VANISHED_LOG="$VERSIONS/.vanished.log"
typeset VANISHED_NOW="$VERSIONS/.vanished"
typeset REMOTE="od_sharing:$SCREENSHOTS"
typeset LOCK="$HANGAR/tmp/.screenshots_backup.lock"

typeset mode=run upload=yes
integer quiet=0
set_mode() {
  [[ $mode == run ]] || { print -ru2 -- "one mode at a time: already running as --$mode"; exit 2 }
  mode=$1
}
while (( $# )); do
  case "$1" in
    -n|--dry-run)  set_mode dry ;;
    --verify)      set_mode verify ;;
    --relink)      set_mode relink ;;
    --no-upload)   upload=no ;;
    -q|--quiet)    quiet=1 ;;
    -h|--help)     sed -n '3,24p' "$SELF"; exit 0 ;;
    *) print -ru2 -- "usage: ${SELF:t} [-n|--dry-run] [--verify] [--relink] [--no-upload] [-q|--quiet]"; exit 2 ;;
  esac
  shift
done

[[ -d $SOURCE ]] || { print -ru2 -- "refusing: source not found: $SOURCE"; exit 1 }

say()  { (( quiet )) || print -- "$@" }
sayl() { (( quiet )) || print -rl -- "$@" }

# ---- counting helpers ------------------------------------------------------------------------
# One zstat per file, assigned into a variable rather than captured: a $(...) here would fork a
# subshell per file, which is the entire cost of the run at ~4.4k files per tree.
typeset -A _zh
files_in()   { local -a f; f=( ${1}/**/*(N.) ); print -r -- ${#f} }
unlinked_in() {  # files in $1 that share their inode with nothing -- i.e. a byte copy
  local -a f; local x n=0
  f=( ${1}/**/*(N.) )
  for x in $f; do zstat -H _zh -- "$x"; (( _zh[nlink] == 1 )) && (( ++n )); done
  print -r -- $n
}

# Two lists, deliberately. A snapshot counts as one of this history's when its name is the UTC
# form below, because that is what makes lexical order chronological order -- `snapshots[-1]` is
# then the current state, and "prune the oldest" has an answer. A hand-made snapshot joins the
# history simply by being named that way, and is then indistinguishable from a generated one:
# two of the directories here were made by hand with rsync and renamed from local time to UTC.
# Anything NOT named that way is reported by `--verify` and touched by nothing, because neither
# question above can be answered for a directory whose name was made on another clock.
unshared_bytes() {  # what deleting $1 would actually free: the blocks nothing else holds
  local -a f; local x; integer b=0
  f=( ${1}/**/*(N.) )
  for x in $f; do zstat -H _zh -- "$x"; (( _zh[nlink] == 1 )) && (( b += _zh[size] )); done
  print -r -- $b
}
human_bytes() {  # MB below a gigabyte: a relink of one snapshot is often tens of MB
  if (( ${1} >= 1073741824 )); then printf '%.2f GB' $(( ${1} / 1073741824.0 ))
  else printf '%.0f MB' $(( ${1} / 1048576.0 )); fi
}

typeset -a snapshots all_versions
all_versions=( $VERSIONS/*(/N) )
snapshots=( $VERSIONS/[0-9]*Z*(/N) )

# ---- --verify: report and change nothing -----------------------------------------------------
if [[ $mode == verify ]]; then
  printf '%-46s %-8s %s\n' TREE FILES 'UNSHARED (byte copies)'
  printf '%-46s %-8s %s\n' "${SOURCE:t}" "$(files_in $SOURCE)" '-'
  [[ -d $UNION ]] && printf '%-46s %-8s %s\n' "${UNION:t}" "$(files_in $UNION)" "$(unlinked_in $UNION)"
  typeset s mark
  for s in $all_versions; do
    mark=''
    (( ${snapshots[(Ie)$s]} )) || mark='   <- not this script'"'"'s: left alone'
    printf '%-46s %-8s %s%s\n' "versions/${s:t}" "$(files_in $s)" "$(unlinked_in $s)" "$mark"
  done
  print
  print -- "A snapshot with a non-zero unshared count is a full byte copy of the tree."
  [[ -f $VANISHED_LOG ]] && print -- "vanished-from-source log: $VANISHED_LOG ($(wc -l < $VANISHED_LOG | tr -d ' ') entries)"
  exit 0
fi

# ---- nothing to do at all? --------------------------------------------------------------------
# The ingest pass below reads ~1.1G on both sides, which is the price of --checksum being right.
# This is what keeps that off a 5-minute cron: one mtime scan of the source against the marker
# the last run left. Only a source somebody has actually written to costs anything.
if [[ $mode == run && -f $LAST_RUN ]]; then
  typeset -a touched
  # No -type f: a DELETION touches only the parent directory's mtime, and skipping the run then
  # would hide it from the vanished report until the next write. Measured in a fixture, where
  # removing one file left every file's mtime untouched.
  touched=( ${(f)"$(find "$SOURCE" -newer "$LAST_RUN" -print 2>/dev/null | head -1 || true)"} )
  if (( ${#touched} == 0 )); then
    (( quiet )) || print -- "no file touched since the last run -- nothing to do"
    exit 0
  fi
fi

# ---- one at a time ---------------------------------------------------------------------------
# Six clones write into one source directory, so two suites finishing together would otherwise
# run two ingests over one union. An atomic mkdir is the lock; a stale one is reported, not
# stolen, because the thing it would interrupt is a 1.1G rsync.
if [[ $mode == run ]]; then
  if ! mkdir -- "$LOCK" 2>/dev/null; then
    print -ru2 -- "another run holds $LOCK -- remove it if no backup is running"; exit 1
  fi
  trap 'rmdir -- "$LOCK" 2>/dev/null' EXIT INT TERM
fi

# ---- migrate the old mirror ------------------------------------------------------------------
# A rename keeps every inode, so the snapshots already hard-linked to the mirror go on sharing
# with the union. Nothing is copied and nothing is lost.
if [[ ! -d $UNION && -d $LEGACY_MIRROR ]]; then
  say "migrating ${LEGACY_MIRROR:t} -> ${UNION:t} (rename: inodes and existing snapshot links kept)"
  [[ $mode == dry ]] || mv -- "$LEGACY_MIRROR" "$UNION"
fi
[[ $mode == dry ]] || mkdir -p -- "$UNION" "$VERSIONS"

# In a dry run the migration above did not happen, so compare against the tree that WOULD become
# the union -- otherwise -n reports all 4442 files as new, which is the one thing a preview of an
# accumulating backup must not do.
typeset TARGET=$UNION
[[ $mode == dry && ! -d $UNION && -d $LEGACY_MIRROR ]] && TARGET=$LEGACY_MIRROR

# ---- --relink: give an existing snapshot its hard links back ---------------------------------
# A snapshot made by hand with `rsync -a --link-dest=...` is a FULL BYTE COPY, and that is not a
# mistake anybody can see: measured in a fixture, `-a --checksum --link-dest` linked 0 of 3
# identical files while `-rlpgoD --checksum --link-dest` linked 2 of 3. The reason is that -a
# implies -t, a hard link shares one inode and therefore one mtime, and a tree copied straight
# from the source carries the source's mtimes while the union carries its ingest times -- so
# rsync cannot both preserve the time and share the inode, and it chooses to copy. Dropping -t
# is what lets it link.
#
# What it does NOT preserve, and cannot: a linked file's mtime. One inode carries one mtime, so
# a file shared with the union necessarily carries the union's ingest time. Content is identical
# -- verified by checksum before the original is removed -- and the files that stay copies, which
# are the genuinely older versions, keep their own mtime.
#
# This rebuilds each snapshot against the union and the other snapshots, keeping every byte:
# identical files become links, genuinely older versions are copied and then have their original
# mtime restored (safe only because those are the files sharing no inode). The rebuild is
# checksum-verified against the original before anything is removed.
if [[ $mode == relink ]]; then
  (( ${#snapshots} )) || { print -ru2 -- "no snapshots to relink"; exit 1 }
  integer total_before=0 total_after=0
  typeset snap='' tmp='' other='' x='' rel='' diff=''
  typeset -a dests copied
  for snap in $snapshots; do
    integer before=$(unshared_bytes "$snap")
    total_before=$(( total_before + before ))   # NOT (( x += y )): that exits 1 when the sum is 0
    if (( before == 0 )); then
      say "${snap:t}: already fully linked"
      continue
    fi

    dests=( --link-dest="$UNION" )
    for other in $snapshots; do
      [[ $other == $snap ]] && continue
      (( ${#dests} >= 19 )) && break        # rsync takes at most 20 --link-dest options
      dests+=( --link-dest="$other" )
    done

    say "${snap:t}: $(human_bytes $before) unshared -- rebuilding against the union and ${#dests} tree(s)"

    tmp="$VERSIONS/.relink.$$.${snap:t}"
    rm -rf -- "$tmp"
    # No -t: that is the whole point. See the note above.
    rsync -rlpgoD --checksum "${dests[@]}" -- "$snap/" "$tmp"

    # Restore the original mtime of every file that had to be copied. Only those: a `touch` on a
    # linked file would move the mtime of the union's copy and of every snapshot sharing it.
    copied=()
    for x in ${tmp}/**/*(N.); do
      zstat -H _zh -- "$x"
      (( _zh[nlink] == 1 )) && copied+=( "$x" )
    done
    for x in $copied; do
      rel=${x#$tmp/}
      [[ -f "$snap/$rel" ]] && touch -r "$snap/$rel" "$x"
    done

    # Verified before anything is destroyed: same file count, and no content difference at all.
    integer old_n=$(files_in "$snap") new_n=$(files_in "$tmp")
    diff=$( rsync -rn --checksum --itemize-changes -- "$snap/" "$tmp/" 2>/dev/null | grep -c '^[<>ch]f' || true )
    if (( old_n != new_n )) || (( diff != 0 )); then
      print -ru2 -- "FAILED: rebuild of ${snap:t} does not match ($old_n vs $new_n files, $diff content difference(s))"
      print -ru2 -- "the original is untouched; the rebuild is at $tmp"
      exit 1
    fi

    rm -rf -- "$snap"
    mv -- "$tmp" "$snap"
    integer after=$(unshared_bytes "$snap")
    total_after=$(( total_after + after ))
    say "${snap:t}: now $(human_bytes $after) unshared (${#copied} file(s) are genuinely older versions)"
  done
  say "reclaimed $(human_bytes $(( total_before - total_after )) )"
  exit 0
fi

# ---- refuse to ingest a suite that is still writing ------------------------------------------
# An ingest during a live run can pick up a half-written PNG. The union heals on the next run;
# a snapshot taken from it does not.
typeset -a hot
hot=( ${(f)"$(find "$SOURCE" -type f -mmin -1 -print 2>/dev/null | head -3 || true)"} )
if (( ${#hot} )) && [[ -z ${SCREENSHOTS_FORCE:-} ]]; then
  print -ru2 -- "refusing: files under $SCREENSHOTS were written in the last minute -- a suite looks live:"
  print -rl -u2 -- ${hot/#$SOURCE\//  }
  print -ru2 -- "wait for it to finish, or set SCREENSHOTS_FORCE=1"
  exit 1
fi

# ---- 1. ingest: accumulate, never delete -----------------------------------------------------
typeset -a rsync_ingest
rsync_ingest=( rsync -rlpgoD --checksum --itemize-changes )
[[ $mode == dry ]] && rsync_ingest+=( --dry-run )
typeset changes
changes=$( "${rsync_ingest[@]}" -- "$SOURCE/" "$TARGET/" )

# Only FILE transfers count as a change. rsync itemises a directory it created or whose
# attributes it touched as `cd...`, and a snapshot taken for that would hold nothing new -- the
# false positive that makes a change detector worthless.
typeset -a all_lines change_lines
all_lines=( ${(f)changes} )
change_lines=( ${(M)all_lines:#[<>ch]f*} )

# ---- 2. what the source no longer has --------------------------------------------------------
# The union keeps these for ever, which is the requirement; this pass only makes them visible.
# A dry run WITH --delete lists them without acting: rsync only prints what it would remove.
typeset vanished
vanished=$( rsync -rn --delete --itemize-changes -- "$SOURCE/" "$TARGET/" 2>/dev/null | grep '^\*deleting' || true )
typeset -a vanished_lines
vanished_lines=( ${(f)vanished} )
vanished_lines=( ${vanished_lines:#} )
if (( ${#vanished_lines} )); then
  say "kept ${#vanished_lines} file(s) the source no longer has (that is the point):"
  sayl ${${vanished_lines[1,5]}/#\*deleting   /  }
  if [[ $mode == run ]]; then
    typeset current=${(F)${vanished_lines/#\*deleting   /}}
    if [[ ! -f $VANISHED_NOW || "$(<$VANISHED_NOW)" != "$current" ]]; then
      { print -r -- "# $(date -u +%Y-%m-%dT%H:%M:%SZ)"; print -r -- "$current" } >> "$VANISHED_LOG"
      print -r -- "$current" > "$VANISHED_NOW"
    fi
  fi
fi

# ---- 3. snapshot, only on a real change ------------------------------------------------------
typeset snapshot_name=''
if (( ${#change_lines} == 0 )) && (( ${#snapshots} )); then
  snapshot_name=${snapshots[-1]:t}
  say "no change since $snapshot_name -- no new snapshot"
elif (( ${#change_lines} == 0 )); then
  say "no change, and no snapshot yet -- taking the first one"
fi

if [[ -z $snapshot_name ]]; then
  say "${#change_lines} change(s) ingested:"
  sayl ${change_lines[1,10]}
  (( ${#change_lines} > 10 )) && say "  ... and $(( ${#change_lines} - 10 )) more"

  snapshot_name=$(date -u +%Y-%m-%dT%H_%M_%SZ)
  integer n=1
  while [[ -e "$VERSIONS/$snapshot_name" ]]; do   # two runs inside one second
    snapshot_name="$(date -u +%Y-%m-%dT%H_%M_%SZ)_$(( n++ ))"
  done

  if [[ $mode == dry ]]; then
    print -- "would snapshot the union to versions/$snapshot_name (hard links)"
  else
    # --link-dest MUST be absolute: a relative path resolves against the DESTINATION, and rsync
    # then silently copies the bytes instead of linking them.
    rsync -a --link-dest="$UNION" -- "$UNION/" "$VERSIONS/$snapshot_name"

    # Verified, not assumed. A snapshot whose files share no inode is a full copy of the tree,
    # which is how ~2.4G of dead weight accumulated before this check existed.
    typeset -i unshared=$(unlinked_in "$VERSIONS/$snapshot_name")
    if (( unshared > 0 )); then
      print -ru2 -- "FAILED: $unshared file(s) in versions/$snapshot_name are byte copies, not hard links"
      print -ru2 -- "removing the snapshot rather than leaving $(du -sh -- "$VERSIONS/$snapshot_name" | cut -f1) of dead weight"
      rm -rf -- "$VERSIONS/$snapshot_name"
      exit 1
    fi
    say "snapshot: versions/$snapshot_name ($(files_in "$VERSIONS/$snapshot_name") files, all hard-linked)"
    snapshots+=( "$VERSIONS/$snapshot_name" )
  fi
fi

# ---- 4. retention, opt-in --------------------------------------------------------------------
integer keep=${SCREENSHOTS_KEEP:-0}
if (( keep > 0 && ${#snapshots} > keep )); then
  typeset s
  for s in ${snapshots[1,$(( ${#snapshots} - keep ))]}; do
    say "pruning versions/${s:t}"
    [[ $mode == dry ]] || rm -rf -- "$s"
  done
fi

# ---- 5. upload the union, never the source ---------------------------------------------------
# The union is the tree with every file in it; the source is missing whatever the last test run
# deleted. `copy` rather than `sync` so the remote never deletes either. Default size+modtime
# comparison is enough here BECAUSE the union is only written when content actually changed --
# there is no mtime churn in it to defeat, so --checksum would re-hash 1.1G for nothing.
if [[ $upload == no ]]; then
  say "--no-upload: skipping $REMOTE"
elif [[ $mode == dry ]]; then
  print -- "would upload ${UNION:t} -> $REMOTE"
elif [[ -f $UPLOADED ]] && [[ "$(<$UPLOADED)" == $snapshot_name ]]; then
  say "remote already holds $snapshot_name"
else
  typeset -a rclone_opts
  rclone_opts=( copy )
  if [[ -t 1 ]]; then rclone_opts+=( --progress ); else rclone_opts+=( --stats 0 ); fi
  rclone "${rclone_opts[@]}" -- "$UNION/" "$REMOTE/"
  print -r -- "$snapshot_name" > "$UPLOADED"
  say "uploaded $snapshot_name -> $REMOTE"
fi

# ---- 6. remember when we last looked ---------------------------------------------------------
# Stamped even when the ingest found no content change: the mtime churn of a test run is exactly
# what the fast skip above must not keep re-examining.
[[ $mode == run ]] && touch -- "$LAST_RUN"
exit 0
