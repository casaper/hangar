# Launch modes — the `claude` shim, `hangar up` and `hangar down`

Two ways to start Claude Code in this hangar, differing in the instructions and the permission
rules they load. **A bare `claude` picks one by directory**: operator mode at the hangar root and
developer mode in `app/`, exactly those two, through `.local/bin/claude`. **`hangar up` places
both** in tmux windows 1 and 2 of one session, on a socket of its own, beside a shell, and attaches
the terminal it was typed in — on the shell tab unless `--select` names another. Each mode tab runs
that same shim, by absolute path, from its mode's directory.

**Window 3 is a plain shell at the hangar root, and it is a window rather than a third mode.** A
mode is a composed launch profile; a shell has none of its parts, so `Mode` stays a pair, a `Tab`
is a mode or `shell`, and `--restart shell` is an error. The section below on the shell tab has the
three reasons it is not in `MODE_COLOURS` and the one thing that would have bitten.

`src/commands/up.ts` is the command and `.claude/modes/` holds the five files the shim names — a
`.md` and a `.settings.json` per mode, plus the shared `mcp.json` — and `statusline.sh` beside
them. `src/commands/down.ts` is the other end, and has a section of its own below.

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
<file>` plus `--mcp-config <file>` plus `-n <name>`, and for `dev` a working directory of `app/` so
that `app/CLAUDE.md` is loaded from the first turn instead of lazily on first read beneath it.

**The shim puts those four AHEAD of anything the caller passed, and that ordering is the whole of
what resuming into a mode is.** `claude --resume <id>` typed at the root reaches the real binary as
`--settings … --append-system-prompt-file … --mcp-config … -n … --resume <id>`; reversed, the
session resumes with the badge of a mode whose rules and tools it does not have. It is the one
property here whose failure looks exactly like success, so `test/claude-shim.test.ts` runs the
shim against a fake `claude` and pins the order. `hangar up -r` and `--restart -r` get it for free:
a tab's command is the shim plus `--resume <id>`.

**The four are written in exactly one place, and that is why a tab runs the shim.** A bare
`claude` is a mode launch of its own, so a TypeScript copy of the argv for the tabs, beside the
shell one, would be two definitions of a mode free to drift. `modeTabCommand` names the shim by ABSOLUTE path — a tmux server inherits whatever PATH
started it, and a bare name could reach the real binary, a session in no mode under a mode's
badge.

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
That is what makes resuming into a mode possible at all. The same `claude --resume` typed in any
other directory resumes with no mode, which is the trap — it looks identical and has none of the
rules.

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
standing in. `app/` has no `.envrc` of its own, so the root's reaches it.

**But it must not be in `bin/`, and that is measured rather than cautious.** Every clone's own
`.envrc.private` carries `PATH_add <hangar>/bin` — it has to, that is how `hangar` is reached from
inside a clone — and repeats nothing else. So `bin/claude` would have been on PATH in every clone
shell too, where `terminal.tabs[]`'s schema default `command: 'claude'` is the line that starts
each clone's own Claude Code session. `.local/bin` gets a second `PATH_add` in the hangar's
`.envrc` alone, which no clone repeats, so in a clone the shim is not on the path at all.

**The shim still tests where it was typed, and that is not redundant.** A tmux SERVER inherits
the environment of whatever started it, and `hangar open` is normally typed at the hangar root —
so, measured, a clone window's `command: 'claude'` resolved to the shim from a `$PWD` inside the
clone. Nothing in the clone put the directory on PATH; an ancestor process did, which is exactly
what the directory split cannot see. So the shim picks a mode only for EXACT equality with the
root or with `app/`, and hands the real binary over untouched everywhere else — `app/src`
included, since a session there would not load `app/CLAUDE.md` on its first turn.

**`pwd -P`, never `$PWD`.** `$PWD` is a shell variable and is inherited, so a non-interactive
shell that never `cd`'d carries whatever its parent had — which made an early version of the shim
answer for a directory the caller was not standing in. `pwd` asks the OS, and `-P` resolves
symlinks on both sides so a hangar reached through a link still compares equal.

**Three more cases get the bare binary, and each unsets `HANGAR_MODE` on the way:**

- **`$CLAUDECODE` is set** — the escalation guard; see the section on it below.
- **The first word is a subcommand or `--version`/`--help`** (`mcp`, `update`, `plugin`, …, read
  off `claude --help`'s Commands section). Decided on the first word ALONE, so a prompt that
  starts with a subcommand's name — `claude update the README` — reaches `claude update`. That is
  accepted rather than missed: anything smarter is a parser of claude's command line, which is
  claude's to change. The test pins the misroute so nobody "fixes" it into one.
- **No mode directory.** The unset matters in all three: a mode session exports `HANGAR_MODE`, its
  Bash children inherit it, and a bare `claude` started from one would otherwise wear its badge.

**The recursion is cut by skipping the shim's own directory** when it resolves the real binary.
`resolveClaudeBinary` skips the same directory when `hangar up` checks that Claude Code is
installed at all — a tab whose shim exits 127 is closed by tmux and never appears, so the check is
up front, and finding the shim would answer "installed" on a machine where it is not.

**Editing `.envrc` revokes direnv's trust**, so `direnv allow` is a one-time step after pulling a
change to it — and until it is run the hangar shell has no `hangar` either, because `PATH_add bin`
is in the same file.

## One session, three windows, and a socket of its own

`tmux -L hangar-<id>-claude`, not a session on the clone socket. Every session on that one is
expected to name a clone: `staleSessions` walks it for sessions whose `@hangar_clone` matches no
live clone, and two mode sessions — carrying the conf's global `@hangar_id` and no
`@hangar_clone` — are exactly the shape `src/tmux.ts` calls *foreign*. `doctor` would report them
stale for ever, which is the check nobody reads. It also keeps `tmux -L hangar-<id> ls` meaning
precisely "the clones". The names are distinct by exact equality, which is all the comparison in
`currentSession` does.

`.hangar/claude-tmux.conf` is the config, rewritten by `hangar up` every run immediately
before the server starts. That is why it gets no `doctor` row and no `.gitignore` line, unlike
`clone-tmux.conf`: `colours sync` writes that one and nothing else would notice it going stale,
whereas this one cannot be stale. Its bar options are a table with two consumers — rendered into
the conf, and written with `set -g` onto a server already running — the same split
`clone-tmux.conf` and `TmuxServer.restyle` live on, and possible because every one of them is a
global *session* option rather than a server option.

**The pair is a singleton, and tmux does most of the work.** A window whose command exits is
closed by tmux, so a tab whose claude you `/exit` is simply gone and the next run recreates it.
`renumber-windows off`
is what keeps operator at index 1 when developer's window closes; with it on, the tabs would swap
places for no reason a reader could see. The shell is the window this matters most for, since
`exit` there is reflex — and it is why the session outlives both mode tabs: tmux ends a session
with no windows, and a live shell is a window. `--restart` ends a tab's claude that is still
running and asks first through `confirm`, which fails closed with no terminal; the ensure pass
then recreates it like any absent tab.

**`--restart <tab> -r` resumes what the tab HELD, and that needs a different rule from `-r`
alone.** An absent tab takes `open --resume-last`'s `resumeChoice`: the newest session in the
directory, unless it may be live. A restarted tab's session IS live until the kill lands, so that
rule would answer "live, start fresh" every time. `restartChoice` takes the EXACT answer first:
Claude Code records each running session in `~/.claude/sessions/<pid>.json`, and a tab's
`pane_pid` is claude's own pid (tmux's shell, the shim and claude each `exec` the next) — measured
on both live tabs, each naming its own session id. That matters more than it did, because a bare
`claude` at the root or in `app/`, in any terminal, is now a live session of the same mode, and
guessing between them could resume a conversation still open elsewhere — two sessions on one
conversation, the fleet's worst failure. A recorded id with no transcript is a tab nobody has
talked in, and gets a fresh session. Only when there is no readable record does it fall back to
`reload`'s guess — the newest LIVE transcript in the directory — and the id is printed before
anything is killed either way. Both read
`claudeTranscriptsIn(dir)`, which is EXACT: `transcriptDirsForClone`'s prefix match at the hangar
root would sweep in every clone's transcripts, because every clone's slug starts with the root's.

**The shell tab is selected by default** because it is where a person types first; a mode tab is
one `--select` away, and its session is already running whichever tab is in front. And attaching uses `-d`, because two clients on one session
mirror each other's window selection — switching tabs in one moves the other, which reads as the
bar changing by itself.

## The shell tab, and why running the command from inside it is normal

Window 3 is an interactive shell at the hangar root, created with no command at all so tmux starts
`default-shell` as a login shell — the developer's own, rather than one this CLI picked. It exists
because the hand-run half of fleet work (`hangar list`, `git log`, `pnpm golden`) otherwise has
nowhere to live but a tool call inside one of the two sessions.

**Three reasons it is a window and not a third entry in `MODE_COLOURS`,** and the third is the one
that would actually have bitten:

- A mode is `--settings` + `--append-system-prompt-file` + `--mcp-config` + `-n` in that order,
  with a test on the shim pinning the ordering. A shell has none of the three, so widening the type buys a
  case with no meaning.
- `MODE_COLOURS` is a hand-maintained duplicate of `statusline.sh`'s two triples under an explicit
  "change one, change both" rule. A third triple there is one nothing renders and everybody has to
  maintain.
- **`HANGAR_MODE` there has to be blanked, not omitted.** Measured on tmux 3.7c by reading
  `printenv HANGAR_MODE` out of the pane: a window created with no `-e` answered `ops`, the
  session's value — the same inheritance that makes the mode windows pass `-e` individually, read
  the other way round. Omitting the flag would therefore have put operator's badge on a shell
  carrying none of operator's rules. So the window
  is created with `-e HANGAR_MODE=`, and an empty value reaches `statusline.sh`'s
  `${HANGAR_MODE:-}` exactly as an unset one does: the honest red `NO MODE`. A third entry in
  `MODE_COLOURS` would have made that badge a confident lie instead.

It is tagged `@hangar_shell` rather than being folded into `@hangar_mode`, and that is a migration
question rather than a taste one: renaming the existing tag would leave every window of a server
that is already running untagged, and the next run would try `new-window -t` on an index tmux
reports as occupied. A second tag beside the first needs no `kill-server`.

**The attach is SKIPPED from inside the session, and skipping is not refusing.** That tab has
`bin` on its PATH — direnv put it there — so `hangar up` reaches this command from inside the
session it would attach to, and that is the normal case rather than a mistake. Everything up to
`select-window` works from there and is wanted: an exited tab is recreated, a `--restart` lands,
the bar is re-applied, and selecting a window moves the client that is already present, which IS
"switch to that tab". Only `attach` breaks — it unsets `TMUX` so tmux cannot see the nesting, and
`-d` then detaches this terminal from inside its own pane. So one call is skipped and a `note`
says which tab was selected.

**Do not turn that into a fourth refusal.** It would block `hangar up --restart dev` typed in the
shell tab, which is where restarting a wedged developer tab is naturally typed, and would leave an
exited tab unreachable without `C-b d` out to the outer terminal first. The escalation guard is
elsewhere and is untouched by this: `$CLAUDECODE` is independent of `$TMUX` and still fires for a
Bash tool call from either mode tab, so the `$TMUX` branch only ever admits a human at a shell
prompt, where there is nothing to escalate.

## The header, and the width budget that shapes it

tmux reserves `status-left-length` and `status-right-length` first and gives the window list
whatever remains. So `status-left` is empty with a length of 0: the whole width goes to the tabs,
which is where the text saying what each session is FOR lives. Only the CURRENT tab carries that
text, on a block of its mode's hue; the others show their bare names, and the shell tab never
carries any. Measured on tmux 3.7c by reading `#{E:status-format[0]}` back off a live server and
counting the window list alone — the truncation markers are not part of it, the separators
between entries are:

    operator current    ` ops · run the fleet  dev  shell `     35 columns
    developer current   ` ops  dev · change the CLI  shell `    36 columns
    shell current       ` ops  dev  shell `                     19 columns

