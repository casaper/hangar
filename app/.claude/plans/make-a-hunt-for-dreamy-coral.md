# Bug hunt across `app/src/**` and `bin/*`: fix plan

## Context

The user asked for a sweep of the hangar CLI looking for small bugs, inconsistencies, dead code,
breakage that never surfaced, performance and security. Three audit passes covered three areas:
git/forge/sync, doctor/generate/tmux, and tmp/config/mcp/guard scripts. A mechanical pass added
`tsc --noUnusedLocals --noUnusedParameters` and a scan for exports that nothing imports.

What the user decided is in scope:
- every correctness and security bug;
- the dead-code and stale-comment clean-up;
- performance;
- robustness hardening;
- the publish guard: close the spellings an honest agent might type, **and** refuse the release
  paths;
- the commit gate: cover the command shapes it misses and close the branch-rename escape, but
  leave out the commit-creating verbs;
- removing `derivedPortRoles`.

The tag after each item says how it was checked:
- **V**: I read the code and confirmed it.
- **P**: an agent probed it with a real payload or in node.
- **R**: an agent reasoned it from the code. Re-read the code before fixing an R item.

## Standing tasks — keep this plan current

- [ ] After every finished task: tick its box, note deviations or deferrals, and **stage this
      file in the same commit** as the work it records. Never batch plan updates afterwards.
- [ ] Last commit: `git rm` this plan (`chore(plans): …`).

Task 0 lands first, as a commit of its own, before this plan is in git. After it,
`app/.claude/plans/` is tracked, and this file goes in with the first fix commit. That commit
records Task 0 as done.

## Ground rules

- **Fleet-live files.** Every clone's SessionEnd hook runs `tmp.ts`, `plans.ts`,
  `jira-records.ts`, `scrub.ts` and `tmp-merge-lock.ts` as soon as they are saved. Make each
  change as one complete edit, already tested.
- **The guard scripts.** For `bin/hangar-exec-guard` and `bin/hangar-commit-gate`: edit a copy
  that keeps its own name, in a scratch directory. Run `node --check` on it, probe it under a temp
  hangar root, then `mv` it into place. Both are CommonJS. `test/personal-tools.test.ts` stays
  green.
- **MCP.** Changes under `src/mcp/**` do not reach this session. Gate them on the MCP probe in
  dev.md, then ask the user to run `hangar up --restart dev`.
- **Tests.** Every behaviour fix gets a property test against its pure builder, never a
  snapshot.
- **Notes.** Every behaviour change updates the matching
  `hangar-internals/reference/*.md`. A flag change also updates
  `hangar-ops/reference/commands.md` / `command-notes.md`. Grep the key phrase across both
  CLAUDE.md files, `.claude/modes/*.md` and both skills.
- **Golden.** Write down the expected golden delta before touching a generator.
- **Commits.** One concern per commit, Conventional Commits, on `main`, no push. Every commit
  passes the gates under Verification.

## Tasks

### 0. Adopt the plan convention in this repo, as its own commit before the plan starts

Commit: `docs(modes): Track developer-mode plans as live checklists, committed with the work`.
This plan file is NOT in that commit. **Done in `3ac7841`**; 51 old plans deleted.

- [x] Delete the ~52 older untracked plans in `app/.claude/plans/`, every file except this one.
      The user chose deletion, and nothing in git refers to them.
- [x] In the root `.gitignore`, remove `/app/.claude/plans/` and rewrite its comment block to say
      what is true now: the directory is tracked, holds live plans only, and a finished plan is
      `git rm`'d. Add `app/.claude/plans/.gitkeep`.
- [x] Keep `.claude/plans/` in `app/.prettierignore`, since prettier would rewrap a plan's
      checklist, and update its comment so it no longer says "gitignored".
- [x] Add a "Plans — a live checklist, committed with the work, `git rm`'d at the end" section to
      `.claude/modes/dev.md`, with the standing-tasks block from `~/.zsh.custom/CLAUDE.md`. It
      needs two notes:
      - The plan is scanned by `pnpm scan`, so it must name no organisation and no
        `/Users/<name>` path.
      - `dev.md` is read only at startup, so the plan's own standing tasks are what carry the
        rule in a session that is already running.
- [x] `app/CLAUDE.md`'s root inventory: move `app/.claude/plans/` out of "Not tracked" and into
      "Tracked", and leave `.remember/` where it is. Grep for `app/.claude/plans` and
      `plans/ — developer-mode` across both CLAUDE.md files, `.claude/modes/*.md` and both skills
      (`modes.md`, `doctor.md`), and correct each claim that the directory is ignored.
