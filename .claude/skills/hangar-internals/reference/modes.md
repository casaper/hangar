# Launch modes — `hangar claude`

Two ways to start Claude Code in this hangar, differing in the instructions and the permission
rules they load. **One command opens both**: `hangar claude` puts operator in tmux window 1 and
developer in window 2 of one session, on a socket of its own, and attaches the terminal it was
typed in. `-m dev` selects the other tab. From the hangar root a bare `claude` reaches it, through
`.local/bin/claude`.

`src/commands/claude.ts` is the command and `.claude/modes/` holds the four files it names, plus
`statusline.sh`.

## What they are for

The hangar's `CLAUDE.md` serves **three** audiences — clone sessions, hangar-root operators,
hangar-root developers — and each now has its own document. What documents cannot do is tell a
*session* which audience it belongs to: both hangar-root modes get an identical context otherwise,
because the ancestor walk does not know why the session was started.

**The single most useful line in either mode file is "you are not in a clone."** The root
`CLAUDE.md` is addressed to clone sessions and says *"A session belongs to exactly one clone"* and
*"never write, edit, stage, commit, checkout, stash or reset anything outside your own clone"*. A
hangar-root session belongs to none of them and acting across all of them is its whole job. Nothing
else in the fleet tells it so, and it is the same class of failure the clone colours exist to
prevent — a session that does not know which context it is in.

## Why it is a composed launch profile and not one switch

There is no mode feature. Each mode is `--settings <file>` plus `--append-system-prompt-file
<file>` plus `-n <name>`, and for `dev` a working directory of `app/` so that `app/CLAUDE.md` is
loaded from the first turn instead of lazily on first read beneath it.

**`claudeArgvFor` puts those three AHEAD of anything passed through, and that ordering is the
whole of what resuming into a mode is.** `hangar claude --resume <id> -m ops` reaches claude as
`--settings … --append-system-prompt-file … -n … --resume <id>`; reversed, the session resumes
with the badge of a mode whose rules it does not have. It was a comment for as long as the
launchers existed and is now a pure builder with a test on it, because it is the one property
here whose failure looks exactly like success.

`-n` is not decoration: it puts the mode in the prompt box, the terminal title and the `/resume`
picker. Two near-identical hangar-root windows is the same problem as two near-identical clone
windows, and the answer is the same — make it visible.

**Both modes load the root `CLAUDE.md`, and that cannot be helped.** Two flags suppress it and
neither is usable:

- **`--bare`** skips CLAUDE.md discovery *and* makes auth strictly `ANTHROPIC_API_KEY` or
  `apiKeyHelper`, with OAuth and the keychain never read. This machine logs in with a subscription,
  so a `--bare` session cannot start.
- **`--safe-mode`** also disables CLAUDE.md, and disables skills, plugins, hooks and MCP with it —
  including the one skill operator mode exists to use.

`--disable-slash-commands` is likewise all-or-nothing on skills. So each mode file **corrects** the
fleet map rather than replacing it. The cwd cannot leave the hangar either: `hangar` finds its
config by walking up from the working directory, and `--hangar <path>` is honoured only by
`config show|validate`.

**One consequence worth knowing: `--append-system-prompt-file` turns the system-prompt snapshot
off**, so the remit is re-applied on every launch instead of being frozen into the conversation.
That is what makes resuming into a mode possible at all. A bare `claude --resume` of the same
session resumes with no mode, which is the trap — it looks identical and has none of the rules.

## Why a bare `claude` is a PATH shim, and why it needs its own directory

**There is no such thing as a direnv alias.** direnv exports the **environment diff** that
evaluating a `.envrc` produces, and a shell function is not an environment variable — so a
function defined in `.envrc.hangar` never reaches the interactive shell. The tell is that the
file's own long-standing helpers behave the same way: inside this hangar,
`direnv exec . zsh -c 'type hangar_use_node'` answers **not found**. They work only because
`.envrc` *calls* them while direnv is still evaluating the file, which is the one thing a
user-facing command cannot do.