against `columns - 3` given to the list, so the worst case fits exactly at a 39-column terminal.
`status` is `on` and not `2`, which is what keeps it one line — tmux truncates a status line
rather than wrapping it, so "never two lines" is a property of that one setting.

**Measure it, do not compute it.** The separator tmux puts between entries is easy to leave out of
a hand count and is a column per gap, which is the whole of the difference between the arithmetic
and the figures above.

The hue is baked into each window's own `window-status-current-format` rather than read from a
user option inside the `#[…]` style spec: a per-window format with the value already in it is what
`clone-terminal.sh` does and is known to work. The purpose text stays a user option
(`@hangar_purpose`), which expands inside a format perfectly well.

`MODE_COLOURS` in `src/palette.ts` holds the two hues — ops `#1f6feb`, dev `#b35400` — with ink
from the same `inkFor` the clone hues use: white on both, at Lc 77 and Lc 79. **They are a
hand-maintained duplicate of `statusline.sh`'s own two triples**, named here rather than left to
be discovered. That file cannot source them: it is one of the hand-maintained mode files, derived
from nothing under `app/src/**`, deliberately, because it must render a badge when everything else
is broken. Change one, change both.

## Two guards on the escalation, and only one is a permission list

Two routes would hand an operator session developer mode's rules — writes to `app/**` included:
`hangar up --restart dev`, and `cd app && claude -p '…'` now that a bare `claude` there IS
developer mode. The pre-existing `Bash(hangar dev)` denial matches neither.