- [x] Save a feedback memory for the convention, with its `MEMORY.md` pointer.
- [x] Gates: `pnpm format:check`, `pnpm scan` and `pnpm test`. Some tests may read the
      gitignore and the inventory.

### 1. Security

- [x] **Publish guard** (`bin/hangar-exec-guard:105-160`, V/P). Commit `fix(exec): …`.
  _Done. Only the dry-run leniency became quote-aware; detection keeps the over-matching split.
  `gh api` reads gh's effective method (explicit `-X` wins, else a field means POST). The root
  CLAUDE.md paragraph stays as it is, since it is still true and every clone pays for it._
  - Make tokenising quote-aware. Today `--title "fix -n flag"` reads as a dry run.
  - Refuse `gh pr new` and `gh api` writes to `…/pulls`.
  - Refuse `gh release create`.
  - Step over git's other value-taking globals (`--namespace`, `--config-env`, …).
  - Refuse when any `-c alias.*=` value contains `push`.
  - Refuse these without `-n`: `hangar dev release`, `cli.ts dev release`, `pnpm release`, and a
    direct `semantic-release`.
  - Update `modes.md`'s guard section and the root CLAUDE.md guard paragraph.
- [ ] **Commit gate** (`bin/hangar-commit-gate:64-142`, P). Commit `fix(commit-gate): …`.
  - Replace the `GIT_COMMIT` regex with the exec guard's token walk. Cover a pipe, `(`,
    `VAR=… git`, `env git`, `/usr/bin/git` and `--git-dir x`.
  - Match `GATE_RELEASE`/`GATE_STATE` on bare tokens, quoted `"release"` included, and on any
    path into `.hangar`.
  - Refuse `git branch -m|-M|--move` under a lock.
  - Update `root-tools.md`.
- [ ] **MCP argv injection** (`src/mcp/tools.ts:640` `argvFor`, V). Commit `fix(mcp): …`.
  - Today `doctor({clone:"--fix"})` runs `doctor --fix`.
  - Refuse a positional that starts with `-`, and emit `--` before the positionals.
  - Test this in `test/mcp-tools.test.ts`.
- [ ] **tmux footer shell injection** (`src/generate/tmux-conf.ts:360,385`, V). Commit
  `fix(terminal): …`.
  - Use `#{q:pane_current_path}` and `#{q:@hangar_clone}`, without the double quotes.
  - Probe `q:` inside `#()` on a throwaway `-L` server, with a `mkdir '$(touch pwned)'` pane.
  - Expected golden: only the `pane-border-format` lines of `clone-tmux.conf`, in both fixtures.
- [ ] **`sh -c` with config values** (R). Commit `fix(editor)` and `fix(install)`.
  - Pass `bin` as `$1` in the `command -v` probes in `editor/jetbrains.ts:89`,
    `launch-only.ts:85`, `vscode.ts:481` and `vim.ts:32`.
  - Do the same for the nvm `version` in `install.ts:245`.
- [ ] **MCP confirm and tty** (`src/mcp/server.ts:41-46`, V; `remove-clone.ts:135`, R). Commit
  `fix(mcp)`.
  - Spawn children `detached: true`, with no controlling tty, so `confirm()` really fails
    closed.
  - Make `remove-clone --delete` `confirm()` unless `--yes`.
  - Correct the header.
- [ ] **`parseRemote` HTTPS** (`src/bitbucket.ts:39`, V). Commit `fix(pr)`.
  - Use `^https:\/\/(?:[^@/]+@)?bitbucket\.org\/`.
  - Test `user@`, a URL carrying a token, and `evil.example/bitbucket.org`.

### 2. Correctness

All of these are `fix(<scope>)` commits.

- [ ] **Quoted non-ASCII paths** (V). Commit `fix(sync)`.
  - Read path lists with `-z` and NUL-split in `conflictedFiles` (`git.ts:379`), catch-up's
    restage and abort, and `resolve-conflicts.ts`.
  - `hasConflictMarkers` returns `false` only on ENOENT; any other read error counts as markers.
  - Test with `café.ts` in a real temp repo, using the env pattern from
    `store-git-fence.test.ts`.
- [ ] **A sync merge that never started reads as integrated** (`sync.ts:906-921`, V). Require
  `MERGE_HEAD` or a conflict before resolving.
- [ ] **`storeContentFrom` `$` expansion** (`jira-records.ts:415`, P). Use
  `replace(frontmatter, () => kept)` and test `$&`/`$$`. This file is fleet-live.