`PATH` *is* an environment variable, so `PATH_add` genuinely reaches the shell — which makes a
file on PATH the only mechanism that works without editing someone's `~/.zshrc`. It also gets
`bin/hangar`'s per-hangar scoping for free: the `claude` on PATH belongs to the hangar you are
standing in.

**But it must not be in `bin/`, and that is measured rather than cautious.** Every clone's own
`.envrc.private` carries `PATH_add <hangar>/bin` — it has to, that is how `hangar` is reached from
inside a clone — and repeats nothing else. So `bin/claude` would have been on PATH in every clone
shell too, where `terminal.tabs[]`'s schema default `command: 'claude'` is the line that starts
each clone's own Claude Code session. Every clone window would have launched the hangar-root pair
instead of itself. `.local/bin` gets a second `PATH_add` in the hangar's `.envrc` alone, which no
clone repeats, so in a clone the shim is not on the path at all — nothing to guard, and nothing to
keep in step with a `$PWD` check.

**The proxy still tests where it was typed, and that is not redundant.** A tmux SERVER inherits
the environment of whatever started it, and `hangar open` is normally typed at the hangar root —
so, measured, a clone window's `command: 'claude'` resolved to the shim from a `$PWD` inside the
clone, and reached a `hangar claude` that refuses from inside a clone. The clone's session would
not have started. Nothing in the clone put the directory on PATH; an ancestor process did, which
is exactly what the directory split cannot see. So the shim runs the pair only when it was typed
AT the hangar root, and hands to the real binary everywhere else.

**`pwd -P`, never `$PWD`.** `$PWD` is a shell variable and is inherited, so a non-interactive
shell that never `cd`'d carries whatever its parent had — which made an early version of the shim
answer for a directory the caller was not standing in. `pwd` asks the OS, and `-P` resolves
symlinks on both sides so a hangar reached through a link still compares equal.

**The recursion is cut on both sides.** The shim skips its own directory when it resolves the real
binary, and `resolveClaudeBinary` skips the same directory when `hangar claude` looks for one —
verified with `.local/bin` FIRST on PATH, where it answers the real binary and not the shim. The
tmux window command names claude by absolute path for the same reason, which is the rule
`attachCommand` already follows for tmux itself.

**Editing `.envrc` revokes direnv's trust**, so `direnv allow` is a one-time step after pulling a
change to it — and until it is run the hangar shell has no `hangar` either, because `PATH_add bin`
is in the same file.

## One session, two windows, and a socket of its own

`tmux -L hangar-<id>-claude`, not a session on the clone socket. Every session on that one is
expected to name a clone: `staleSessions` walks it for sessions whose `@hangar_clone` matches no
live clone, and two mode sessions — carrying the conf's global `@hangar_id` and no
`@hangar_clone` — are exactly the shape `src/tmux.ts` calls *foreign*. `doctor` would report them
stale for ever, which is the check nobody reads. It also keeps `tmux -L hangar-<id> ls` meaning
precisely "the clones". The names are distinct by exact equality, which is all the comparison in
`currentSession` does.

`.hangar/claude-tmux.conf` is the config, rewritten by `hangar claude` every run immediately
before the server starts. That is why it gets no `doctor` row and no `.gitignore` line, unlike
`clone-tmux.conf`: `colours sync` writes that one and nothing else would notice it going stale,
whereas this one cannot be stale. Its bar options are a table with two consumers — rendered into
the conf, and written with `set -g` onto a server already running — the same split
`clone-tmux.conf` and `TmuxServer.restyle` live on, and possible because every one of them is a
global *session* option rather than a server option.

**The pair is a singleton, and tmux does most of the work.** A window whose command exits is
closed by tmux, so a tab whose claude you `/exit` is simply gone and the next run recreates it —
which is also the moment passed-through arguments have somewhere to go. `renumber-windows off`
is what keeps operator at index 1 when developer's window closes; with it on, the tabs would swap
places for no reason a reader could see. Arguments aimed at a tab that is still live cannot be
honoured at all, so they refuse rather than attach to a session the caller did not name;
`--replace` reaches that cell by ending the tab's claude and asks first through `confirm`, which
fails closed with no terminal. And attaching uses `-d`, because two clients on one session mirror
each other's window selection — switching tabs in one moves the other, which reads as the bar
changing by itself.

