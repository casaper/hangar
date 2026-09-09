import type { Hangar } from '../hangar.ts';
import { CI_COLOURS } from '../palette.ts';
import { prCacheTtlSeconds } from '../pr-cache.ts';
import { type Artifact, artifactHeader } from './index.ts';

/**
 * `clone-tmux-status.sh` -- the facts the clone bar shows that tmux cannot answer itself.
 *
 * `generate/tmux-conf.ts`'s `barOptions` puts three `#(…)` jobs on the bar: the ticket key and
 * the pull request number in `status-right`, and the whole footer on the pane border. Each one is
 * a call to this script with a field name and the clone's name, and the clone comes from the
 * session's `@hangar_clone` tag rather than from a pane's working directory -- see `barOptions`
 * for why that is a correctness property and not a preference.
 *
 * ## Why a generated shell script and not the CLI
 *
 * tmux re-runs every job on the bar at `status-interval`, per attached client -- the pane border
 * included, at exactly the same cadence as the status line (measured on 3.7c: 19 border
 * expansions against 19 status expansions over 25 seconds with one attached client, which is
 * what makes a git-status glyph on the border worth drawing at all). Measured on this machine:
 * `bin/hangar --version` costs 0.24-0.28s, and shell plus git costs 0.02-0.14s. A CLI in that
 * loop would be a quarter of a second of Node startup several times a minute for every open
 * clone, to print a dozen characters. So the refresh is shell, and the one thing that DOES call
 * `hangar` is the click (`hangar browse`), which happens when a human decides it does.
 *
 * Generated rather than tracked, for the same reason `clone-colours.sh` is: it carries this
 * hangar's root, its tracker's key shapes and its default branch. Self-contained in the same
 * spirit as `~/.claude/<id>-clone-statusline.sh` -- every failure is `exit 0` with nothing
 * printed, because the alternative on a status bar is an error message redrawn every ten seconds
 * in a place nothing can be dismissed from.
 *
 * ## `--no-optional-locks`, and what the footer costs
 *
 * The footer's whole git half is ONE `git status --porcelain=v1 -b`: the branch, the ahead and
 * behind counts and every file state come out of the same walk, so four facts cost one process.
 * Measured in a real clone of this fleet's repo: 0.14s, against 0.045s for the `symbolic-ref`
 * the ticket and pull request fields still use.
 *
 * `--no-optional-locks` is not a micro-optimisation. Plain `git status` refreshes the index and
 * takes `index.lock` to write it back, so a status line firing every ten seconds in every
 * attached pane would contend with whatever the developer -- or an agent -- is running in that
 * same clone. The flag exists for exactly this caller and turns the walk read-only.
 *
 * ## The state is GLYPHS, never colour
 *
 * The footer is drawn as `colour.ink` on the clone's hue, and ink is pure black or pure white,
 * so `palette.ts`'s proof that it clears 4.58:1 on any hue covers every character on the line.
 * Colouring the git state would throw that away: a red mark on the red clone is invisible, and
 * nothing in a review catches it because it is only wrong for one clone out of sixteen. So each
 * state gets a glyph instead, and the whole footer inherits the contrast proof.
 *
 * ## The key pattern is DERIVED from `tracker.keyPrefixes`, and is an approximation
 *
 * `jira.ts` is the authority on what an issue key is, and this is a second reader of the same
 * config rather than a second definition: the prefixes come from `keyPrefixes`, so adding one to
 * the config reaches both. What shell cannot reproduce is `KEY_IN_TEXT_RE`'s lookarounds -- there
 * is no lookahead in `grep -E` -- so the tokenising `tr` plus a `^`-anchored match stands in for
 * them. It agrees with `jira.ts` on every branch name this fleet produces and differs only where
 * a digit run is followed immediately by a letter (`ABC-13231x`), which no branch here is.
 *
 * **With no configured prefixes there is no ticket field at all**, and that is deliberate rather
 * than unfinished. `jira.ts`'s untargeted matcher leans on a sixteen-entry denylist of key-shaped
 * things that are not keys (`UTF-8`, `SHA-256`), and its own comment says why: a confident link
 * to a ticket that does not exist is worse than saying nothing. Reimplementing that list in shell
 * is exactly the duplicate this file exists to avoid, so the bar stays quiet instead.
 */