- **`ops.settings.json` denies `Bash(hangar up)` and `Bash(hangar up:*)`** — a rule matches the
  start of a command string, so every name a command answers to needs its own pair, and
  `test/mcp-tools.test.ts` holds them to the file. The MCP tool surface simply has no `up` in it —
  an absence rather than a rule, because a tool that does not exist cannot be reached by one. It
  would also be a tool that could never work: the `$CLAUDECODE` refusal below fires on every tool
  call there will ever be.
- **`$CLAUDECODE` is tested in both places, and no editable file can turn either off.** `hangar
  up` refuses; the shim hands the real binary over untouched, so a `claude` started from inside a
  session gets no mode at all. That variable is set in every tool subprocess — measured alongside
  `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_SESSION_ID`, and unlike `$CLAUDE_PROJECT_DIR`, which is
  injected per hook. There is no legitimate call of `up` from inside a session anyway: attaching a
  tmux client needs a terminal.

The shim's guard is not a fence around the real binary — a session can still run
`claude --settings …/dev.settings.json` by hand, as it always could. It closes the route that a
directory-picked mode OPENED, which is the one a reasonable command would take by accident.

A third refusal is about intent rather than privilege: `hangar up` stops when the working
directory is inside a clone, because `hangar` itself is on a clone's PATH by design. A dry run
runs ahead of all three, because it creates nothing and attaches nothing, so none of them has
anything to protect.