- [ ] **`ls-remote` tail match** (`catch-up.ts:444`, `pr-target.ts:83`, R). Use
  `refs/heads/${branch}`.
- [ ] **catch-up `--abort`/`--continue` on the wrong branch** (`catch-up.ts:86,613-629`, R).
  Refuse unless the current branch is `ledger.branch`.
- [ ] **Stored PR target checked before the fetch** (`sync.ts:181,232`, R). Re-resolve after the
  fetch.
- [ ] **sync stash handling** (`sync.ts:866-881,947-960`, R).
  - Find the stash by its label.
  - Derive "restored" from git rather than from the flag.
  - Treat a failed apply with no conflicts as a failure.
  - Stage with `-u`, not `-A` (lines 689 and 911).
- [ ] **`pr update --title` wipes the description** (`pr.ts:606,967`, V). Keep the current
  description, and test `bodyDecision`.
- [ ] **The `pr` dry run names the wrong directory** (`pr.ts:759,959`, R). Use
  `join(clone.path,'tmp')`.
- [ ] **`push` trusts a stale `origin/<branch>`** (`push.ts:60`, R). "couldn't find remote ref"
  means the branch is not on origin. A network failure refuses.
- [ ] **`pickPullRequest` "most recent"** (`pr-cache.ts:225`, `bitbucket.ts:407`, R). Send
  `sort=-updated_on`.
- [ ] **Headless `claude` by bare name** (`resolve-conflicts.ts:90`, `pr.ts:551`, R). Use
  `claudeBinary()`.
- [ ] **doctor's `plansDirectory` repair clobbers the settings repair** (`doctor.ts:576`, V).
  Re-read the file inside the repair.
- [ ] **Port keys with digits** (`clone-config.ts:1142`, V). Use `[A-Z][A-Z0-9_]*` and test
  `E2E_PORT`.
- [ ] **`clone_00` crashes every command** (`fleet.ts:37`, `palette.ts:453`, R). Skip index 0,
  and have doctor report it.
- [ ] **Bar PR refresh with no `--hangar`** (`tmux-status-sh.ts:424`, V). Add
  `--hangar <root>`. Expected golden: one line of `clone-tmux-status.sh` per fixture.
- [ ] **doctor `.env.local` checks only the ports** (`doctor.ts:262-297`, R). Compare the root key
  and `cloneEnv.vars` too.
- [ ] **Exclude repairs append the whole block** (`doctor.ts:432`, `tmp.ts:855`,
  `add-clone.ts:207`). Append only `missingExcludeLines`.
- [ ] **Hook writers drop a whole matcher** (`clone-config.ts:796,876`, R). Remove only the
  hangar hook and use the anchored `invokesOurCli`. Test with a foreign hook sharing the matcher.
- [ ] **`plans collect` races** (`plans.ts:162,209`, V at :162). Fleet-live.
  - Make the `rmSync` `force` and wrap it in a try.
  - Move without overwriting: `link` + `unlink`, taking the next free name on EEXIST.
- [ ] **`tmp merge` replaces a foreign symlink** (`tmp.ts:278,332-339`, R). Pass 2b skips any
  link that 2a classed as foreign. Fleet-live.
- [ ] **Stale-lock takeover race** (`tmp-merge-lock.ts:94`, R). Take the lock over with an atomic
  `rename`. Fleet-live.
- [ ] **`scrub --recent` is always set** (`cli.ts:322`, V).
  - Drop the `'24'` default.
  - Check that the SessionEnd hook passes `--recent`.
  - Update `command-notes.md`.
- [ ] **MCP server robustness** (`server.ts:108,250-266`, V).
  - Call `setEncoding('utf8')`.
  - Answer a non-object line or a batch with an error.
  - Make the catch null-safe.
  - Test a `null` line, a batch and a split multi-byte character.
- [ ] **`claude` shim self-exec loop** (`.local/bin/claude`, R). Resolve PATH entries with
  `pwd -P`. Work on a scratch copy and run `test/claude-shim.test.ts` against it before the `mv`.
- [ ] **`skills sync --adopt` with a subfolder** (`skills.ts:376`, R). Compare recursively and
  guard ENOTDIR.
- [ ] **`setup` hard-codes `.env.shared`** (`setup.ts:621,627`, R). Use `secrets.file`.
- [ ] **`isAlive` treats EPERM as dead** (`procs.ts:213`, R). EPERM means alive.
- [ ] **Small message bugs** (R). Derive each of these from state:
  - a declined "Sync anyway?" is counted as a failure (`sync.ts:840`);
  - catch-up hard-codes `rebased = true` (`catch-up.ts:579,600`);
  - `requireCleanForSwitch` says "default branch" for `open --branch`.

