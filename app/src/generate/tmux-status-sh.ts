import type { Hangar } from '../hangar.ts';
import { type Artifact, artifactHeader } from './index.ts';

/**
 * `clone-tmux-status.sh` -- the three facts the clone bar shows that tmux cannot answer itself.
 *
 * `generate/tmux-conf.ts`'s `barOptions` puts three `#(…)` jobs on the bar: the branch on the
 * pane border, and the ticket key and pull request number in `status-right`. Each one is a call
 * to this script with a field name and the clone's name, and the clone comes from the session's
 * `@hangar_clone` tag rather than from a pane's working directory -- see `barOptions` for why
 * that is a correctness property and not a preference.
 *
 * ## Why a generated shell script and not the CLI
 *
 * tmux re-runs every job on the bar at `status-interval`, per attached client. Measured on this
 * machine: `bin/hangar --version` costs 0.24-0.28s, and shell plus git costs 0.02-0.04s. A CLI
 * in that loop would be a quarter of a second of Node startup several times a minute for every
 * open clone, to print eight characters. So the refresh is shell, and the one thing that DOES
 * call `hangar` is the click (`hangar browse`), which happens when a human decides it does.
 *
 * Generated rather than tracked, for the same reason `clone-colours.sh` is: it carries this
 * hangar's root, its tracker's key shapes and its default branch. Self-contained in the same
 * spirit as `~/.claude/<id>-clone-statusline.sh` -- every failure is `exit 0` with nothing
 * printed, because the alternative on a status bar is an error message redrawn every ten seconds
 * in a place nothing can be dismissed from.
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
 * How much branch the border line will carry.
 *
 * Measured against this fleet's own branch names: `fixes/ABC-1323_i_can_close_the_browser_tab_even_changes_not_saved`
 * is 58 columns, and every one of them is worth reading. So this is not a fit-the-terminal number
 * -- tmux truncates the border text on a narrow window by itself -- it is a cap that stops a
 * pathological branch name from being the whole line.
 */
const BRANCH_MAX = 72;

export const tmuxStatusArtifact = (hangar: Hangar): Artifact => ({
  path: hangar.paths.tmuxStatusScript,
  mode: 0o755,
  what: "the branch, ticket and pull request on each clone's tmux bar",
  content: `${[
    '#!/bin/sh',
    artifactHeader(
      hangar,
      'one field of the clone status bar: clone-tmux-status.sh <branch|ticket|pr> <clone>',
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
    `BRANCH_MAX=${String(BRANCH_MAX)}`,
    '',
    'field=${1:-}',
    'clone=${2:-}',
    '',
    '# No clone means the session carries no @hangar_clone -- one somebody made by hand on this',
    '# socket. It is on the same bar, and it is not a clone, so there is nothing to say about it.',
    '[ -n "$field" ] || exit 0',
    '[ -n "$clone" ] || exit 0',
    'dir="$ROOT/$clone"',
    '[ -d "$dir" ] || exit 0',
    '',
    '# `symbolic-ref` and not `branch --show-current`: one ref read rather than a branch walk,',
    '# and it exits non-zero on a detached HEAD, which is the answer "no branch" anyway.',
    'branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=""',
    '[ -n "$branch" ] || exit 0',
    '',
    'case "$field" in',
    'branch)',
    '  if [ ${#branch} -gt "$BRANCH_MAX" ]; then',
    `    printf ' %s… ' "$(printf '%s' "$branch" | cut -c1-"$BRANCH_MAX")"`,
    '  else',
    '    printf \' %s \' "$branch"',
    '  fi',
    '  ;;',
    'ticket)',
    '  [ -n "$KEY_PATTERN" ] || exit 0',
    '  # `tr` first, so the match runs on words: `_` and `/` are separators in a branch name but',
    '  # word characters to grep, and `-` has to survive because it is inside the key.',
    "  key=$(printf '%s' \"$branch\" | tr -cs 'A-Za-z0-9-' '\\n' | grep -oE \"$KEY_PATTERN\" |",
    '    head -1) || key=""',
    '  [ -n "$key" ] || exit 0',
    '  printf \' %s \' "$key"',
    '  ;;',
    'pr)',
    '  # Nothing to say about the default branch: it has no pull request of its own, and a link',
    '  # to "the pull requests for master" is a link to everything.',
    '  [ "$branch" != "$DEFAULT_BRANCH" ] || exit 0',
    '  # The number comes off disk because asking Bitbucket for it costs a token and up to eight',
    "  # seconds -- see `pr-cache.ts`. A cache line for another branch is not this branch's pull",
    '  # request, so it is ignored rather than shown: that is what keying it on the branch is for.',
    '  if [ -f "$PR_DIR/$clone" ] &&',
    '    read -r cached_branch cached_id _rest <"$PR_DIR/$clone" &&',
    '    [ "$cached_branch" = "$branch" ] && [ -n "$cached_id" ]; then',
    '    printf \' PR#%s \' "$cached_id"',
    '  else',
    "    # A label rather than a claim: the click opens this branch's pull requests, which is a",
    '    # true statement whether or not one exists. Without it a cold cache would leave nothing',
    '    # on the bar to click, and the number only ever arrives by someone asking once.',
    "    printf ' PR '",
    '  fi',
    '  ;;',
    'esac',
  ].join('\n')}\n`,
});

/** Single-quote for `sh`. A hangar root with a quote in it is not a case, but a silent one. */
const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
