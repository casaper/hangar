/**
 * `conventional-changelog-conventionalcommits` ships no types, and `changelog.preset.ts` is inside
 * `tsconfig`'s include so that the one config file this package hand-writes is held to the same
 * strict flags as `src/`. Leaving it out of the project instead would have been the cheaper answer
 * and the wrong one: it is the file that decides what the published CHANGELOG contains.
 *
 * Only the shape actually used is declared. Widening this to the preset's full option surface would
 * be inventing a contract for a package that publishes none.
 */
declare module 'conventional-changelog-conventionalcommits' {
  type ChangelogType = { type: string; section?: string; hidden?: boolean };
  const createPreset: (options: { types: ChangelogType[] }) => Promise<unknown>;
  export default createPreset;
}
