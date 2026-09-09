import type { Hangar } from '../hangar.ts';
import { cloneGlobPattern, type Clone } from '../fleet.ts';
import { tildify } from '../user-paths.ts';
import { type Artifact, artifactHeader } from './index.ts';

/**
 * `~/.claude/<id>-clone-statusline.sh` -- ONE script for every clone in one hangar.
 *
 * It stays self-contained bash on purpose. It runs on every status-line render, so a node
 * process here would be felt, and its own contract is that it must never fail: no sourcing
 * of files that may be missing, no dependency beyond jq (with a hardcoded jq path as the
 * fallback).
 *
 * The colour is still never hardcoded per clone in the sense that matters -- the script
 * derives it from the directory it is invoked in, and the table below is generated from the
 * same `src/palette.ts` as the themes and `clone-colours.sh`, so the three cannot drift.
 *
 * ## What it says, and what the footer says instead
 *
 * The clone bar's footer names the clone and its branch, so this line spends its width on what
 * only Claude Code can answer: how much of the context window is gone, which model, and which
 * session. The coloured `●` stays, and it is not decoration -- it is the clone's identity in the
 * one place that survives a session started outside hangar's tmux, where there is no footer.
 *
 * ## Three things this CANNOT show, each checked against a real payload
 *
 * A live payload was captured and read rather than trusted to the docs. It carries `session_id`,
 * `transcript_path`, `context_window`, `cost`, `rate_limits`, `session_name`, `model`,
 * `workspace`, `version`, `effort`, `thinking`, `prompt_cache`, `output_style`, `fast_mode`,
 * `exceeds_200k_tokens`, `cwd` and `scratchpad_dir`. What is not in it:
 *
 * - **The task list.** Not a field, and Claude Code documents the on-disk session format as
 *   internal and breaking between releases, so there is no supported source to read either.
 * - **The active plan.** No name and no path. `session_name` exists and is NOT the plan -- the
 *   captured value was `hangar dev`, a session name -- so it is not stood in for one here.
 * - **The `NNNNNN tokens` badge.** That is Claude Code's own footer badge in its own row, with no
 *   setting to hide or reformat it. The figure below sits BESIDE it rather than replacing it, and
 *   earns the space by adding the window size and the percentage the badge does not show.
 *
 * `context_window.total_input_tokens` is the same quantity the badge counts -- in the captured
 * payload it was 232921, exactly `current_usage`'s input plus cache-read plus cache-creation.
 */
/**
 * Finding `jq` when PATH is not the developer's PATH.
 *
 * A status line is spawned by Claude Code, not by a shell the developer configured, so `jq` can
 * easily be off PATH even on a machine where typing `jq` works. The old fallback was the single
 * literal `/opt/homebrew/bin/jq`, which is Homebrew on Apple Silicon and **nowhere else** -- on
 * Linux, and on an Intel Mac, the fallback silently fails, `field()` returns empty for every
 * query, and the status line renders with no clone, no branch and no model. It does not error;
 * it just goes blank, which reads as a Claude Code problem rather than a missing binary.
 *
 * So: a search list, ordered most-specific first. **The identical list is duplicated by hand in
 * `.claude/modes/statusline.sh`**, which badges the hangar-root modes -- that file is
 * hand-maintained and nothing derives it from here, so fixing only this one leaves the mode badge
 * broken on exactly the platforms this list exists for. Change one, change both.
 */
export const JQ_SEARCH_LINES: readonly string[] = Object.freeze([
  'JQ="$(command -v jq || true)"',
  'if [ -z "$JQ" ]; then',
  '    for candidate in /opt/homebrew/bin/jq /usr/local/bin/jq /usr/bin/jq /bin/jq \\',
  '                     /snap/bin/jq "$HOME/.local/bin/jq"; do',
  '        if [ -x "$candidate" ]; then JQ="$candidate"; break; fi',
  '    done',
  'fi',
]);

