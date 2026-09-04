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
 * ## One function, three fields
 *
 * `hangar_<id>_colour <clone>` prints `<r;g;b> <x256> <name>`, and a consumer picks what it
 * needs apart with `set --`. One case statement rather than three, because the table is the part
 * that grows with the fleet and the parsing is two lines wherever it is needed.
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
  const fieldsWidth = Math.max(
    0,
    ...clones.map(
      (c) => `'${c.colour.mainTriple} ${String(c.colour.x256)} ${c.colour.name}'`.length,
    ),
  );

  const arm = (label: string, body: string, comment?: string): string =>
    `        ${`${label})`.padEnd(labelWidth)}${body}${comment === undefined ? '' : `   # ${comment}`}`;

  const arms = clones.map((c) =>
    arm(
      c.name,
      `printf ${`'${c.colour.mainTriple} ${String(c.colour.x256)} ${c.colour.name}'`.padEnd(fieldsWidth)} ;;`,
      c.colour.main,
    ),
  );

  const content = [
    artifactHeader(
      hangar,
      `Canonical per-clone hues for the ${hangarId} hangar. Sourceable by sh/bash/zsh.`,
    ),
    '#',
    `# ${fn} <clone_NN>  ->  "<r;g;b> <xterm-256 index> <name>"`,
    '#',
    '# Read it with two lines, in any POSIX shell:',
    `#     set -- $(${fn} "$clone") ; rgb=$1 x256=$2 name=$3`,
    '#',
    '# One other place cannot source this file and carries its own copy of the table:',
    `#   ${tildify(hangar.paths.statuslineScript)}`,
    '#     (self-contained on purpose: it runs on every status-line render and must never fail)',
    '# It is generated from the same data, so the two cannot drift.',
    '#',
    '# Formula, so the set reads as one family: shimmer = main + 40% toward white,',
    '# border = main x 0.8, statusline dim = main x 0.6.',
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