/**
 * `^(DN|UI)-[0-9]+`, or `''` when this hangar has no tracker to link to.
 *
 * Anchored, because the match runs against tokens rather than against the whole branch: without
 * the `^`, `XABC-1323` would report `ABC-1323`.
 */
export const issueKeyPattern = (hangar: Hangar): string => {
  const tracker = hangar.config.tracker;
  const prefixes = tracker.kind === 'none' ? [] : (tracker.keyPrefixes ?? []);
  if (prefixes.length === 0) return '';
  return `^(${prefixes.join('|')})-[0-9]+`;
};

/**
 * How much branch the footer will carry.
 *
 * Measured against this fleet's own branch names: `fixes/ABC-1323_i_can_close_the_browser_tab_even_changes_not_saved`
 * is 58 columns, and every one of them is worth reading. So this is not a fit-the-terminal number
 * -- tmux truncates the border text on a narrow window by itself -- it is a cap that stops a
 * pathological branch name from being the whole line.
 */
const BRANCH_MAX = 72;

/**
 * How much of the working directory the footer will carry.
 *
 * The branch is the fact worth the width, so the path yields to it: a deep path is shown from its
 * END, since the leaf directory is what says where you are and the first segments are the ones
 * the clone name has already implied.
 */
const PATH_MAX = 36;

/**
 * The glyphs, and what each one means. Ink on the hue, never colour -- see the header.
 *
 * `✔` is the only one that appears alone: it means there is nothing else to say, so a clean tree
 * reads as one character rather than as an empty gap that could equally be a broken script.
 */
const GLYPHS = {
  clean: '✔',
  staged: '✚',
  modified: '✱',
  untracked: '?',
  conflict: '‼',
  inProgress: '⚑',
  ahead: '⇡',
  behind: '⇣',
} as const;

/**
 * The pull request's three axes, one glyph each. Kept beside `GLYPHS` and separate from it,
 * because the two live on different lines of the bar under opposite rules -- see below.
 *
 * A merged or declined pull request shows its glyph and its number and NOTHING else: the build
 * and the reviews are settled, and a green tick beside a merged PR is a fact nobody is deciding
 * anything on. `open` is the only state where the other two axes are still live.
 *
 * `·` for "nobody has reviewed yet" is drawn rather than omitted, so the field has a fixed shape
 * and a missing review reads as a missing review instead of as a script that stopped early.
 */
const PR_GLYPHS = {
  draft: '✎',
  merged: '✔',
  declined: '✖',
  ciPass: '✓',
  ciFail: '✗',
  ciRunning: '◌',
  approved: '+',
  changes: '≈',
  noReview: '·',
} as const;

/**
 * How long a refresh may hold the lock before the next redraw assumes it died.
 *
 * Fixed rather than derived from the TTL: this bounds a CRASH, not a cadence. Two API calls take
 * under a second and `openPullRequests` gives up at eight, so five minutes is far past any run
 * that is still alive -- and the cost of guessing high is one clone's field staying stale a
 * little longer, against the cost of guessing low, which is two refreshers running at once.
 */
const PR_LOCK_STALE_SECONDS = 300;

