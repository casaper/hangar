import { DEFAULT_BITBUCKET_TOKEN_ENV_KEY } from './bitbucket.ts';
import type { SecretVariable } from './config/schema.ts';

/**
 * What the shared secrets file is missing, as a PURE function of the declaration and the text.
 *
 * The gap this closes: `secrets` used to be `file` + `mode` and nothing else, so a hangar could
 * say WHERE the credentials live and never what has to be in them. `setup` scaffolded the two
 * or three names Hangar itself uses (`forge.tokenEnvKey`, the tracker pair) and stopped, because
 * those are the only ones it can derive -- everything the REPO's own tooling reads is invisible
 * from up here.
 *
 * That is not a hypothetical. This fleet's Playwright suite reads `USER_READWRITE_PASSWORD`; the
 * tracked `tests/playwright-regression-tests/.env` sets it EMPTY and direnv loads it after the
 * shared secrets, which is the entire reason `repo.symlinks[]` reloads them and the entire
 * content of that symlink's `why`. But nothing ever told a NEW hangar to put the variable in the
 * file. So a colleague's first fleet came up with the symlink created, `doctor` green, and
 * Playwright logging in with an empty password -- the exact failure the symlink exists to
 * prevent, reproduced by leaving the declaration out.
 *
 * Pure, and takes the file's TEXT rather than a path, for the reason every builder here does:
 * every state can be asserted without a secrets file on disk, which is also the only way to test
 * this at all -- the real one is mode 600 and full of live credentials.
 */

/**
 * `empty` is a distinct state from `absent`, and the distinction is the whole reason `setup`
 * writes its scaffold commented out.
 *
 * A set-but-empty variable is indistinguishable from a real one to everything downstream: an
 * empty `BITBUCKET_TOKEN` makes `sync` send an empty bearer token and report a 401, and an empty
 * `USER_READWRITE_PASSWORD` makes Playwright fail a login rather than say it was never given
 * one. So an empty value is reported as its own, worse thing -- never folded in with "missing".
 */
export type SecretVariableState = 'set' | 'empty' | 'absent';

export type SecretVariableStatus = {
  readonly name: string;
  readonly why: string;
  readonly optional: boolean;
  readonly state: SecretVariableState;
};

/**
 * Whether one name has a value in dotenv text.
 *
 * Deliberately narrow: an assignment at the start of a line, optionally `export`-prefixed, not
 * commented out. A commented line is how `setup` writes the scaffold, so treating `# NAME=` as
 * an assignment would report every untouched scaffold as configured.
 *
 * The VALUE never leaves this function. Callers get a three-state enum, so no report, log or
 * golden capture can grow a credential in it by accident.
 */
const stateOf = (name: string, text: string): SecretVariableState => {
  const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=(.*)$`, 'm').exec(text);
  if (line === null) return 'absent';
  const raw = (line[1] ?? '').trim();
  const unquoted = /^(['"])(.*)\1$/.exec(raw);
  return (unquoted?.[2] ?? raw) === '' ? 'empty' : 'set';
};

/**
 * One status per DECLARED variable, in declaration order.
 *
 * `undefined` text means the file is not there, which makes every declared variable `absent` --
 * the same answer as a file that exists and does not mention it, because it is the same problem
 * for the reader. Whether the file itself is missing is a separate `doctor` row that already
 * exists; this one is about the contents.
 */
export const secretVariableStatuses = (
  declared: readonly SecretVariable[],
  text: string | undefined,
): readonly SecretVariableStatus[] =>
  declared.map((v) => ({
    name: v.name,
    why: v.why,
    optional: v.optional,
    state: text === undefined ? 'absent' : stateOf(v.name, text),
  }));

/**
 * The line `doctor` prints for one status, or `undefined` when there is nothing to say.
 *
 * A builder rather than a `console.log` in `doctor`, per this package's first convention: every
 * variant can be printed side by side without a secrets file, which is how the `empty` wording
 * was checked against the `absent` wording.
 */
export const secretVariableProblem = (s: SecretVariableStatus): string | undefined => {
  if (s.state === 'set') return undefined;
  const what =
    s.state === 'empty'
      ? `${s.name} is set but EMPTY in the secrets file, which reads as configured to everything downstream`
      : `${s.name} is not set in the secrets file`;
  return `${what} — ${s.why}`;
};

/**
 * The credentials HANGAR ITSELF needs, derived from the config rather than declared.
 *
 * `secrets.variables[]` is for what the REPO's tooling reads, which is invisible from up here.
 * These three are the opposite case: the config already says the forge is Bitbucket and the
 * tracker is Jira, so what has to be in the secrets file follows, and asking every hangar to
 * write it down again is asking them to restate their own config.
 *
 * That gap was not theoretical. This fleet declared exactly one variable -- the Playwright
 * password -- so `doctor` was silent about the Bitbucket token and the Atlassian pair, which are
 * three of the four credentials it actually needs. `sync` names its missing token at the point
 * of use; nothing named the other two at all, and a colleague copying this hangar's committed
 * example config inherited that silence along with it.
 *
 * Takes the three facts and not a `HangarConfig`, so `setup` -- which is answering questions and
 * has no config yet -- reaches the same list as `doctor`, and the scaffold `setup` writes cannot
 * drift from the rows `doctor` prints against it.
 *
 * `optional: true` on all three, deliberately. Each degrades rather than breaks: no forge token
 * makes `sync` guess the target branch and SAY it guessed, and no tracker credentials make a
 * ticket fetch fail where the person who ran it is watching. A hangar whose owner never syncs
 * must not have a permanently red `doctor` -- a check that is red in normal operation is a check
 * nobody reads.
 */
export const hangarOwnSecretVariables = (facts: {
  readonly forgeKind: 'bitbucketCloud' | 'none';
  /** `forge.tokenEnvKey`. Optional in the schema, so the adapter's own default stands in. */
  readonly forgeTokenEnvKey: string | undefined;
  readonly trackerKind: 'jira' | 'none';
}): readonly SecretVariable[] => [
  ...(facts.forgeKind === 'bitbucketCloud'
    ? [
        {
          name: facts.forgeTokenEnvKey ?? DEFAULT_BITBUCKET_TOKEN_ENV_KEY,
          why: 'lets `sync` ask Bitbucket which branch a pull request targets; without it the target is a guess. An ACCESS TOKEN (repo/project/workspace, `pullrequest:read`) — the adapter sends `Authorization: Bearer`, which an App Password cannot satisfy',
          optional: true,
        },
      ]
    : []),
  ...(facts.trackerKind === 'jira'
    ? [
        {
          name: 'ATLASSIAN_USER_EMAIL',
          why: 'the account the Jira API authenticates as; a ticket fetch fails without it',
          optional: true,
        },
        {
          name: 'ATLASSIAN_API_TOKEN',
          why: 'the Jira API token; a ticket fetch fails without it. Made at id.atlassian.com/manage-profile/security/api-tokens, paired with the email above',
          optional: true,
        },
      ]
    : []),
];

/**
 * The full list `doctor` reports and `setup` scaffolds: derived first, then declared.
 *
 * A declared entry with the same NAME wins outright. That is the escape hatch for the two
 * judgements the derivation makes for you -- the `why` and `optional` -- so a hangar that cannot
 * work without its forge token can declare it `optional: false` and get a red row.
 */
export const expectedSecretVariables = (
  derived: readonly SecretVariable[],
  declared: readonly SecretVariable[],
): readonly SecretVariable[] => {
  const overridden = new Set(declared.map((v) => v.name));
  return [...derived.filter((v) => !overridden.has(v.name)), ...declared];
};