**There is deliberately no fourth**, and the shell tab is where somebody will be tempted to add
one — see the section on it. Being inside this hangar's own tmux is not a privilege question:
`$CLAUDECODE` catches the case that is, whether or not `$TMUX` is set.

## `hangar down`, and why the root server goes last

`down` takes the hangar down: every clone exactly as `close --all` closes it, then the root
socket's `kill-server`. It is deliberately not symmetric with `up`, which opens no clone — which
clones to open is a decision per clone that `open` already makes, while "take it down" has no such
decision in it. `--keep-clones` is the root window alone.

- **The clone half IS `close`**: `planCloses` / `executeCloses` in `close.ts`, split out of
  `closeClones` so the dev servers are stopped before their pane goes, the editor windows close,
  and the `plans collect` / `tmp merge` a killed session's `SessionEnd` hook never runs still
  happens. A second opinion about any of that here would drift from the first.
- **One confirmation for everything.** `close --all` asks on its own; two questions for one
  decision would let a decline on the second leave half a hangar. So every plan is made and
  printed first, one `confirm` covers the clones' warnings and every live mode tab with its
  uptime, and the clones then execute with no further question.
- **The root server is killed LAST**, because the shell tab — where this is naturally typed — is a
  window on it, and `kill-server` ends the process running the command. `kill-server` rather than
  `kill-session` because the socket holds that one session and nothing else, so the two are the
  same act. The root sessions need no plans collect: the root settings write into the archive.
- **Two refusals.** `$CLAUDECODE`, as for `up`, and the same deny pair in `ops.settings.json` —
  a session ending every session, its own included, is not a tool call. And a terminal inside a
  CLONE's tmux session: the clone pass would kill it before the root window was reached, which is
  `close`'s own refuse-from-inside with nothing after it to finish. A dry run runs ahead of both.

The terminal `up` was typed in survives: its tmux client exits with the server and drops back to
the shell it was started from. The clone tabs `open` created are iTerm2 tabs whose COMMAND is the
attach, so they end with it unless the profile is set to keep a finished session open — expected
rather than measured, so check it before promising it.

## The tool server, and the one thing a Bash rule cannot say

`hangar mcp` serves one MCP tool per command over stdio, and both modes get it. It exists for a
single reason, which this file had already written down as unsolved:

> `hangar doctor` and `hangar doctor --fix` differ by one flag, so there is no way to pre-approve
> one without the other.

