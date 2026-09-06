/**
 * The conventional-changelog preset used to write CHANGELOG.md, run by `pnpm changelog`.
 *
 * **Its type list is not written here.** It is `CHANGELOG_TYPES` in `src/release/rules.ts`,
 * which is where `hangar dev release` reads the same table from when it works out what a commit
 * is worth. Two copies of a twelve-entry table that MUST agree is exactly the drift this repo
 * keeps finding: the sections rendered here and the sections the release command believes in
 * would end up disagreeing, and nothing would say so. One source, read twice.
 *
 * It lived in `.releaserc.json` until releases stopped being cut by semantic-release; the file
 * moved, the argument did not.
 *
 * The list exists at all because the `conventionalcommits` preset hides everything but `feat`,
 * `fix` and `perf` by default, and for this history that is wrong rather than merely terse: with
 * the defaults, v0.11.0 -- the release that added the entire `node:test` suite -- rendered as a
 * heading with nothing under it, and v0.7.0, which added both skills and the mode pair, showed one
 * line. Documentation is a first-class change here; the `hangar-internals` reference files are the
 * regression record for the two thirds of this CLI no test covers.
 */
import createPreset from 'conventional-changelog-conventionalcommits';

import { CHANGELOG_TYPES } from './src/release/rules.ts';

export default createPreset({ types: [...CHANGELOG_TYPES] });