## The header, and the width budget that shapes it

tmux reserves `status-left-length` and `status-right-length` first and gives the window list
whatever remains. So `status-left` is empty with a length of 0: the whole width goes to the tabs,
which is where the text saying what each session is FOR lives. Only the CURRENT tab carries that
text, on a block of its mode's hue; the other shows its bare name. Measured on tmux 3.7c:

    operator current    ` ops · run the fleet  dev `        26 columns
    developer current   ` ops  dev · change the CLI `        27 columns

against `columns - 3` given to the list, so the worst case fits exactly at a 30-column terminal.
`status` is `on` and not `2`, which is what keeps it one line — tmux truncates a status line
rather than wrapping it, so "never two lines" is a property of that one setting.

The hue is baked into each window's own `window-status-current-format` rather than read from a
user option inside the `#[…]` style spec: a per-window format with the value already in it is what
`clone-terminal.sh` does and is known to work. The purpose text stays a user option
(`@hangar_purpose`), which expands inside a format perfectly well.

`MODE_COLOURS` in `src/palette.ts` holds the two hues — ops `#1f6feb`, dev `#b35400` — with ink
from the same `inkFor` the clone hues use: white on both, at 4.63:1 and 5.02:1. **They are a
hand-maintained duplicate of `statusline.sh`'s own two triples**, named here rather than left to
be discovered. That file cannot source them: it is one of the hand-maintained mode files, derived
from nothing under `app/src/**`, deliberately, because it must render a badge when everything else
is broken. Change one, change both.

## Two guards on the escalation, and only one is a permission list

`hangar claude` passes its arguments through, so an operator session could otherwise run
`hangar claude -m dev -p '…'` — or `--dangerously-skip-permissions` — and get a session running
under `dev.settings.json`, with everything developer mode may do including writes to `app/**`.
The pre-existing `Bash(hangar dev)` denial does not match a `claude` subcommand.

- **`ops.settings.json` denies `Bash(hangar claude)` and `Bash(hangar claude:*)`.**
- **The command refuses when `$CLAUDECODE` is set**, which no editable file can turn off. That
  variable is set in every tool subprocess — measured alongside `CLAUDE_CODE_ENTRYPOINT` and
  `CLAUDE_CODE_SESSION_ID`, and unlike `$CLAUDE_PROJECT_DIR`, which is injected per hook. There is
  no legitimate call from inside a session anyway: attaching a tmux client needs a terminal.

A third refusal is about intent rather than privilege: `hangar claude` stops when the working
directory is inside a clone, because `hangar` itself is on a clone's PATH by design. A dry run
runs ahead of all three, because it creates nothing and attaches nothing, so none of them has
anything to protect.

## Which mode you are in shows in the status line

`-n "hangar <mode>"` puts the mode in the prompt box, the terminal title and the `/resume` picker,
and that is not enough: two hangar-root windows look identical, which is the same failure the
clone colours exist to prevent, one directory up. So `.claude/modes/statusline.sh` paints a badge —
blue `OPS`, amber `DEV`, red `NO MODE` — then the hangar and where in it the session stands
(`dvb_gn`, `dvb_gn/app`), then the model.

**It reads the mode from three independent channels, and that is the design rather than
belt-and-braces.** Three things about how `--settings` composes cannot be established from outside
an interactive session: whether it carries non-permission keys such as `statusLine` at all,
whether it outranks the project's own `.claude/settings.json`, and whether the status-line
subprocess inherits the launcher's environment. Rather than probe them — the last section of this
file is what probing that class of question produced — all three are wired at once:

| Channel | Set by | Covers |
| --- | --- | --- |
| `$1` | the mode's own `statusLine` argv, via `--settings` | authoritative whenever it arrives |
| `$HANGAR_MODE` | `new-window -e` per window, from `hangar claude` | the argv-less entry in the root `.claude/settings.json` winning instead |
| neither | — | a red `NO MODE` badge |

