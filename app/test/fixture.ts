import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseConfigText } from '../src/config/load.ts';
import { pathsFor, type Hangar } from '../src/hangar.ts';

/**
 * A `Hangar` built entirely in memory, for tests that must not depend on this machine.
 *
 * **Every root and every `~/.claude` here is synthetic, and that is a requirement rather than
 * tidiness.** Two things reach out to the filesystem behind an innocent-looking call:
 *
 * - `makeClone` asks `colourAssignmentFor`, which reads `.hangar/colour-assignments.json` under
 *   the hangar root and caches the parse PER ROOT. Point a test at the real hangar and it reads
 *   this developer's own `hangar colours change` history -- green here, red on a colleague's
 *   clone, for a reason nothing in the test names.
 * - `claudeDir` in `user-paths.ts` is derived from `homedir()`. Passing it would bake this
 *   machine's home directory into the expected value of every statusline path, theme path and
 *   memory directory in the suite.
 *
 * A root of `/wt` exists nowhere, so both reads miss and every value below is a pure function of
 * the config text. `noMachinePaths` is the standing check that this stayed true.
 */
export const FIXTURE_CONFIG = join(import.meta.dirname, '..', 'dev', 'fixture.config.yaml');

/**
 * The hostile fixture, whose every value differs from this hangar's AND from the schema
 * defaults -- see the header of `dev/fixture.config.yaml` for why that matters. Reusing it here
 * rather than inventing a second one keeps the tests and the golden net describing one config.
 */
export const fixtureConfigText = (): string => readFileSync(FIXTURE_CONFIG, 'utf8');

export type SyntheticOptions = {
  readonly root?: string;
  readonly claudeDir?: string;
  /** Config text to parse instead of the fixture's -- for tests that vary one key. */
  readonly configText?: string;
};

export const syntheticHangar = (opts: SyntheticOptions = {}): Hangar => {
  const config = parseConfigText(opts.configText ?? fixtureConfigText(), 'the test fixture');
  const root = opts.root ?? '/wt';
  const claudeDir = opts.claudeDir ?? '/synthetic-claude';
  return {
    root,
    id: config.id,
    config,
    source: 'flag',
    paths: pathsFor(root, config.id, config.secrets.file, claudeDir),
    configFellBack: false,
  };
};

/**
 * Nothing in `text` names this machine.
 *
 * **Passing by construction is the point, and is also the limit of it.** Every value built from
 * `syntheticHangar()` derives from `/wt` and `/synthetic-claude`, so there is no home directory
 * available to leak -- this cannot fail today, and that is the state it exists to preserve. What
 * it would catch is a builder wired to `homedir()` DIRECTLY instead of through the threaded
 * hangar, which is the mistake that makes a whole suite pass here and fail everywhere else.
 *
 * The one builder that genuinely reads the environment (`envSharedShellRef`, which writes
 * `$HOME/...` rather than a literal path) is covered on its own terms in `builders.test.ts`,
 * against a hangar deliberately rooted under the real `$HOME` -- because this guard, by
 * construction, could never reach it.
 *
 * Checked against `/Users/` and `/home/` rather than the actual home directory, so it catches a
 * hardcoded path belonging to somebody else too.
 */
export const namesNoMachinePath = (text: string): boolean =>
  !text.includes('/Users/') && !text.includes('/home/');
