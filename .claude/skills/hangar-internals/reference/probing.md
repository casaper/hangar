# Probing without touching the live fleet

Recipes for measuring how git, Claude Code, a command or an extension actually behaves, moved here
verbatim from `app/CLAUDE.md`. Each one exists because the obvious way was refused, too slow, or
ran against a working tree another agent was using.

**Probe git behaviour with a script file in the scratchpad** (`sh probe.sh`, its repo under
`mktemp -d`): a long one-line probe that creates commits is refused permission.

**Probe Claude Code permissions with `claude -p … --permission-mode acceptEdits < /dev/null`** in
a `mktemp -d` project with its own `.claude/settings.local.json` — `default` mode refuses every
write, inside the project too, so it cannot tell a rule from no rule. One measured answer: a
file-write deny is an `Edit(...)` rule, and `Write(...)` deny rules are never matched.

**Probe a command's file I/O in a throwaway hangar, never the live fleet**: a scratchpad `.ts` that
imports `test/fixture.ts`'s `syntheticHangar({ root: mkdtempSync(…), configText })` and `src/**` by
absolute path, `git init`s each `cloneAt(hangar, i).path`, and runs with `node probe.ts` from `app/`.

**Run a generated script against the live fleet without installing it**: after `pnpm golden`,
`sed 's#%HANGAR%#<root>#g' dev/golden/advisory/hangar/normalised/artifacts/<file>` into the
scratchpad and run that copy — e.g. `sh <copy> footer clone_01 <root>/clone_01` renders the real
footer before `colours sync` has been run.

**`advisory/` moves with the live fleet** (process counts, the PR cache, new commits), so prove
a change left this hangar alone by copying `dev/golden/advisory` to the scratchpad BEFORE the
edit and diffing after; only `artifacts/` and `builders/` count.

**Test a `scrub-check.sh` pattern with a canary in a TRACKED file** — it is `git grep` over the
working tree, so an untracked file is never scanned: back the file up, append the canary, run
`sh dev/scrub-check.sh`, restore it and check `git diff --quiet` before anything is committed.

**Stage part of a file without `git add -p`** (interactive, unsupported here): filter the hunks
of `git diff -U3 -- <file>` in a scratchpad script and pipe them to `git apply --cached --recount -`.

**Press a tmux key without a terminal**: give a scratch server a client from a second one
(`tmux -L pA new -d "tmux -L pB attach"`), then `tmux -L pB send-keys -K -c <client> C-b <key>`
and read the result with `tmux -L pA capture-pane -p`. Background the `send-keys` when the key
opens a popup: it blocks until the popup closes.

**A git fixture that needs `origin/HEAD`**: `git update-ref refs/remotes/origin/<b> HEAD` and
`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/<b>`, never a push (the publish
guard refuses even a scratch bare remote). Put the probe in a script file taking a fresh directory
as its argument, with no `rm`: an `rm -rf $VAR` inside `sh -c` is refused by Claude Code's own
safety check.

**VS Code's built-in keybindings**: grep
`/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`
for `mac:{primary:<n>` or `secondary:[<n>]`. `n` is the key code OR'd with the modifier:
WinCtrl 256, CtrlCmd 2048, KeyA 31 (so `ctrl+b` is 288 and `cmd+b` 2080).

**Install a VS Code extension without touching your own**:
`code --extensions-dir <scratch> --install-extension <x.vsix>`, then `--list-extensions
--show-versions` with the same flag.

**Measure a VS Code extension from its bundle**,
`~/.vscode/extensions/<publisher.name>-<ver>/dist/*.js`: slice around a match with `python3 -I`
(`s.find(…)`), because `grep -oE` refuses a `{0,300}` context. Its workspace-scoped state is SQLite
at `~/Library/Application Support/Code/User/workspaceStorage/<hash>/state.vscdb`
(`workspace.json` beside it names the workspace); open it with `sqlite3 'file:…?mode=ro'`.
**Read its runtime log before guessing**:
`~/Library/Application Support/Code/logs/<session>/window<N>/exthost/<publisher.name>/*.log`
says which repositories it opened (GitLens: `Repository found in`) and the folder every git call
ran in. Read the newest session's log, and compare its timestamps with the change and the reload.
GitLens also restores saved Search & Compare entries with the folder each was created in.