Any one channel working shows the right badge; all three failing shows a **red warning rather than
a confident wrong answer**. That makes the confirming observation a cheap one: a freshly launched
`hangar claude` window reading `OPS` validates the entire chain, whichever channel carried it.

Three implementation rules, each the opposite of the obvious version:

- **`$HANGAR_MODE` is set by `hangar claude` and nowhere else, one window at a time.** Exported
  from `.envrc` or `.envrc.hangar` it would reach every shell in the hangar, and a bare `claude`
  would then wear a badge whose rules it does not have — at which point `NO MODE` stops meaning
  anything. Per WINDOW rather than per session for a second measured reason: on tmux 3.7c a window
  created without its own `-e` inherits the session's value, so the developer tab would badge
  itself `OPS`.
- **The badge sets an explicit background** (`48;2;r;g;b`, white bold on top), never `\033[7m`.
  Reverse video inverts against each window's own theme, so the badge would come out a different
  colour per terminal — the exact ambiguity it is there to remove. The WORD survives a terminal
  that drops the colour entirely.
- **The hangar root is resolved from `$0`, not baked in.** The nearest precedent is the wrong
  model to copy: `~/.claude/<id>-clone-statusline.sh` may hardcode the hangar root because
  `hangar colours sync` GENERATES it, and it derives a *clone* from the payload's directory. This
  one is hand-maintained and derives a *mode*. It does keep that script's never-fail contract —
  no sourcing of anything that may be missing, and jq optional, because the badge is the half that
  must render unconditionally.

**The body is plain POSIX even though the shebang is bash, and that is not fastidiousness — three
bashisms were tried and each one broke a real shell.** `set -o pipefail` makes dash abort the whole
script with *Illegal option*, so nothing renders. `${BASH_SOURCE[0]}` is a *Bad substitution* in
dash, and in zsh it is simply unset — which is worse than an error, because `set -u` there prints
one line of noise and the badge still appears, with the location silently wrong. `$'\033'` comes
out as a literal `$[`. None of the three was needed: no pipeline here depends on `pipefail`, `$0`
is the script's path under every invocation except a `source` (not a status-line path), and ESC is
one `printf`. Verified byte-identical output under bash, zsh, sh and dash. **A file whose header
promises it never fails has to hold when something other than bash runs it**, and the shebang only
covers the direct-exec path — not `sh <path>`, which is how a command string can reach it.

The `statusLine` command is an **absolute** path in all three settings files, which is the same
thing `autoMemoryDirectory` in the tracked root `.claude/settings.json` already does. A relative
one could not work anyway: developer mode's working directory is `app/`, so the two modes would
need different relative paths to one script.

**One case this gets wrong, bounded and written down rather than engineered around:** a nested
interactive `claude` started from inside an ops session inherits `HANGAR_MODE=ops` and badges
itself `OPS` while carrying none of operator mode's rules. Same class as the resume trap above.
The CLI's own nested launches are unaffected — `resolve-conflicts.ts` is headless, and
`teach-rg.ts` runs inside a clone, where the clone's own statusline applies.

## The boundary is a guardrail, not a sandbox — say so

Operator mode denies `Edit`/`Write` under `app/**`, `.claude/skills/**` and `.claude/modes/**`.
That last one is the load-bearing entry: **the session cannot rewrite the remit it was launched
with.** Reads are deliberately left open, so "why does `sync` ask Bitbucket for the target branch?"
is answered by reading `reference/sync.md` rather than by declining to look.