That is why the `allow` list below contains only commands whose prefix cannot widen into something
that acts, and why operator mode asks about many things it could safely be given. **MCP
permission rules have no argument matching at all** — Claude Code skips any `mcp__` rule that
contains parentheses, silently, when the settings file loads — so the granularity is exactly the
tool name. Two names, two rules, nothing to widen.

**Nearly every command is a tool, and the exceptions are `NOT_EXPOSED` in `src/mcp/tools.ts`.**
`up` and `down` could only ever fail, for the `$CLAUDECODE` reason above, and are the commands
that must not be reachable. `exec` is never exposed and never run by an agent at all. `mcp` is the
server itself. `dev release`
pushes and cuts a version behind a confirmation that fails closed, so the only form that completes
as a tool call is the one carrying `-y`. `dev golden` writes a partial capture that would read as
the gate without being it, and aimed at `dev/golden/gated` would half-overwrite the baseline.
`jira hook` reads its payload from stdin. Everything else is exposed, `setup` included — see the
section on why the mode settings stay tracked for the gap that closes. The only flag no tool
offers is `--quiet`, which exists for the `SessionEnd` hooks and the bar's own detached spawn.
A `.hideHelp()` option is dropped by the same rule that keeps it out of `--help`, unless an
exposure names it in `shows` — `add-clone --remote` is the only one that does.

**So a dry run is a separate TOOL, not a parameter.** `sync_preview` fixes `--dry-run` and removes
it from its own schema; `sync` hides it. A `dry-run` boolean would have put both under one rule,
and pre-approving the preview would have pre-approved the sync — the same bug as `doctor:*`, moved
rather than fixed. `serveMcp` refuses to start if an acting tool's generated schema offers
`dry-run`, because only the live registry knows which commands have the flag — and likewise if the
table names a command the registry does not have. Those two are wrong rather than missing, which
is why they refuse while an unexposed command is only a warning.

**`colours sync` is the one command with two read-only tools**, and that is not redundancy:
`--check` is a gate that exits non-zero when an artifact is stale, `-n` is the report that says
which one and what would change. `app/CLAUDE.md` names the dry run as the only staleness check
there is for the two gitignored shell helpers, so collapsing the pair would have taken away the
thing that check is for.

**`pr_refresh` reports for permission purposes even though it writes**, and the two readings do
not conflict. The clone bar spawns exactly this, detached, every time a record passes
`forge.prCacheTtlSeconds`; a prompt in front of what already happens unattended twenty times a
minute is theatre, and what it writes the next redraw would rewrite anyway.

Measured, not assumed, with `--settings` and `--mcp-config` both loaded and a `-p` session:
`mcp__hangar__doctor` ran with no prompt and `permission_denials` empty;
`mcp__hangar__ide_emacs_sync` came back denied and named in `permission_denials`. That is the
separation, working.

### Three reasons a tool call is a subprocess

`hangar mcp` spawns `bin/hangar` rather than importing the command and calling it, and each reason
is load-bearing rather than cautious:

- **`sync` recovers its strategy from `process.argv`.** `forcedStrategy` scans for `merge-default`
  or `rebase-default` before it reaches `sync`; commander parses none of it into options. An
  in-process call would take the auto-decide branch every time, silently and correctly-looking.
- **About twenty `console.log` and `process.stdout.write` calls bypass `ui.ts`'s `emit`.** On a
  stdio server stdout *is* the protocol, so one of those lands in the middle of a JSON-RPC frame
  and the client reports a broken server with no clue why.
- **`captureOutput()` is a module-level global**, with no isolation between concurrent calls.

A `process.exit` in a command (`setup` has one) would take an in-process server with it besides.

The cost is one Node start per call, 0.24-0.28s, against a tool call's own latency — and it buys
behaviour byte-identical with what a person types, which is what lets `reference/commands.md`
document both spellings from one table. Colour escapes are stripped on the way out and `NO_COLOR`
is set for the child: `paint()` writes 24-bit escapes unconditionally, because a clone's hue is
its identity rather than styling, and a model reading a tool result has no use for them.

### The enumeration is a test, and the coverage is only a warning

The two directions fail differently, so they are held differently.

**A tool with no permission rule is not a tool that fails safe.** Sessions here start in `auto`,
where an MCP tool matching no rule is decided by a classifier rather than by the user — so a
mutating tool added to `app/src/mcp/tools.ts` and forgotten in `ops.settings.json` simply runs.
`test/mcp-tools.test.ts` asserts every exposure appears in exactly one of the three lists and that
a reporting one is in `allow`. **An acting exposure sits in `ask` unless it says
`preapproved: true`**, which moves it to `allow`; the test expects exactly that, so the field and
the settings file change in one edit. `open` and `checkout_default` are the two that carry it.