export const statuslineArtifact = (hangar: Hangar, clones: readonly Clone[]): Artifact => {
  const labelWidth = Math.max(3, ...clones.map((c) => c.name.length + 2));
  // Pad AFTER the semicolon, not before it, so the assignments line up the way a human
  // would have typed them.
  const mainPart = (c: Clone): string => `main="${c.colour.mainTriple}";`;
  const dimPart = (c: Clone): string => `dim="${c.colour.dimTriple}"`;
  const mainWidth = Math.max(0, ...clones.map((c) => mainPart(c).length + 1));
  const dimWidth = Math.max(0, ...clones.map((c) => dimPart(c).length));

  const arm = (label: string, body: string, comment?: string): string =>
    `    ${`${label})`.padEnd(labelWidth)}${body}${comment === undefined ? '' : `   # ${comment}`}`;

  const arms = clones.map((c) =>
    arm(c.name, `${mainPart(c).padEnd(mainWidth)}${dimPart(c).padEnd(dimWidth)} ;;`, c.colour.name),
  );

  const content = [
    '#!/usr/bin/env bash',
    artifactHeader(
      hangar,
      `Status line for the ${hangar.id} hangar's clones (${tildify(hangar.root)}/${cloneGlobPattern(hangar)}).`,
    ),
    '#',
    '# ONE script for all clones: the colour is derived from the clone directory in the stdin',
    '# payload, never from an argument, so every clone runs identical code and only the hue',
    `# differs. Hues match ~/.claude/themes/${hangar.id}-clone-*.json exactly, because both are`,
    '# generated from src/palette.ts.',
    'set -uo pipefail',
    '',
    ...JQ_SEARCH_LINES,
    '',
    'input="$(cat)"',
    `field() { printf '%s' "$input" | "$JQ" -r "$1 // empty" 2>/dev/null; }`,
    '',
    `dir="$(field '.workspace.current_dir')"`,
    '[ -n "$dir" ] || dir="$PWD"',
    '',
    '# The clone is the path segment under the hangar root, not basename($dir) -- a session',
    '# started in a SUBDIRECTORY of a clone must still report the clone. The digit count is',
    '# open at the top, so this keeps working past the first index that needs another digit.',
    `FLEET='${hangar.root}'`,
    `clone="$(printf '%s' "$dir" | sed -n "s|^\${FLEET}/\\(${cloneGlobPattern(hangar)}\\).*|\\1|p")"`,
    '[ -n "$clone" ] || clone="$(basename "$dir")"',
    '',
    '# Same triples as the theme files: main / dim.',
    'case "$clone" in',
    ...arms,
    arm('*', 'main="150;150;150"; dim="100;100;100" ;;'),
    'esac',
    '',
    `c()  { printf '\\033[38;2;%sm' "$main"; }`,
    `d()  { printf '\\033[38;2;%sm' "$dim"; }`,
    `r()  { printf '\\033[0m'; }`,
    '',
    `model="$(field '.model.display_name')"`,
    `session="$(field '.session_id')"`,
    `used="$(field '.context_window.total_input_tokens')"`,
    `window="$(field '.context_window.context_window_size')"`,
    `pct="$(field '.context_window.used_percentage')"`,
    '',
    '# 232921 -> 233k, 1000000 -> 1M. Integer arithmetic only: `bc` is not a dependency this',
    '# script is allowed to acquire, and awk for one rounding is a process per render.',
    '# Anything that is not a run of digits prints nothing, which is how a payload without the',
    '# field -- an older Claude Code, a shape that has moved -- costs a segment and never a line.',
    'hum() {',
    '    case "${1:-}" in "" | *[!0-9]*) return 0 ;; esac',
    '    if [ "$1" -ge 1000000 ]; then',
    '        local m=$(($1 / 1000000)) f=$((($1 % 1000000) / 100000))',
    `        if [ "$f" -eq 0 ]; then printf '%dM' "$m"; else printf '%d.%dM' "$m" "$f"; fi`,
    '    elif [ "$1" -ge 1000 ]; then',
    `        printf '%dk' "$((($1 + 500) / 1000))"`,
    '    else',
    `        printf '%d' "$1"`,
    '    fi',
    '}',
    '',
    '# The clone is the coloured bullet and nothing else: its name, its path and its branch are',
    "# on the tmux footer, in this clone's own hue, with room to spare. The bullet is what still",
    "# names it in a session started outside hangar's tmux, where there is no footer at all.",
    `out="$(c)$(printf '\\033[1m')\u25cf$(r)"`,
    '',
    '# `233k/1M · 23%`: the percentage is what gets read, and the pair either side of it is what',
    "# says whether 23 per cent is a lot. Claude Code's own badge shows the same first number raw",
    '# and neither of the other two.',
    'used_h="$(hum "$used")"',
    'window_h="$(hum "$window")"',
    'if [ -n "$used_h" ]; then',
    `    out="\${out} $(c)\${used_h}$(r)"`,
    `    [ -n "$window_h" ] && out="\${out}$(d)/\${window_h}$(r)"`,
    'fi',
    `case "\${pct:-}" in`,
    `    "" | *[!0-9]*) ;;`,
    `    *) out="\${out}$(d) \u00b7 \${pct}%$(r)" ;;`,
    'esac',
    `[ -n "$model" ] && out="\${out}$(d) \u00b7 \${model}$(r)"`,
    '',
    '# The first eight characters of the session id, which is enough to tell two sessions in one',
    '# clone apart and is the handle `claude --resume` takes -- so the thing that brings this',
    '# conversation back is on screen rather than dug out of a transcript directory.',
    `[ -n "$session" ] && out="\${out}$(d) \u00b7 \${session:0:8}$(r)"`,
    `printf '%s' "$out"`,
    '',
  ].join('\n');

  return {
    path: hangar.paths.statuslineScript,
    content,
    mode: 0o755,
    what: 'shared Claude Code status line (derives its hue from the clone directory)',
  };
};