export const tmuxStatusArtifact = (hangar: Hangar): Artifact => ({
  path: hangar.paths.tmuxStatusScript,
  mode: 0o755,
  what: "the footer, ticket and pull request on each clone's tmux bar",
  content: `${[
    '#!/bin/sh',
    artifactHeader(
      hangar,
      'one field of the clone status bar: clone-tmux-status.sh <footer|ticket|pr> <clone> [path]',
      [
        'Called by the `#()` jobs in clone-tmux.conf, once per field per status refresh.',
        'Every failure is a silent exit 0: a status bar is no place for an error message.',
      ],
    ),
    '',
    'set -u',
    '',
    `ROOT=${sq(hangar.root)}`,
    `PR_DIR=${sq(hangar.paths.prCache)}`,
    `KEY_PATTERN=${sq(issueKeyPattern(hangar))}`,
    `DEFAULT_BRANCH=${sq(hangar.config.forge.defaultBranch ?? '')}`,
    `HANGAR=${sq(hangar.paths.bin)}`,
    `PR_TTL=${String(prCacheTtlSeconds(hangar))}`,
    `PR_LOCK_STALE=${String(PR_LOCK_STALE_SECONDS)}`,
    `BRANCH_MAX=${String(BRANCH_MAX)}`,
    `PATH_MAX=${String(PATH_MAX)}`,
    '',
    'field=${1:-}',
    'clone=${2:-}',
    'pane_path=${3:-}',
    '',
    '# No clone means the session carries no @hangar_clone -- one somebody made by hand on this',
    '# socket. It is on the same bar, and it is not a clone, so there is nothing to say about it.',
    '[ -n "$field" ] || exit 0',
    '[ -n "$clone" ] || exit 0',
    'dir="$ROOT/$clone"',
    '[ -d "$dir" ] || exit 0',
    '',
    '# `symbolic-ref` and not `branch --show-current`: one ref read rather than a branch walk,',
    '# and it exits non-zero on a detached HEAD, which is the answer "no branch" anyway. The',
    '# footer asks git for its own branch, since one `status -b` answers that and three more.',
    'branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=""',
    '',
    'case "$field" in',
    'footer)',
    '  # Where in the clone this pane is standing. tmux knows the path and hands it over, so',
    '  # nothing here has to guess -- and a pane that has wandered outside the clone says so',
    '  # rather than pretending, because a footer naming the wrong tree is worse than a long one.',
    '  rel=""',
    '  case "$pane_path" in',
    '  "$dir") ;;',
    '  "$dir"/*) rel=${pane_path#"$dir"/} ;;',
    '  "$HOME"/*) rel="~/${pane_path#"$HOME"/}" ;;',
    '  ?*) rel=$pane_path ;;',
    '  esac',
    '  # From the END: the leaf directory is what says where you are, and the segments in front',
    '  # of it are the ones the clone name has already implied.',
    '  if [ ${#rel} -gt "$PATH_MAX" ]; then',
    `    rel="…$(printf '%s' "$rel" | cut -c$((\${#rel} - PATH_MAX + 2))-)"`,
    '  fi',
    '',
    '  # One walk for the branch, the ahead/behind counts and every file state. See the header',
    '  # for why --no-optional-locks is load-bearing rather than tidy.',
    '  staged="" modified="" untracked="" conflict="" ahead="" behind="" head=""',
    '  status=$(git -C "$dir" --no-optional-locks status --porcelain=v1 -b 2>/dev/null) || status=""',
    '  # A here-document, not a pipe: a `while read` on the right of a pipe runs in a subshell in',
    '  # every POSIX shell, and each variable set below would be discarded at the `done`.',
    '  while IFS= read -r line; do',
    '    case "$line" in',
    '    "## "*)',
    '      head=${line#"## "}',
    '      head=${head%%...*}',
    "      case \"$line\" in *'[ahead '*) n=${line#*'[ahead '}; n=${n%%,*}; ahead=${n%%]*} ;; esac",
    "      case \"$line\" in *'behind '*) n=${line#*'behind '}; behind=${n%%]*} ;; esac",
    '      ;;',
    '    "??"*) untracked=1 ;;',
    '    # A `U` on either side, and the two both-added/both-deleted spellings that carry none.',
    '    U?*|?U*|AA*|DD*) conflict=1 ;;',
    '    # A leading space is an empty index column: changed in the tree and not staged.',
    '    " "*) modified=1 ;;',
    '    ?*)',
    '      staged=1',
    '      case "$line" in ?M*|?D*) modified=1 ;; esac',
    '      ;;',
    '    esac',
    `  done <<EOF\n$status\nEOF`,
    '',
    '  # A branch called `something_behind_x` would otherwise be read as a count. Both counts come',
    '  # from the same line as the branch name, so both are checked rather than trusted.',
    '  case "$ahead" in "" | *[!0-9]*) ahead="" ;; esac',
    '  case "$behind" in "" | *[!0-9]*) behind="" ;; esac',
    '',
    '  # A rebase or a merge is the state worth interrupting a glance for, so it leads.',
    '  git_dir=$(git -C "$dir" rev-parse --git-dir 2>/dev/null) || git_dir=""',
    '  marks=""',
    '  if [ -n "$git_dir" ]; then',
    '    case "$git_dir" in /*) ;; *) git_dir="$dir/$git_dir" ;; esac',
    '    if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] ||',
    '      [ -f "$git_dir/MERGE_HEAD" ]; then',
    `      marks="\${marks}${GLYPHS.inProgress}"`,
    '    fi',
    '  fi',
    `  [ -n "$conflict" ] && marks="\${marks}${GLYPHS.conflict}"`,
    `  [ -n "$staged" ] && marks="\${marks}${GLYPHS.staged}"`,
    `  [ -n "$modified" ] && marks="\${marks}${GLYPHS.modified}"`,
    `  [ -n "$untracked" ] && marks="\${marks}${GLYPHS.untracked}"`,
    '  # Nothing to say IS the thing to say. An empty run of glyphs would read as a broken',
    '  # script rather than as a clean tree, so a clean tree gets a character of its own -- and',
    '  # it is decided BEFORE the arrows, because a tree that is clean and merely ahead of its',
    '  # remote is clean, and a lone `⇡6` there reads as an answer with the first half missing.',
    `  [ -n "$marks" ] || marks=${sq(GLYPHS.clean)}`,
    `  [ -n "$ahead" ] && marks="\${marks}${GLYPHS.ahead}\${ahead}"`,
    `  [ -n "$behind" ] && marks="\${marks}${GLYPHS.behind}\${behind}"`,
    '',
    '  # `status -b` names the branch too, and answers on a detached HEAD where `symbolic-ref`',
    '  # cannot -- there it prints `HEAD (no branch)`, which is the honest thing to show.',
    '  [ -n "$branch" ] || branch=$head',
    '  if [ ${#branch} -gt "$BRANCH_MAX" ]; then',
    `    branch="$(printf '%s' "$branch" | cut -c1-"$BRANCH_MAX")…"`,
    '  fi',
    '',
    '  out=" $clone"',
    '  [ -n "$rel" ] && out="$out · $rel"',
    '  out="$out · $marks"',
    '  [ -n "$branch" ] && out="$out · $branch"',
    '  printf \'%s \' "$out"',
    '  ;;',
    'ticket)',
    '  [ -n "$branch" ] || exit 0',
    '  [ -n "$KEY_PATTERN" ] || exit 0',
    '  # `tr` first, so the match runs on words: `_` and `/` are separators in a branch name but',
    '  # word characters to grep, and `-` has to survive because it is inside the key.',
    "  key=$(printf '%s' \"$branch\" | tr -cs 'A-Za-z0-9-' '\\n' | grep -oE \"$KEY_PATTERN\" |",
    '    head -1) || key=""',
    '  [ -n "$key" ] || exit 0',
    '  printf \' %s \' "$key"',
    '  ;;',
    'pr)',
    '  [ -n "$branch" ] || exit 0',
    '  # Nothing to say about the default branch: it has no pull request of its own, and a link',
    '  # to "the pull requests for master" is a link to everything.',
    '  [ "$branch" != "$DEFAULT_BRANCH" ] || exit 0',
    '',
    '  # Everything below comes off DISK. Asking Bitbucket costs two round trips and about a',
    '  # second, and this runs per attached client per interval -- see `pr-cache.ts`. A line',
    "  # naming another branch is not this branch's pull request, so it is dropped rather than",
    '  # shown: that is what keying the record on the branch is for.',
    '  c_branch="" c_id="" c_at="" c_state="" c_draft="" c_ci="" c_review=""',
    '  if [ -f "$PR_DIR/$clone" ]; then',
    '    read -r c_branch c_id _c_url c_at c_state c_draft c_ci c_review _rest \\',
    '      <"$PR_DIR/$clone" || c_branch=""',
    '  fi',
    '  if [ "$c_branch" != "$branch" ]; then',
    '    c_branch="" c_id="" c_at="" c_state="" c_draft="" c_ci="" c_review=""',
    '  fi',
    '  case "$c_at" in "" | *[!0-9]*) c_at=0 ;; esac',
    '',
    '  # Past the TTL, hand the question to a detached `hangar pr refresh` and draw the OLD value',
    '  # now. Nothing here ever waits for the network: the fresh answer lands at the next redraw.',
    '  # This is also why a hangar nobody is looking at makes no requests -- the only thing that',
    '  # starts a refresh is a pane being drawn.',
    '  now=$(date +%s 2>/dev/null) || now=0',
    '  if [ "$now" -gt 0 ] && [ "$((now - c_at))" -ge "$PR_TTL" ]; then',
    '    lock="$PR_DIR/.lock-$clone"',
    "    # A refresher that was killed leaves its lock behind, which would wedge this clone's",
    '    # field for good. The epoch inside the lock is what lets the next redraw tell a run in',
    '    # progress from a corpse.',
    '    if [ -d "$lock" ]; then',
    '      lock_at=$(cat "$lock/at" 2>/dev/null) || lock_at=0',
    '      case "$lock_at" in "" | *[!0-9]*) lock_at=0 ;; esac',
    '      [ "$((now - lock_at))" -ge "$PR_LOCK_STALE" ] && rm -rf "$lock"',
    '    fi',
    '    # `mkdir` is the atomic primitive: of every pane in every window drawing this field at',
    '    # once, exactly one creates the directory, so exactly one refresher is spawned.',
    '    mkdir -p "$PR_DIR" 2>/dev/null',
    '    if mkdir "$lock" 2>/dev/null; then',
    '      printf \'%s\' "$now" >"$lock/at" 2>/dev/null',
    "      # Every descriptor is closed: tmux waits for a job's stdout to reach EOF, so a child",
    '      # holding it open would hang the bar rather than the other way round.',
    '      ("$HANGAR" pr refresh "$clone" >/dev/null 2>&1; rm -rf "$lock") \\',
    '        </dev/null >/dev/null 2>&1 &',
    '    fi',
    '  fi',
    '',
    '  # Nothing known, or known to be nothing. Both draw the bare label: the click opens this',
    "  # branch's pull requests, which is true either way, and a cold cache with nothing on the",
    '  # bar would leave nothing to click.',
    '  if [ -z "$c_branch" ] || [ "$c_id" = "0" ]; then',
    "    printf ' PR '",
    '    exit 0',
    '  fi',
    '',
    '  case "$c_state" in',
    `  merged) printf ' ${PR_GLYPHS.merged}#%s ' "$c_id" ;;`,
    `  declined) printf ' ${PR_GLYPHS.declined}#%s ' "$c_id" ;;`,
    '  *)',
    '    mark=""',
    `    [ "$c_draft" = "1" ] && mark=${sq(PR_GLYPHS.draft)}`,
    '    out=" $mark#$c_id"',
    '    # Colour, which the FOOTER may never use -- the two lines of this bar sit on different',
    "    # backgrounds. Down there it is the clone's hue with ink on it, where a red mark on the",
    '    # red clone would be invisible; up here it is the one neutral the whole fleet shares, so',
    "    # `palette.ts` can prove a floor against it. tmux expands `#[...]` out of a job's output",
    '    # -- measured, not assumed -- which is what makes this reachable from a shell script.',
    '    case "$c_ci" in',
    `    pass) out="$out #[fg=${CI_COLOURS.pass}]${PR_GLYPHS.ciPass}#[default]" ;;`,
    `    fail) out="$out #[fg=${CI_COLOURS.fail}]${PR_GLYPHS.ciFail}#[default]" ;;`,
    `    running) out="$out #[fg=${CI_COLOURS.running}]${PR_GLYPHS.ciRunning}#[default]" ;;`,
    '    esac',
    '    case "$c_review" in',
    `    approved) out="$out ${PR_GLYPHS.approved}" ;;`,
    `    changes) out="$out ${PR_GLYPHS.changes}" ;;`,
    `    *) out="$out ${PR_GLYPHS.noReview}" ;;`,
    '    esac',
    `    printf '%s ' "$out"`,
    '    ;;',
    '  esac',
    '  ;;',
    'esac',
  ].join('\n')}\n`,
});

/** Single-quote for `sh`. A hangar root with a quote in it is not a case, but a silent one. */
const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
