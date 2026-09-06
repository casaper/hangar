/**
 * Reading the commits in a release range -- the one thing `hangar dev release` decides for
 * itself, kept pure so `test/release-commits.test.ts` can assert it without a repository.
 *
 * **It deliberately does not work out a version.** semantic-release does that, from
 * `.releaserc.json`, and a second implementation here would be two tables that must agree --
 * exactly the drift this repo keeps finding. What is here is a POLICY gate instead: the release
 * refuses to start when the range carries a breaking marker while the CLI is 0.x. That is a
 * question semantic-release has no setting for.
 */

export type RawCommit = {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
};

export type ParsedCommit = RawCommit & {
  /** `undefined` when the subject is not a Conventional Commit at all. */
  readonly type: string | undefined;
  readonly scope: string | undefined;
  readonly breaking: boolean;
  /** The subject with its `type(scope):` prefix removed, or the whole subject if it had none. */
  readonly summary: string;
};

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<subject>.*)$/;

/**
 * `BREAKING CHANGE:` or `BREAKING-CHANGE:`, both of which the Conventional Commits spec accepts
 * and both of which semantic-release's parser honours.
 */
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

/**
 * Read the type, scope and breaking marker out of one commit.
 *
 * A subject that does not parse is not an error here: `commitlint` refuses those, and it runs
 * over the same range before this is ever reached.
 */
export const parseCommit = (raw: RawCommit): ParsedCommit => {
  const groups = HEADER.exec(raw.subject)?.groups;
  const scope = groups?.['scope'];

  return {
    ...raw,
    type: groups?.['type'],
    scope: scope === undefined || scope === '' ? undefined : scope,
    breaking: groups?.['bang'] === '!' || BREAKING_FOOTER.test(raw.body),
    summary: groups?.['subject'] ?? raw.subject,
  };
};

export const breakingCommits = (commits: readonly ParsedCommit[]): ParsedCommit[] =>
  commits.filter((c) => c.breaking);
