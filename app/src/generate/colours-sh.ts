import type { Hangar } from '../hangar.ts';
import type { Clone } from '../fleet.ts';
import { type Artifact, artifactHeader } from './index.ts';
import { tildify } from '../user-paths.ts';

/**
 * `clone-colours.sh` -- the hue table for shell consumers (the terminal hook next to it).
 *
 * This stays a standalone sourceable shell file rather than becoming a CLI call: it is read on
 * every `cd`, and spawning node per directory change is a non-starter.
 *
 * ## One function, five fields
 *
 * `hangar_<id>_colour <clone>` prints `<r;g;b> <x256> <name> <ink> <bar text>`, and a consumer
 * picks what it needs apart with `set --`. One case statement rather than five, because the
 * table is the part that grows with the fleet and the parsing is two lines wherever it is needed.
 *
 * The last two are contrast decisions rather than renderings of the hue, and they are computed
 * in `src/palette.ts` and BAKED IN here for one reason: choosing them needs WCAG relative
 * luminance, which is a gamma curve per channel, and this file is read on every `cd`. `ink` is
 * the pure black or pure white that reads on the hue; `<bar text>` is the hue lifted far enough
 * to read as text on the tmux status bar. Only the tmux arm of the hook beside this file uses
 * them.
 *
 * **Fields are APPENDED, never reordered.** `$1`, `$2` and `$3` are what a developer's own
 * prompt may already read out of `set --`, so the two new ones went on the end even though it
 * puts the human-readable `name` in the middle.
 *
 * ## The name carries the hangar id
 *
 * Several hangars can be sourced into one shell, and a bare `clone_colour` would have the last
 * one sourced answer for all of them -- silently, and with the wrong hues. The id is restricted
 * to `[a-z][a-z0-9_]*` by the config schema for exactly this reason: it has to be a legal shell
 * function name.
 */
export const cloneColoursArtifact = (hangar: Hangar, clones: readonly Clone[]): Artifact => {
  const hangarId = hangar.id;
  const fn = `hangar_${hangarId}_colour`;
  const labelWidth = Math.max(3, ...clones.map((c) => c.name.length + 2));
  // One spelling of the field list, used for the width and for the arms. It was written twice,
  // which is exactly the shape that lets a table and its own column widths disagree.
  const fields = (c: Clone): string =>
    `'${c.colour.mainTriple} ${String(c.colour.x256)} ${c.colour.name} ${c.colour.ink} ${c.colour.barText}'`;
  const fieldsWidth = Math.max(0, ...clones.map((c) => fields(c).length));

  const arm = (label: string, body: string, comment?: string): string =>
    `        ${`${label})`.padEnd(labelWidth)}${body}${comment === undefined ? '' : `   # ${comment}`}`;

  const arms = clones.map((c) =>
    arm(c.name, `printf ${fields(c).padEnd(fieldsWidth)} ;;`, c.colour.main),
  );

  const content = [
    artifactHeader(
      hangar,
      `Canonical per-clone hues for the ${hangarId} hangar. Sourceable by sh/bash/zsh.`,
    ),
    '#',
    // `<clone>`, not a literal directory pattern: `clone_NN` was this fleet's own prefix, and
    // the very next usage line already passes `"$clone"`.
    `# ${fn} <clone>  ->  "<r;g;b> <xterm-256 index> <name> <ink> <bar text>"`,
    '#',
    '# Read it with two lines, in any POSIX shell:',
    `#     set -- $(${fn} "$clone") ; rgb=$1 x256=$2 name=$3 ink=$4 bar=$5`,
    '#',
    '# Fields are only ever APPENDED, so $1..$3 stay where anything already reading them',
    '# expects. ink is the pure black or white that reads on the hue, and <bar text> is the hue',
    '# lifted far enough to read AS text on the tmux status bar -- both from src/palette.ts,',
    '# because choosing them needs a gamma curve per channel and this file runs on every cd.',
    '#',
    '# One other place cannot source this file and carries its own copy of the table:',
    `#   ${tildify(hangar.paths.statuslineScript)}`,
    '#     (self-contained on purpose: it runs on every status-line render and must never fail)',
    '# It is generated from the same data, so the two cannot drift.',
    '#',
    '# Formula, so the set reads as one family: shimmer = main + 40% toward white,',
    '# border = main x 0.8, statusline dim = main x 0.6. The two contrast fields are not',
    '# ratios: ink is whichever of black and white reads better on the hue, which can never be',
    '# worse than 4.58:1 for any colour, and <bar text> is a floor rather than a lightening --',
    '# fourteen of the sixteen hues clear it untouched and come back byte-identical.',
    '',
    `${fn}() {`,
    '    case "$1" in',
    ...arms,
    arm('*', 'return 1 ;;'),
    '    esac',
    '}',
    '',
  ].join('\n');

  return {
    path: hangar.paths.cloneColoursScript,
    content,
    mode: 0o755,
    what: 'hue table for shell consumers',
  };
};
