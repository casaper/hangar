# `hangar ci` — read-only CI (Jenkins) debugging for the clone agents

## Context

The user wants each clone's agent to debug pipeline failures by reading Jenkins logs over the API.
The credentials already reach every clone. The shared secrets file sets the Jenkins user and API
token, direnv loads that file through `.envrc.private`, and the
`tests/playwright-regression-tests/.env.local` symlink points at the same file. What is missing is
the knowledge and the tooling.

Instead of teaching curl recipes in prose, hangar provides a **read-only `hangar ci` command**:

- the credentials never reach an agent's command line;
- the lookup is exact: branch → PR → Bitbucket build statuses → Jenkins build URL;
- the Jenkins quirks (multibranch `%2F` encoding, `wfapi` stages, the VPN timeout) live in one
  tested place.

Each clone's `CLAUDE.local.md` gains a short section pointing at the command. Everything is config
driven, so no tracked file names the host.

Decisions made with the user:
- **Commands:** `ci status`, `ci log`, `ci tests`, `ci jobs`.
- **Output:** trimmed output goes to stdout.
- **Lookup:** Bitbucket statuses first, with no path guessing.
- **Writes:** read-only, never a POST to Jenkins.

Facts the user confirmed:
- The host is the Jenkins host listed in the clone's own subdomain list.
- Jenkins is reachable only on VPN.
- Jobs are multibranch.
- Every job posts a Bitbucket build status linking to its build.

## Design

**Config** (`src/config/schema.ts`): an optional `ci` block, `{ kind: 'jenkins', baseUrl,
userEnvKey, tokenEnvKey }`.
- `kind` is an enum, so another CI system is a new kind.
- There is no default: absent means `hangar ci` refuses and names the key, and the identity file
  says nothing. This is the `prDescriptionPrompt` pattern.
- `ci.baseUrl` joins `config/drift.ts`'s placeholder keys, making six. Update `app/CLAUDE.md`'s
  "five keys" sentence to match.

**Subcommands.** All read only, all GET. `<target>` is a clone index, a branch or a build URL and
defaults to the clone the command runs in:
- `hangar ci status [<target>]` lists one row per build status on the branch's open PR, or on its
  head commit when there is no PR. Each row is: job key/name, state, Jenkins build URL and, for a
  failure, the failing stage from `wfapi/describe`. `--json` gives data.
- `hangar ci log [<target>] [--job <name>] [--full] [--tail N] [--grep RE]`
  - It prints the failing stage's log (`execution/node/<id>/wfapi/log`) by default, the last
    200 lines with a header naming the build and stage.
  - `--full` prints `consoleText`.
  - With several failed jobs and no `--job`, it lists them and exits 2.
- `hangar ci tests [<target>] [--job]` prints the failed cases from `testReport/api/json`: suite,
  name, error message and the first stack lines.
- `hangar ci jobs [<filter>]` lists the jobs and multibranch branches from
  `api/json?tree=jobs[name,url,jobs[name,url,color]]`, for discovery only.

**Code layout**, following the repo's conventions:
- **`src/jenkins.ts`** is the client. It handles the GET with basic auth from
  `process.env[ci.userEnvKey/tokenEnvKey]` and a timeout. Its failures come back as one-sentence
  `ForgeResult`-style reasons:
  - a connect timeout or DNS failure → "Jenkins unreachable at <host>: is the VPN on?";
  - 401/403 → the credential env keys are named, never their values;
  - unset env → naming which key.

  Its pure parsers are exported: `failingStage(wfapiJson)`, `failedTests(testReportJson)`,
  `buildUrlFromStatus`, and `isOwnCiUrl(url, baseUrl)`. It only ever sends credentials to a URL
  under `ci.baseUrl`, so a status linking elsewhere is shown and never fetched.
- **`src/bitbucket.ts`** gains `buildStatuses(hangar, ref, {prId | commit})`. It returns
  `{key,name,state,url}[]`, the full shape of the existing `pullRequestCiState` query, and
  `pullRequestCiState` is rebuilt on top of it. Resolving a branch reuses `repoRef`,
  `openPullRequests` and `parseRemote`.
- **`src/commands/ci.ts`** contains the four actions. Output goes through pure builders:
  `ciStatusLines(rows)`, `ciLogHeader`, `trimLog(text, tail, grep)`. Nothing is written to disk.
- **`cli.ts`** registers the `ci` group. `ci` is not in `NEEDS_NO_CONFIG`.

**Exposure.**
- **MCP:** four `acts: false` exposures in `src/mcp/tools.ts` (`ci_status`, `ci_log`, `ci_tests`,
  `ci_jobs`), with matching `allow` rules in `.claude/modes/ops.settings.json`, held together by
  `test/mcp-tools.test.ts`. Run the MCP probe; the tool count grows by 4. The tools are frozen for
  running sessions until the user runs `hangar up --restart dev|ops`.