**`dev.settings.json` enumerates none of them, and that is the deliberate asymmetry rather than the
same omission.** The enumeration is a boundary, and developer mode has none to hold — it may already
write `app/**`, run `hangar dev` and open either tab. Giving it a rule per tool would be a second
list to keep in step for no guarantee, and the test would then be pinning a file whose whole content
is "yes" repeated. Operator mode is the one with something to lose. It reads the tracked
`ops.settings.json` by a path relative to itself, which is portable because that file is
byte-identical on every machine — the same property that made `hangar-statusline` a PATH name.

**A command with no tool is merely missing**, and is visible the moment somebody looks for it. So
that direction is a line on stderr when the server starts, listing what `unexposedCommands` found.
It is deliberately not a refusal: the omission would be made in the developer tab and the outage
would land in the operator one, next door.

`cli.ts` cannot be imported to check either from a test, because its last statement is
`program.parseAsync()`. The registry is handed IN instead, from the one place that already has it,
which is also how every tool schema is generated — descriptions, arguments and `.choices()` read
off the commander entry rather than written a second time.

### `allow` is in `ask` for a reason `install` is not

Both run code, so the pair of rows looks like a copy. It is not. **`install` runs the commands
`repo.install[]` DECLARES** — a fixed list in a config file, reviewable before anything spawns,
which is the whole point of `install_preview`. **`allow` approves whatever is in an `.envrc` right
now**, and `.envrc` is tracked: a clone session can author the file its own developer's next `cd`
will execute, and `hangar allow --all` would bless that across the fleet.

The answer is the `ask` entry rather than an exclusion from the table. An exclusion is what `exec`
gets, and the reason there is generality — a snippet can spell every other denied command — which
does not apply here: the schema is a clone name and two flags, and the thing being approved is a
file a human can read. What a rule cannot do is constrain the file's CONTENT, so the rule buys a
human at the moment of approval and nothing more. That is the right amount, and it is written down
because the row beside `install`'s would otherwise read as having been copied.

### `skills_sync` is in `ask` because it is the only tool that leaves the hangar

Every other acting tool writes inside this hangar or inside one of its clones, so its blast radius
is bounded by the fleet. `skills sync` writes `~/.claude/skills/<name>`, which is machine-global: a
personal skill shadows a same-named project skill ENTIRELY and silently, in every repo on the
machine, so what it changes is which instructions every future session anywhere follows.

**It cannot be namespaced, and that is why the refusals matter more than the rule.** Everything
else a hangar puts under `~/.claude` carries the hangar id in its filename precisely so a second
hangar cannot clobber it; a skill cannot, because the directory name is what makes it shadow at
all. So `sync` reads an existing link's TARGET and refuses when it belongs to another hangar, and
`--adopt` replaces a real directory only when the content already matches byte for byte — the
failure mode is a refusal, never a discarded edit. The `ask` entry buys the same thing `allow`'s
does, a human at the moment of approval, and as there it is the refusals rather than the rule that
bound what can actually go wrong.

### Why `--mcp-config` and not a `.mcp.json`

Developer mode's working directory is `app/`, so a file at the hangar root may or may not be found
by project-root discovery from there, and "may or may not" is not a footing for a tool surface.
`--mcp-config` takes an absolute path built from `hangar.root`, which reaches both modes for the
same reason `--settings` already does, and keeps the file out of a discovered path so it is loaded
once by the sessions that ask for it.

**Verified to be honoured and not merely to parse** — this file records two flags that were only
ever proven to parse, and the lesson was taken: a `-p` session launched with both `--settings` and
`--mcp-config` called `mcp__hangar__list` and answered with the right number of clones.

**`--strict-mcp-config` is deliberately not passed.** It confines the session to this one file,
which would silently drop whatever MCP servers the developer configured for themselves — a removal
nobody asked for, and the kind that is noticed weeks later.

### What it does not buy

**The Bash path stays open**, by decision. Every rule operator mode had still stands, so
`hangar doctor --fix` typed at a shell prompt is still governed by the coarse
`Bash(hangar doctor:*)` rule that cannot tell it from the report. The tools are a better default
door, not a wall, and the prefix-widening problem is routed around rather than removed. Closing it
(`deny: Bash(hangar:*)`) is available and is a separate decision, worth taking only once the tool
surface has been used enough to know what it does not cover.

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
| `$HANGAR_MODE` | exported by the shim, and `new-window -e` per tab from `hangar up` | the argv-less entry in the root `.claude/settings.json` winning instead |
| neither | — | a red `NO MODE` badge |