### 3. Dead code and stale text

Commits are `refactor` or `docs`.

- [ ] Remove the unused `hangar` params and fix their callers:
  - `checkout-default.ts:260,340`
  - `sync.ts:435,740`
  - `jira.ts:314`
  - `doctor.ts:232`, `reconcileHook`, which has 5 callers
  - `tmp.ts:101,567`
  - `dev.ts:128`

  Then add `noUnusedLocals` and `noUnusedParameters` to `tsconfig.json`.
- [ ] Remove `EXCLUDE_LINE` (`clone-config.ts:135`), `SymlinkSpec` (`schema.ts:968`) and
  `derivedPortRoles` (`config/derive.ts:278`).
- [ ] Fix stale comments:
  - the `EXCLUDE_LINES` "`/tmp` used to be here": rewrite it in the present tense;
  - the orphaned comment on `sleepSync` (`tmux.ts:189`);
  - `colours.ts:206`, "doctor only checks it EXISTS";
  - the `clone-colours.sh` header's `set -- $(…)`;
  - `tmux-status-sh.ts:236`.
- [ ] De-duplicate `tmp.ts`'s `isInside` against `procs.ts`, and `sleepMs` against `waitMs`.
- Keep the 176 test-only exports: they are the pure-builder convention, not dead code.

### 4. Performance

These are `perf(<scope>)` commits.

- [ ] doctor's sibling-remote checks run N² git calls (`doctor.ts:733-763`). Read each clone's
  remotes and remote config once.
- [ ] ps/lsof run per clone (`doctor.ts:1080`, `close.ts:186-197`, `open.ts:474,682`). Call
  `allClaudeSessions()`, `currentSession()` and `invokingTty()` once per run. Also stop
  `procs.ts:186` from running `ps` twice.
- [ ] catch-up's restage spawns two processes per path (`catch-up.ts:284`). Use one
  `diff --name-only -z` and one `ls-tree -r -z` instead.
- [ ] The bar's footer runs a `symbolic-ref` it never uses (`tmux-status-sh.ts:239`), and the
  statusline runs one `jq` per field (`statusline-sh.ts`). Write the golden delta first.
- [ ] `sleepSync` busy-waits; use `Atomics.wait`. `restyle` spawns tmux once per option; chain
  the commands with `\;` after a probe. `reload` sources the conf once per clone instead of once.
- [ ] doctor repeats work: `defaultBranchFromGit` (lines 1556 and 1570), `isGitRepo` (257) and
  `readSettings` (575).
- [ ] `tmp merge` runs jdupes twice (`dedupe.ts:61,91`). Measure first. Then make `scrub` filter
  by mtime before it stats or reads anything (`scrub.ts:321,370`).

### 5. Robustness hardening

- [ ] Handle a hangar root containing spaces or quotes:
  - Move one quoting helper (`shellQuote`/`sq`) into a shared module.
  - Use it in `boundHangar`, in the status-job path, and in the hook commands
    (`clone-config.ts:639,663,743,898`).
  - Also use it in `terminal-sh.ts:128`, `statusline-sh.ts` (`FLEET=` and its `sed`) and
    `clone-config.ts:196`.
  - Make the split at `doctor.ts:462` quote-aware.
  - Write the golden delta first.
- [ ] Make generated writes atomic (`generate/index.ts:63`): write a temp file in the same
  directory with its final mode, then `rename` it into place.

## Verification (every commit)

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm golden && git diff --exit-code dev/golden/gated   # only the pre-written deltas
pnpm scan                                              # the plan file is scanned too
hangar config schema --check                           # if schema.ts touched
```

- Run the MCP probe from dev.md after any `src/mcp/**` or `cli.ts` change.
- Probe the guard scripts on scratch copies with a table of payloads, both ones they must refuse
  and ones they must pass: `docker exec`, `ls -n`, `grep 'git push'`, `hangar pr create -n`.
- Read-only checks by hand: `hangar doctor` and `hangar colours sync -n | grep -v unchanged`.
- At the end, ask the user to run `hangar up --restart dev` and `hangar colours sync`.

## Not audited

- `editor/*`, beyond the `command -v` probes
- `vscode-bookmarks*.ts` and `keys-extension.ts`
- `keys.ts` and `commands/key.ts`, beyond their async paths
- `up.ts`, `down.ts` and `edit.ts`
- `platform/linux.ts`, `claude-tmux-conf.ts` and `theme-json.ts`
- the hangar-level doctor rows other than tmux, the shell hook, secrets and the default branch