- **Clone permissions:** add `Bash(hangar ci:*)` to the generated clone
  `.claude/settings.local.json` allow list in `clone-config.ts`. Every `ci` subcommand is
  read-only, so the prefix rule is safe.
- **Docs:** add `hangar ci` to the root `CLAUDE.md`'s "Read freely" list.

**Identity file** (`claudeLocalMdContent`). A new exported pure section, rendered only when `ci`
is set, goes before `## Nothing about the fleet…`. It says:
- CI is Jenkins; start with `hangar ci status`, then `ci log` and `ci tests`;
- the credentials are already in your env, so never pass or echo them;
- an unreachable error means ask the user to connect the VPN, not retry;
- save anything you keep to your scratchpad, never the shared `tmp/`;
- `ci` never rebuilds, so ask the user to re-run a build.

## Checklist

- [x] 1 Schema `ci` block, drift placeholder, `app/CLAUDE.md` "six keys", example config block
      (`https://ci.example.com`), regenerate `hangar.schema.json`
- [x] 2 `bitbucket.ts` `buildStatuses`, with `pullRequestCiState` rebuilt on it
- [x] 3 `jenkins.ts` client and pure parsers
- [x] 4 `commands/ci.ts` and `cli.ts` registration
- [x] 5 MCP exposures, the ops rules and the probe
- [x] 6 Identity-file section and the clone `Bash(hangar ci:*)` allow
- [x] 7 Fixtures and golden. `dev/fixture.config.yaml` carries `ci`; `fixture-vscode` does not.
      Expected `gated/` delta, written down first:
      - `fixture`'s three `CLAUDE.local.md` gain the section;
      - all six clones' `settings.local.json` gain the allow;
      - anything else is a finding.
- [x] 8 Tests: parsers on recorded-shape JSON (multibranch `%2F`, no failing stage, a parallel
      stage), `trimLog`, `isOwnCiUrl` refusing a foreign host, the section present iff `ci`,
      `generic-text.test.ts` with a `ci` block, two-hangars isolation
- [x] 9 Docs:
      - `hangar-ops/reference/commands.md`: the rows and the tool map;
      - `command-notes.md`: VPN and exit 2;
      - `hangar-internals/reference/config.md`, or a new `ci.md`: why statuses-first,
        credential scoping and read-only;
      - root `CLAUDE.md`'s "Read freely" list;
      - `.claude/modes/ops.md` if its remit lists commands.
- [x] 10 Live config (untracked): `ci:` with the real host and `JENKINS_USER` /
      `JENKINS_API_TOKEN`, plus both in `secrets.variables[]` with `optional: true`
- [ ] 11 Commits on `main`:
      - `refactor(pr)` for `buildStatuses`;
      - `feat(ci)` for the command, exposure and identity section;
      - `docs(skills)`;
      - finally `git rm` this plan.

No tracked file names the host or the company domain; use `example.com` / `acme`.

## Deviations

- The Jenkins pair is DERIVED by `hangarOwnSecretVariables` from `ci.*EnvKey`, not declared in
  `secrets.variables[]`. The live config has only the `ci` block.
- The golden delta also includes `settings-default.json`, the `defaultSettings` twin of the same
  allow; nothing else changed.
- `buildStatuses` ships in the `feat(ci)` commit rather than a separate `refactor(pr)` one, because
  it shares a file with the `sharedEnvValue` export the client needs.
- The section names the repo's secrets symlink from `repo.symlinks[]`, and says "usually a VPN"
  rather than "VPN only": both keep the builder generic.
- `ops.settings.json` also allows `Bash(hangar ci)` / `Bash(hangar ci:*)`.
- `ops.md` has a playbook row. `hangar-internals/reference/ci.md` is new and indexed in `SKILL.md`.

## Standing tasks — keep this plan current
- [ ] After every finished task: tick its box, note deviations or deferrals, and **stage this
      file in the same commit** as the work it records. Never batch plan updates afterwards.
- [ ] Last commit: `git rm` this plan.

## Verification

- Gates: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`,
  `pnpm golden && git diff --exit-code dev/golden/gated` (after the enumerated delta), `pnpm scan`,
  `hangar config schema --check`, `hangar config validate` and the MCP probe.
- I run `hangar ci status 1` (and the other subcommands) only with the user's go-ahead, because it
  sends their Jenkins credentials. The no-config refusal and the unset-env message can be tried
  against a throwaway hangar.
- **The user runs:**
  - `hangar ci status <n>` / `ci log <n>` on a clone with a red PR, on VPN, and once off VPN for
    the unreachable message;
  - `hangar doctor --fix` to rewrite every clone's `CLAUDE.local.md` and `settings.local.json`;
  - `hangar reload` or a restart so live sessions read them;
  - `hangar up --restart ops` and `hangar up --restart dev` for the new MCP tools.