Any one channel working shows the right badge; all three failing shows a **red warning rather than
a confident wrong answer**. That makes the confirming observation a cheap one: a freshly launched
`hangar up` window reading `OPS` validates the entire chain, whichever channel carried it.

Three implementation rules, each the opposite of the obvious version:

- **`$HANGAR_MODE` is set by the shim and by `hangar up`'s tabs and nowhere else, and the shim
  unsets it whenever it starts no mode.** Exported from `.envrc` or `.envrc.hangar` it would reach
  every shell in the hangar, and a `claude` in no mode would then wear a badge whose rules it does
  not have — at which point `NO MODE` stops meaning
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

The `statusLine` command is never a relative path. The generated root `.claude/settings.json`
names the script **absolutely**; the two tracked mode files name `hangar-statusline <mode>` on
PATH, for the reason under "The one machine-specific line" below. A relative one could not work
anyway: developer mode's working directory is `app/`, so the two modes would need different
relative paths to one script.

**One case this gets wrong, bounded and written down rather than engineered around:** a nested
interactive claude started from inside an ops session by the real binary's ABSOLUTE path skips the
shim, inherits `HANGAR_MODE=ops` and badges itself `OPS` while carrying none of operator mode's
rules. A bare `claude` is not that case — it goes through the shim, which unsets the variable.
The CLI's own nested launches are unaffected — `resolve-conflicts.ts` is headless, and
`teach-rg.ts` runs inside a clone, where the clone's own statusline applies.

## `hangar exec` is the one hard denial, and a permission rule could not deliver it

Every other refusal in the two modes is a guardrail: Bash is open, so a deny on writing is not a
deny on `sed -i`, and the rules say what a mode is FOR. `hangar exec` is the exception, and the
reason is generality rather than blast radius. `remove-clone --delete` destroys more and
is merely `ask` (its `--force` is offered by no tool, but stays reachable at a shell). What `exec` does that nothing else does is take an **arbitrary shell snippet**
and run it in **every clone named, in one call** — so it is at once a spelling for every command
denied elsewhere and a way into working trees other agents are live in, which is the one rule the
fleet's own `CLAUDE.md` is built around.

**A permission rule cannot hold that line, and this is the measured part.** `Bash(hangar exec:*)`
matches the START of the command string. `cd /elsewhere && hangar exec --all -- …` does not match
it and runs. So the rules stay — a refusal from a rule reads better than one from a hook, and the
two fail differently — but the half that actually holds is `bin/hangar-exec-guard`, a `PreToolUse`
matcher on `Bash` that parses the whole command line.

Four things about that script are deliberate:

- **It is not part of the CLI.** It runs before every Bash tool call in every clone and both
  modes. `bin/hangar` costs ~0.25s to load (type stripping over the whole CLI); the guard is a few
  hundred bytes of plain JS and measures ~32ms. It is also why it imports nothing from `app/`: a
  guard that fails to load is a guard that is not guarding.
- **It matches tokens, not substrings.** Both mistakes are real and one of them is fatal to the
  whole idea: blocking `docker exec` or `cat src/commands/exec.ts` gets the guard switched off
  within a day, after which it protects nothing. So it finds tokens naming this CLI — bare
  `hangar`, anything ending `/hangar`, or a direct `cli.ts` — steps over the global
  `--hangar <path>` and its value, and asks whether the next non-flag token is `exec`.
- **It fails CLOSED on an unreadable command and OPEN on an unparseable payload.** Not a
  contradiction: a payload it cannot parse means Claude Code changed shape, where blocking every
  Bash call in the fleet is far worse than the thing being guarded. A missing command inside a
  well-formed payload is the shape of somebody hiding something.
- **The modes name it bare and the clones name it absolutely.** The mode settings are tracked and
  may not carry one machine's home directory, and a session running in a mode is proof direnv
  loaded — the same argument `hangar-statusline` already rests on. A clone's `settings.local.json`
  is untracked and its session may have been started by something other than `hangar open`, so
  there its PATH proves nothing and the absolute path is the only reliable form.

  **The bare form was verified rather than argued**, because it is the load-bearing half: in a
  live mode session `command -v hangar-exec-guard` answers `<hangar>/bin/hangar-exec-guard`,
  from the same inherited environment Claude Code spawns a hook with. That is worth checking
  again if the launch path ever changes, since **a hook that cannot be found does not deny** —
  Claude Code reports a hook error and the call proceeds. The `Bash(hangar exec)` deny entries
  are what stands underneath that, which is the second reason they are not redundant.

