import type { Clone } from '../fleet.ts';
import { cloneColoursScript } from '../paths.ts';
import { type Artifact, artifactHeader } from './index.ts';

/**
 * `clone-colours.sh` -- the hue table for shell consumers (currently the iTerm2 chpwd hook).
 *
 * This stays a standalone sourceable shell file rather than becoming a CLI call: it is read
 * on every `cd`, and spawning node per directory change is a non-starter.
 */
export const cloneColoursArtifact = (clones: readonly Clone[]): Artifact => {
  const labelWidth = Math.max(3, ...clones.map((c) => c.name.length + 2));
  const tripleWidth = Math.max(0, ...clones.map((c) => c.colour.mainTriple.length + 2));
  const nameWidth = Math.max(0, ...clones.map((c) => c.colour.name.length));

  const arm = (label: string, body: string, comment?: string): string =>
    `        ${`${label})`.padEnd(labelWidth)}${body}${comment === undefined ? '' : `   # ${comment}`}`;

  const arms = clones.map((c) =>
    arm(
      c.name,
      `printf ${`'${c.colour.mainTriple}'`.padEnd(tripleWidth)} ;;`,
      `${c.colour.name.padEnd(nameWidth)} ${c.colour.main}`,
    ),
  );

  const content = [
    artifactHeader('Canonical per-clone hues for the dvb_gn fleet. Sourceable by sh/bash/zsh.'),
    '#',
    '# One other place cannot source this file and carries its own copy of the table:',
    '#   ~/.claude/dvb-clone-statusline.sh   (self-contained on purpose: it runs on every',
    '#                                        status-line render and must never fail)',
    '# It is generated from the same data, so the two cannot drift.',
    '#',
    '# Formula, so the set reads as one family: shimmer = main + 40% toward white,',
    '# border = main x 0.8, statusline dim = main x 0.6.',
    '',
    'dvb_clone_rgb() {',
    '    case "$1" in',
    ...arms,
    arm('*', 'return 1 ;;'),
    '    esac',
    '}',
    '',
  ].join('\n');

  return {
    path: cloneColoursScript,
    content,
    mode: 0o755,
    what: 'hue table for shell consumers',
  };
};
