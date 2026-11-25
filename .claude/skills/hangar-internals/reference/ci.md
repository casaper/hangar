# `hangar ci` — reading CI for a clone's agent

`hangar ci` exists so the agent in a clone can answer "why did the pipeline fail?" without the
user pasting a log in. The credentials were already in every clone: the shared secrets file sets
them, and direnv exports them. What the agent lacked was a way to use them that does not put a
token on a command line or a guessed URL in a request. So the command is built around three
decisions.

## The forge's build statuses are the way in, never a job path

Every Jenkins job posts a build status on the commit it built, with a link to the build. So
branch → open pull request → `/pullrequests/{id}/statuses` names **the builds of the commit under
review**. A branch with no pull request falls back to `/commit/{sha}/statuses` on the commit
origin has for it.

A multibranch path built from the branch name (`job/<job>/job/<branch%252F…>/lastBuild/`) looks
equivalent and is not. It names the latest build of the branch, which after a push is a build of
a different commit, or one still queued. It also needs the job name, which nothing local knows.
`ci jobs` lists the paths for a human to look at, and nothing resolves a build through them.

`buildStatuses` in `bitbucket.ts` is the one statuses reader. `pullRequestCiState`, the bar's
one-character answer, is built on it, so the bar and `ci status` cannot disagree about which
statuses a pull request has.

## Credentials go to `ci.baseUrl` and nowhere else

A status URL is written by whatever posted the status, and a build URL can be an argument the
agent typed. `jenkinsGet` refuses any URL not under `ci.baseUrl`, before a request exists:
- the origin must match;
- the path must be under the base path, compared with a trailing `/` so that
  `/jenkinsevil` is not under `/jenkins`.

`ci status` shows a foreign link as one; `log` and `tests` refuse it. The basic-auth header is
built in that one function, after the check, which makes it the only place a credential and a URL
meet.

The credentials are named in config (`ci.userEnvKey`, `ci.tokenEnvKey`), never held. They are
read from the environment, then from the shared secrets file, exactly as `forge.tokenEnvKey` is.
That lets `hangar ci` work from the hangar root, whose shell has no direnv, and it is why the
identity file tells the agent never to read or echo them. The file is denied to a clone session
anyway. `hangarOwnSecretVariables` derives both as `doctor` rows, so a hangar with a `ci` block
is told when one is unset without declaring them in `secrets.variables`.

## Read only, which is what lets a clone run it unprompted

Every request is a GET, and no flag reaches a write: no rebuild, replay, abort or input step. That
one property carries three exposures:
- the generated clone settings allow `Bash(hangar ci:*)` as a prefix;
- the MCP tools are reports;
- the identity file can say "read it yourself" without a permission prompt arguing with it.

A `ci rebuild` would have to be a separate, user-only command with its own `ask` rule and a guard
entry, and must never be a flag here.

## Why the default log is the failed step, not the console

A pipeline's console is mostly dependency installs, often tens of thousands of lines, and the
failure is in one step. Stage View's `wfapi/describe` names the stages; `badStages` takes the
`FAILED` ones. When a stage fails, the later stages report `ABORTED` or `NOT_EXECUTED` as a
consequence, so those count only when nothing `FAILED`. A stage's own `wfapi/describe` names its
steps, and each failed step's `wfapi/log` is the text worth reading.

That log arrives as console HTML, which `consoleHtmlToText` strips. A server without Stage View,
or a build with no stage marked bad, falls back to the tail of `consoleText`, and says so.

## The identity-file section and the absent block

`ci` is optional with no default, on the `forge.prDescriptionPrompt` precedent: where a repo's CI
runs is a property of the repo, and a default would put one organisation's server into every
hangar. `ci.baseUrl` is therefore one of the site-local keys `config/drift.ts` does not compare
between the example and the live config.

`ciSection` in `clone-config.ts` renders only with a `ci` block. It names the env keys from
config and any `repo.symlinks[]` entry that points at `{secretsFile}`, because that link is where
a person would tell the agent the credentials are. The repo's path is never written into the
builder. `generic-text.test.ts` renders the section against a foreign config to hold that.

## Not verified here

The suite has no Jenkins, and none of the Jenkins JSON parsers' inputs were recorded from a real
server. They follow the documented shapes of:
- Stage View's `wfapi`;
- `testReport/api/json`;
- `api/json?tree=jobs[…]`.

The first real run against a server is the user's smoke test. When one of them comes back in a
different shape, record what was measured here.
