import { join } from 'node:path';

import type { Clone } from '../fleet.ts';
import { themesDir } from '../user-paths.ts';
import type { Artifact } from './index.ts';

/**
 * `~/.claude/themes/<id>-clone-NN-<colour>.json` -- one per clone.
 *
 * JSON has no comment syntax and the theme file is parsed by Claude Code against its own
 * schema, so this is the one generated artifact WITHOUT a "do not edit" header: an unknown
 * key risks the theme being rejected, and a rejected theme is a clone that silently looks
 * like every other clone. `hangar doctor` is what catches a hand-edited theme instead.
 *
 * Only `theme` differs per clone in a clone's settings; the file name encodes the hue name
 * so the value in settings.local.json reads as `custom:<id>-clone-01-cyan`.
 */
export const themeName = (clone: Clone): string =>
  `${clone.hangar.id}-clone-${String(clone.index).padStart(clone.hangar.config.clones.pad, '0')}-${clone.colour.name}`;

export const themePath = (clone: Clone): string => join(themesDir, `${themeName(clone)}.json`);

export const themeArtifact = (clone: Clone): Artifact => {
  const theme = {
    name: `${clone.name} (${clone.colour.name})`,
    base: 'dark',
    overrides: {
      claude: clone.colour.main,
      claudeShimmer: clone.colour.shimmer,
      briefLabelClaude: clone.colour.main,
      promptBorder: clone.colour.border,
      promptBorderShimmer: clone.colour.main,
    },
  };
  return {
    path: themePath(clone),
    content: `${JSON.stringify(theme, null, 2)}\n`,
    what: `${clone.name} Claude Code theme (${clone.colour.name})`,
  };
};
