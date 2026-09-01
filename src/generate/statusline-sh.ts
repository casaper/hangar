import type { Clone } from '../fleet.ts';
import { fleetRoot, statuslineScript } from '../paths.ts';
import { type Artifact, artifactHeader } from './index.ts';

/**
 * `~/.claude/dvb-clone-statusline.sh` -- ONE script for every clone.
 *
 * It stays self-contained bash on purpose. It runs on every status-line render, so a node
 * process here would be felt, and its own contract is that it must never fail: no sourcing
 * of files that may be missing, no dependency beyond git and jq (with a hardcoded jq path
 * as the fallback).
 *
 * The colour is still never hardcoded per clone in the sense that matters -- the script
 * derives it from the directory it is invoked in, and the table below is generated from the
 * same `src/palette.ts` as the themes and `clone-colours.sh`, so the three cannot drift.
 */
export const statuslineArtifact = (clones: readonly Clone[]): Artifact => {
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
    artifactHeader('Status line for the storefront_ui clone fleet (~/code/dvb_gn/clone_NN).'),
    '#',
    '# ONE script for all clones: the colour is derived from the clone directory in the stdin',
    '# payload, never from an argument, so every clone runs identical code and only the hue',
    '# differs. Hues match ~/.claude/themes/dvb-clone-*.json exactly, because both are',
    '# generated from src/palette.ts.',
    'set -uo pipefail',
    '',
    'JQ="$(command -v jq || true)"',
    '[ -n "$JQ" ] || JQ=/opt/homebrew/bin/jq',
    '',
    'input="$(cat)"',
    `field() { printf '%s' "$input" | "$JQ" -r "$1 // empty" 2>/dev/null; }`,
    '',
    `dir="$(field '.workspace.current_dir')"`,
    '[ -n "$dir" ] || dir="$PWD"',
    '',
    '# The clone is the path segment under the fleet root, not basename($dir) --',
    '# a session started in clone_01/angular/ must still report clone_01. Two or more',
    '# digits, so this keeps working past clone_09.',
    `FLEET='${fleetRoot}'`,
    `clone="$(printf '%s' "$dir" | sed -n "s|^\${FLEET}/\\(clone_[0-9][0-9]*\\).*|\\1|p")"`,
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
    'branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"',
    '',
    `out="$(c)$(printf '\\033[1m')\u25cf \${clone}$(r)"`,
    `[ -n "$branch" ] && out="\${out}$(d) \u00b7 $(r)$(c)\${branch}$(r)"`,
    `[ -n "$model" ]  && out="\${out}$(d) \u00b7 \${model}$(r)"`,
    `printf '%s' "$out"`,
    '',
  ].join('\n');

  return {
    path: statuslineScript,
    content,
    mode: 0o755,
    what: 'shared Claude Code status line (derives its hue from the clone directory)',
  };
};