**Deny paths are spelled `Edit(...)`, and a `Write(...)` path rule is silently inert.** The first
version of `ops.settings.json` paired every `Edit(./app/**)` with a `Write(./app/**)`, on the
assumption that the two tools needed separate entries. Claude Code prints a warning at startup and
ignores the Write rules: *"Write(./app/**) is not matched by file permission checks — only
Edit(path) rules are. Use Edit(./app/**) instead (Edit rules cover all file-editing tools)."* One
`Edit(path)` covers Write, Edit and every other file-editing tool. The warning only appears when a
settings file is actually read, which is the cheapest confirmation available that a mode's rules
loaded at all.

What that does **not** buy, and what must not be claimed for it:

- `Bash` is available, so a deny on `Edit`/`Write` is not a deny on `sed -i`. The guarantee covers
  what *loads* and what the permission layer *refuses to write*, not what is reachable.
- Instructions and permission **rules** are fixed at launch; the permission **mode** is not —
  Shift+Tab still cycles it, and `disableBypassPermissionsMode` binds only through managed
  settings, which this machine does not use.

**`hangar doctor` is deliberately absent from operator mode's `allow` list** and sits in `ask`
instead, even though a bare `doctor` only reports. `doctor` and `doctor --fix` differ by one flag,
and the `hangar-ops` skill's `reference/settings-layering.md` records the reason this hangar carries
no permission allowlist at all: a Bash pattern that pre-approves the report may pre-approve the
writer. Until that is actually verified (see below), the `allow` list contains only commands whose
prefix cannot widen into something that acts.

## The mode files are hand-maintained, not generated

They sit beside `bin/hangar`, `.envrc.hangar` and the `.nvmrc` pair as hangar-root files this
package owns by hand. So they add **no** row to `app/CLAUDE.md`'s derivation table and need no
`--check` gate: nothing derives them from `app/src/**`, and the "compare generated content, never
presence" rule in `reference/doctor.md` does not apply. A `doctor` row for them should check that
the five files exist, that the two JSON files parse, and that `statusline.sh` is executable —
presence and validity, never content — and that is the deliberate exception, stated out loud.

## Why the mode settings are the one generated-file candidate that stays tracked

Publication forced the question for every tracked file naming one machine's home directory, and
these two answered differently from the rest. `.claude/settings.json` became generated and gitignored;
`.claude/modes/{ops,dev}.settings.json` did not.

The reason is an escalation path, not tidiness. `ops.settings.json`'s ~40 `allow`/`ask`/`deny`
entries **are** operator mode's boundary. Operator mode is denied `Edit(./.claude/modes/**)` —
that denial is the whole reason the mode pair exists — and it is *allowed* `Bash(hangar doctor:*)`.
So a `doctor --fix` that generated that file would let operator mode rewrite its own permission
list through a command it is permitted to run, and the asymmetry this file spends its length
justifying would be gone. `setup` is no better: it is not in operator mode's deny list either,
only unlisted, so `hangar setup --force` reaches it behind one prompt about "hangar setup".

So `doctor` **reports and offers no repair**, the same shape as the `settings targets` check for
an unresolvable theme.

### The one machine-specific line, and how it stopped being one

`statusLine.command` used to be an absolute path into this hangar, and a fresh clone of a published
hangar carried the previous owner's home directory. Claude Code fails silently on it, exactly as it
does on an unresolvable theme: the badge simply never appears, and a session with no badge is a
session whose permission rules nobody can see at a glance. The fix was a hand edit — which then sat
as a permanent modification in `git status` and conflicted on every pull, in the two files nobody
should resolve a conflict in carelessly.

It is now **`hangar-statusline <mode>`**, resolved on PATH, and both files are byte-identical on
every machine. `bin/hangar-statusline` resolves the hangar root from its own location and execs
`.claude/modes/statusline.sh` — the rule `bin/hangar` already follows.

**Why a name on PATH is sound here and still refused for the clone hooks.** That was the third
rejected alternative below, on the grounds that it depends on direnv having loaded. It does — but
here that dependency is *entailed rather than assumed*: `bin/hangar-statusline` is on PATH for
exactly the same reason `bin/hangar` is, namely direnv's `PATH_add bin`. A session running in a
mode was started by a `hangar` found that way, so a mode existing at all is proof direnv loaded. A
clone's `SessionStart` hook has no such guarantee — it runs with an unpredictable PATH — which is
why `bin/hangar --hangar <root>` stays absolute there. The two cases only looked alike.

`doctor` now checks that the command is the expected string and that `bin/hangar-statusline` is
present and executable in this hangar, which is what a partial checkout or a lost permission bit
looks like. It still offers no `--fix`, for the escalation reason above.

**One probe that supports it, stopping short of proof.** A Bash tool subprocess of a session in
the developer tab has `bin/` on its PATH — `command -v hangar-statusline` answers, the script
runs, and the DEV badge renders — and it also carries `HANGAR_MODE=dev`, which only
`hangar claude` sets. So the launching shell's environment does reach children of the Claude Code
process, which is the assumption the PATH lookup rests on. It reaches them through the tmux
server, which inherits the environment of the shell that started it, so `PATH_add bin` is in
force there for the same reason it is at the prompt. What it does not prove is that the
STATUS LINE subprocess is spawned the same way; Claude Code could sanitise the environment for that
one path specifically. Treat it as strong evidence, not a verification — the verification is
launching a mode and looking at the badge.

**Two probes that could NOT settle it, recorded so nobody repeats them:**

- **The status line does not run under `claude -p`.** A settings file whose `statusLine.command`
  wrote its argv and environment to a file produced nothing in print mode, so the whole question is
  unreachable from a script. Verify it the way a human can: run `claude` at the hangar root and
  look at each tab.
- **`$CLAUDE_PROJECT_DIR` is not exported to tool subprocesses.** It is unset there while
  `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` and friends are all set — so it
  is injected per-hook, not a general environment variable, and was never a candidate for a
  settings file. This is a verified negative, unlike the four below.

Three alternatives were weighed, and two of them still trade a security property or a certainty for
one line saved. A generated statusline path breaks the asymmetry above. A relative command depends
on which cwd Claude Code runs a status line in, and the two modes have different ones. **The third
— the PATH-resolved `bin/hangar-statusline` — was rejected on reasoning that turned out to be
wrong, and is now what ships**; the section above has why direnv is entailed here rather than
assumed.

## Four probes that produced confident wrong answers — do not repeat them

Nothing here is reachable from `pnpm test` -- a seed suite over the pure core cannot launch a
Claude Code session -- so this is the regression record for the next person who assumes one flag
would have done it.

- **Asking a `-p` session to list its own skills is noise.** Two byte-identical invocations gave
  opposite answers — one reported `NONE`, one listed both hangar skills. So `skillOverrides`
  (`{"skillOverrides":{"<skill>":"on|name-only|user-invocable-only|off"}}`), which is the
  documented per-skill gate and would be the mechanism if operator mode ever needs the internals
  skill hidden, is **unverified**. Check it interactively with `/skills`, or not at all.
- **`--debug` does not name skills**, so it is not a substitute probe. Verified negative.
- **`--setting-sources ''` and `--plugin-dir <dir>` were only ever proven to PARSE.** Both were
  tested with `--version`, which short-circuits before either takes effect. Neither is evidence
  about loading. `claude plugin validate` passing on a bare `.claude` directory is likewise the
  "skills, agents and commands in a directory" path, not proof that `--plugin-dir` accepts one
  without a `.claude-plugin/plugin.json`.
- **The Bash prefix-versus-exact permission test was invalid, twice.** First run: the session
  silently used `permissionMode: auto` (this machine's `~/.claude/settings.json` sets
  `defaultMode: "auto"`), so the allow list never decided anything. Second run, with
  `--permission-mode manual --permission-prompts none`: an **empty** allow list still ran
  `echo alpha` with `permission_denials: []`, so `echo` is approved upstream of the allow list and
  the test measured nothing. **Any retry must first confirm the harness DENIES the chosen command
  under an empty allow list**, and must pick one Claude Code does not treat as safe.

One consequence of that last item is a design fact rather than a probe failure: **sessions here
start in `auto`, not manual.** A mode that wants the acting commands to stop and ask has to say so
with `ask` rules, which is why operator mode carries twenty of them.
