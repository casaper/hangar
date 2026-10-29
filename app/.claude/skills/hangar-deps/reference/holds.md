# Standing holds

Each one is a package `pnpm outdated` offers and a sweep must not take. Both fail **silently** if
taken anyway, and that is why they are written down. `pnpm deps:survey` measures each unblock
fact on every run (`dev/deps-survey.ts`, `TS_PEER_HOST` and `WRITER_HOST`).

## TypeScript stays inside typescript-eslint's `typescript` peer

`typescript-eslint` declares a `typescript` peer range with an upper bound (`<6.1.0` at the time of
writing), and no major of it exists that admits TypeScript 7.

- **How it fails**: nothing in this repo sets `strict-peer-dependencies`, so pnpm installs across a
  violated peer with a warning. `pnpm lint` then runs against a parser that was never built for
  that compiler. Install succeeds, the gates may even pass, and the lint results cannot be trusted.
- **What moves anyway**: TypeScript patch releases inside the peer range. The survey's TypeScript
  line _is_ that range, so a 6.0.x patch shows up under TAKE like any other package.
- **Pin it exact**: `^6.0.3` would admit 6.1.
- **Unblocks when**: a `typescript-eslint` release past the floor peers a range that admits the
  next TypeScript major. That is a migration: read TypeScript's breaking changes, check
  `tsconfig.json`'s flags (`erasableSyntaxOnly`, `verbatimModuleSyntax`) and move both packages in
  one commit.

## The changelog preset stays at 8, and its deprecated CLI with it

`conventional-changelog-conventionalcommits` stays at 8.0.0, and `conventional-changelog-cli`
5.0.0 stays despite being deprecated upstream. They are one hold, and each of its two blockers
fails as a **malformed CHANGELOG rather than an error**:

1. **Preset 10 reads only `effect`, never `hidden`.** `.releaserc.json`'s `presetConfig.types`
   table hides types with `hidden: true`, and under preset 10 every `chore(release): <version>`
   commit reappears in the changelog it just wrote. `changelog.preset.ts`'s assertion still passes,
   because it checks the entry's order, not that it took effect.
2. **Writer generations split.** Preset 10 is built on `conventional-changelog-writer` 9.
   `@semantic-release/release-notes-generator` depends on writer 8, so both get installed, and
   `pnpm changelog` renders differently from a real release.

- **Unblocks when**: release-notes-generator depends on writer 9. Then the migration is
  `.releaserc.json` to the `effect` schema, the preset, and replacing the deprecated CLI, in one
  plan (`hangar-internals/reference/release.md` first).
- **The discriminator**, before and after any attempt:
  `pnpm changelog && git diff --exit-code ../CHANGELOG.md`. It is clean at 8.0.0. Establish that
  baseline first, or the diff proves nothing.
- **The standing unmet peer** (`conventional-commits-parser` under
  `@conventional-changelog/git-client`) lives in this same tree and clears with the migration.

## Not a hold: `@types/node`

It tracks the runtime major in `.nvmrc` (and `app/.nvmrc`, and `engines.node`), so newer majors
are never offered. Moving Node itself is a separate decision covering all three files plus
`@types/node`, and it is never part of a sweep.
