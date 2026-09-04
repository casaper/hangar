# Launch modes — `hangar-ops` and `hangar-dev`

Two ways to start Claude Code in this hangar, differing in the instructions and the permission
rules they load. `bin/hangar-ops` and `bin/hangar-dev` are three-line wrappers over
`bin/hangar-mode`; the five files they name are in `.claude/modes/`.

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

## Why they are scripts in `bin/`, and not functions in `.envrc.hangar`

**They started as shell functions in `.envrc.hangar` and that could never have worked.** direnv
exports the **environment diff** that evaluating a `.envrc` produces, and a shell function is not
an environment variable — so a function defined there never reaches the interactive shell. The
tell is that the file's own long-standing helpers behave the same way: inside this hangar,
`direnv exec . zsh -c 'type hangar_use_node'` answers **not found**. They work only because
`.envrc` *calls* them while direnv is still evaluating the file, which is the one thing a
user-facing command cannot do.

`PATH` *is* an environment variable, so `PATH_add bin` genuinely reaches the shell. That makes
`bin/` the only mechanism that works without editing someone's `~/.zshrc`, and it inherits
`bin/hangar`'s per-hangar scoping for free: the `hangar-ops` on PATH belongs to the hangar you are
standing in, and there is deliberately no global install.

**The root is resolved from the script's own location, never from `$PWD`** — the same rule
`bin/hangar` states for itself, and the reason `hangar-dev` works from three directories down
inside `app/src/`. As a shell function this had to be reconstructed at call time from
`command -v hangar`, because `source_env` does a `pushd` and `$PWD` is the hangar root only while
the file is being sourced. As a script the problem does not arise.

`hangar-mode` validates the mode name and refuses an unknown one with exit 2 rather than letting
the missing-file check report a confusing path.

**One consequence worth knowing: `--append-system-prompt-file` turns the system-prompt snapshot
off**, so the remit is re-applied on every launch instead of being frozen into the conversation.
`hangar-ops --resume <id>` resumes *into* operator mode; a bare `claude --resume` of that same
session resumes with no mode at all, which is the trap — a resumed session looks identical and has
none of the rules.

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
| `$HANGAR_MODE` | `export` in `bin/hangar-mode` | the argv-less entry in the root `.claude/settings.json` winning instead |
| neither | — | a red `NO MODE` badge |

Any one channel working shows the right badge; all three failing shows a **red warning rather than
a confident wrong answer**. That makes the confirming observation a cheap one: a freshly launched
`hangar-ops` window reading `OPS` validates the entire chain, whichever channel carried it.

Three implementation rules, each the opposite of the obvious version:

- **`$HANGAR_MODE` is exported by `bin/hangar-mode` and nowhere else.** Exported from `.envrc` or
  `.envrc.hangar` it would reach every shell in the hangar, and a bare `claude` would then wear a
  badge whose rules it does not have — at which point `NO MODE` stops meaning anything.
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

Publication forced the question for every tracked file naming `/Users/someone`, and these two
answered differently from the rest. `.claude/settings.json` became generated and gitignored;
`.claude/modes/{ops,dev}.settings.json` did not.

The reason is an escalation path, not tidiness. `ops.settings.json`'s ~40 `allow`/`ask`/`deny`
entries **are** operator mode's boundary. Operator mode is denied `Edit(./.claude/modes/**)` —
that denial is the whole reason the mode pair exists — and it is *allowed* `Bash(hangar doctor:*)`.
So a `doctor --fix` that generated that file would let operator mode rewrite its own permission
list through a command it is permitted to run, and the asymmetry this file spends its length
justifying would be gone. `setup` is no better: it is not in operator mode's deny list either,
only unlisted, so `hangar setup --force` reaches it behind one prompt about "hangar setup".

So `doctor` **reports and offers no repair**, the same shape as the `settings targets` check for
an unresolvable theme. Only one line in each file is machine-specific — `statusLine.command`, an
absolute path into this hangar — and a fresh clone of a published hangar carries the previous
owner's. Claude Code fails silently on it, exactly as it does on an unresolvable theme: the badge
simply never appears, and a session with no badge is a session whose permission rules nobody can
see at a glance. `doctor` names the file, the value and what to point it at; editing two lines is
the manual step.

Three alternatives were considered and all three trade a security property or a certainty for one
line saved. A generated statusline path breaks the asymmetry above. A relative command depends on
which cwd Claude Code runs a status line in, and the two modes have different ones. A
PATH-resolved `bin/hangar-statusline` depends on direnv having loaded — which is the assumption
the clone hooks deliberately do NOT make (`bin/hangar --hangar <root>` is baked absolute because a
hook runs with an unpredictable PATH), and getting it wrong is the same silent failure.

## Four probes that produced confident wrong answers — do not repeat them

The fleet has no test suite, so this is the regression record for the next person who assumes one
flag would have done it.

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