**It also refuses `hangar pr create` and `pr update` through Bash, unless the invocation carries
`-n`.** They were the one publishing path left open once `git push` and `gh pr create` were
covered: both default to the clone they run in, and `-y` skips their `/dev/tty` confirmation, so
nothing stood between a clone agent and the forge. The `-n` test is per shell segment, or
`… -y && ls -n` would borrow the flag. The `pr_create`/`pr_update` tools are unaffected — a tool
call is not a Bash call — and stay behind their `ask` rules.

`doctor` carries a row for it, unconditionally — unlike the tracker hook, no config makes this
one unwanted — and `--fix` writes it. **Developer mode is denied it too**, which is the one place
this differs from every other asymmetry in the pair: dev mode may freely CHANGE `exec`, since it
is code under `app/src/**`, and still may not run it. There is no way to test it from inside a
mode, and that is correct rather than awkward — what the command does is reproduce the user's own
interactive shell, which no agent session has.

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

**`Bash(hangar doctor)` is deliberately absent from operator mode's `allow` list** and sits in
`ask` instead, even though a bare `doctor` only reports. `doctor` and `doctor --fix` differ by one
flag, and the `hangar-ops` skill's `reference/settings-layering.md` records the reason this hangar
carries no permission allowlist at all: a Bash pattern that pre-approves the report may pre-approve
the writer. Until that is actually verified (see below), the Bash `allow` list contains only
commands whose prefix cannot widen into something that acts.

**`mcp__hangar__doctor` IS in `allow`, and that is not a contradiction** — it is the whole point of
the section above. A tool name has no arguments for a pattern to widen across, so the report and
the writer are two names with two rules. The Bash entry stays exactly as it is, because the shell
path stays open.

## The mode files are hand-maintained, not generated

They sit beside `bin/hangar`, `.envrc.hangar` and the `.nvmrc` pair as hangar-root files this
package owns by hand. So they add **no** row to `app/CLAUDE.md`'s derivation table and need no
`--check` gate: nothing derives them from `app/src/**`, and the "compare generated content, never
presence" rule in `reference/doctor.md` does not apply. A `doctor` row for them should check that
the six files exist, that the three JSON files parse, and that `statusline.sh` is executable —
presence and validity, never content — and that is the deliberate exception, stated out loud.

**`mcp.json` is hand-maintained for the same reason and one more of its own.** It carries no
per-hangar value at all — `{"mcpServers":{"hangar":{"command":"hangar","args":["mcp"]}}}` is
byte-identical everywhere — so there is nothing to generate. `ops.settings.json`'s tool rules ARE
derived from `app/src/mcp/tools.ts`, and they are held to it by `test/mcp-tools.test.ts` rather
than by a writer, for exactly the escalation reason the next section gives: a command that
regenerated that file would let operator mode rewrite its own permission list.

## Why the mode settings are the one generated-file candidate that stays tracked

Publication forced the question for every tracked file naming one machine's home directory, and
these two answered differently from the rest. `.claude/settings.json` became generated and
gitignored; `.claude/modes/{ops,dev}.settings.json` did not.

The reason is an escalation path, not tidiness. `ops.settings.json`'s `allow`/`ask`/`deny`
entries **are** operator mode's boundary. Operator mode is denied `Edit(./.claude/modes/**)` —
that denial is the whole reason the mode pair exists — and `Bash(hangar doctor:*)` is one `ask`
away. So a `doctor --fix` that generated that file would let operator mode rewrite its own
permission list through a command one approval runs, and the asymmetry this file spends its length
justifying would be gone. `setup` was no better and is now named in both spellings —
`Bash(hangar setup)`, `Bash(hangar setup:*)` and `mcp__hangar__setup` all `ask` — which is the
reason `setup` is exposed as a tool at all rather than left out with `up` and `dev`: a command
that reaches the config is better named than merely unlisted.

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
`hangar up` sets. So the launching shell's environment does reach children of the Claude Code
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
with `ask` rules, which is why operator mode carries one for every acting command and tool.
