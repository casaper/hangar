---
name: hangar-ops
description: How to drive the hangar CLI on the user's behalf — addressing clones by index, which commands only report and which move git state or open windows, previewing before acting, the four commands that ask a human a yes/no question on /dev/tty and skip when there is no terminal, the Bash timeout that will kill a sync mid-rebase, and how the mcp__hangar__* tools relate to the shell commands. Load when the user asks what the fleet is doing, to sync or check out or open a clone, to add or remove one, to recolour one, why doctor is red, or for any hangar command's flags. This is the operator's manual; hangar-internals is why the commands are built the way they are.
---

# Driving `hangar`

The user is steering a fleet of clones through you. Your job is to run the right command, read its
output correctly, and know which commands are not yours to run.

`reference/commands.md` has the full surface — every command, its tool name, every flag and
default, and whether it reports or acts. **Check a spelling there rather than recalling it**;
several flags are unusual, and one is actively misleading (see `resume` below).

**Two ways in, and they run the same code.** A mode session has one MCP tool per command
(`mcp__hangar__list`, `mcp__hangar__sync_preview`, …); each spawns `bin/hangar` exactly as a person
would type it, so a tool and a shell command can never disagree about what happens. **Prefer the
tool**: its parameters are typed, so a flag cannot be misspelled and `resume`'s `-n` trap does not
exist there. Reach for the shell for anything the tools do not cover — and note the two are
permissioned separately, so an answer about one says nothing about the other.

**If this session was launched in a mode, that mode's file is your remit and outranks a habit.**
`hangar claude` starts Claude Code with `.claude/modes/<mode>.md` appended to the system prompt
and `.claude/modes/<mode>.settings.json` as their permission rules — read once, at startup, so
neither you nor the user can switch without restarting. Operator mode is denied writes to
`app/**`, `.claude/skills/**` and `.claude/modes/**`, is denied `hangar claude` itself, and
pre-approves the reporting commands below. A session started as a bare `claude` from anywhere but
the hangar root has neither, and the defaults in this file apply — **including a bare
`claude --resume` of a session that WAS in a mode**, which comes back with none of its rules.
**The status line is the tell: it reads a red `NO MODE` instead of `OPS` or `DEV`.** Resume
through `hangar claude --resume <id> -m <mode>` to keep them.

## Addressing a clone

By **index**: `hangar status 2`, `sync 3`, `open 1`. `clone_02` and `02` are accepted too. Output
prints the index (`● 1`).

**Never infer which clones exist** — not from the numbering, not from a directory listing you saw
earlier, not from anything in a `CLAUDE.md`. Run `hangar list`. Clones come and go and index gaps
are normal: `remove-clone` never renumbers, because renumbering would move another clone's ports out
from under a running server.

## What is yours to run, and what is not

Everything in the left column only reports. Run these freely, and prefer them as the first move.
**In a mode session this split is mechanical rather than remembered**: every reporting command and
every dry run is a tool in operator mode's `allow` list, and everything that acts is in `ask`. If a
tool call goes through without stopping, it reported.

| Reports only | Acts |
| --- | --- |
| `list`, `ports`, `status` (`--fetch` reaches the network but touches no tree), `doctor` **bare**, `colours list`, `config show`, `config validate`, `resume` (see below) | `sync` / `merge-default` / `rebase-default`, `checkout-default`, `open`, `add-clone`, `install`, `remove-clone`, `colours change`, `doctor --fix`, `setup`, `teach-rg`, `config schema`, `ide <kind> sync`, `colours sync`, `tmp merge`, `plans collect`, `plans stamp` |

**The hangar's own `CLAUDE.md` reserves seven of those for the user, from the hangar root:** `sync`
under any of its three names, `checkout-default`, `open`, `add-clone`, `install`, `remove-clone`,
`colours change` and `doctor --fix`. They move git state, move files between live working trees, or
open terminal windows.

So the default for those seven is: **run the dry run yourself, report what it says, and hand the
real command over** — a copy-pasteable line, not a description of one. If the user has told you in
this session to go ahead and run them, do that instead; this is a default, not a refusal. Say which
you are doing.

**`doctor --fix` deserves its own sentence.** `doctor` bare is a report and safe. `--fix` writes
into every clone's working directory, so it is the user's.

**The two paths to it are governed differently, and that is worth knowing before you read a
permission answer.** In the shell they differ by one flag, so a `Bash(hangar doctor:*)` pattern
that pre-approves the report pre-approves the writer too — there is no way to separate them, which
is why so few shell commands here are pre-approved at all. As tools they are `doctor` and
`doctor_fix`, two names with two rules, and the report is pre-approved while the writer asks. Same
for every `<thing>_preview`. So the tools give a better default door; they do not close the old
one, and `hangar doctor --fix` typed at a shell is still reachable under the coarse rule.

## Habits

- **Preview first, always, on anything that acts** — it prints every decision the real run would
  make and changes nothing. Report it before proposing the real thing. In the shell that is `-n`;
  as a tool it is a *different tool*, `<thing>_preview`, because an MCP permission rule cannot
  match on arguments and a `dry-run` parameter would put the preview and the real run under one
  rule. That is also why the preview is the one that is pre-approved.
- **Three acting commands have no preview:** `add-clone`, `remove-clone`, `colours change` — and
  so neither do their tools. For those, the report is `hangar list` / `hangar status <n>` /
  `hangar colours list` beforehand. For `doctor`, the bare command *is* the dry run (`doctor`, the
  tool, against `doctor_fix`). For `config schema`, `--check` is (`config_schema_check`).
- **`hangar resume -n <count>` is `--limit`, not `--dry-run`.** The only place in this CLI where
  `-n` does not mean "change nothing". It is harmless here because `resume` only reads, but do not
  carry the habit into a command where it would matter. The tool is `resume_list` and its parameter
  is called `limit`, so the trap is a shell-only one.
- **Every command refuses to run without `hangar.config.yaml`.** Only `setup` (which writes it) and
  `jira hook` (a fail-open `PreToolUse` hook) are exempt. If you see that refusal, the fix is
  `cp hangar.config.example.yaml hangar.config.yaml`, which the error already says.
- **`hangar: command not found` means direnv has not loaded**, not that the tool is missing. It is
  on PATH only inside the hangar root or a clone, via direnv. Ask the user to run `direnv allow` at
  the hangar root.
- **`this hangar is not bootstrapped yet` is a different failure**, and it names which of the two
  causes applies: no `node` on PATH (direnv has not loaded) or no `app/node_modules` (the CLI's own
  dependencies were never installed). The message carries the exact command; run it rather than
  guessing. `hangar jira hook` is exempt and stays silent, so a hook never blocks a tool call over
  this.
- **Which hangar a command acts on is `--hangar <path>`, then the nearest `hangar.config.yaml`
  above the working directory, then `HANGAR_ROOT`** — and every command honours all three. The
  walk outranks the variable deliberately: a shell still carrying `HANGAR_ROOT` for one hangar
  while standing in another acts on the one it is standing in. `hangar config show` prints which
  mechanism answered (`found by walk`), which is the fastest way to settle "why did it do that".

## `sync` will be killed by the default Bash timeout

**The highest-consequence line here.** The Bash tool defaults to 120 seconds. When `sync` hits
conflicts it delegates them to a headless `claude -p` inside the clone that takes **one to three
minutes** and is not aborted until ten (`ORCH_UTIL_RESOLVE_TIMEOUT_MS` overrides). A killed `sync`
leaves the half-applied rebase that `sync` itself refuses to start on — so the next run also fails,
and the user's work is in a stash nobody thinks to look in.

Run it with `run_in_background: true`, or `timeout: 600000`. **Never bare.** The same goes for
`add-clone`, which clones a repo and runs its install steps.

**These two are the exception to preferring the tool.** A tool call has no timeout you can set and
no background mode; it runs under Claude Code's own MCP timeout, and a `sync` cut off there leaves
exactly the half-applied rebase described above. So use `mcp__hangar__sync_preview` to report, and
hand the real `sync` to the user as a shell line — which is what you were going to do anyway.

While the resolver runs it streams a dim line per tool call. That is progress, not a hang.

## Four commands ask a human, and you are not one

`confirm()` reads from `/dev/tty`, so with no terminal — your situation — it returns **false**. Each
of these then **skips and prints why**. Nothing destructive happens; the risk is reading
`left alone` as `done`. Report the skip, do not retry.

**A tool call is in the same situation and inherits the same protection**, which is why
`remove_clone` can detach a clone and can never delete its files. Do not read the permission
prompt in front of an acting tool as having answered one of these gates: it approved the call, and
the command then asked its own question of a terminal that is not there.

Only two have a clean escape:

- **`teach-rg -y`** and **`setup -y`** — the confirmation is the only gate, and `-y` answers it.

The other two do not, and naming a flag for them would be wrong:

- **`checkout-default`, live session in the clone.** `--include-busy` skips the question, but the
  question *is* the protection — this command switches a branch under a working agent and, unlike
  `sync`, sends it no message. Do not pass `--include-busy` on your own initiative; it is the
  user's call.
- **`sync`, "some sessions could not be reached".** `--no-session-notify` does **not** answer this
  gate — it skips notification entirely, so no live session is ever paused. That converts the gate
  into exactly the failure `SYNC PAUSE` exists to prevent: two agents editing one file. If sessions
  cannot be reached, hand the command to the user.

**`resume` with no terminal degrades usefully:** instead of the interactive picker it prints the
session list, which you can read and relay. You cannot pick from it — which is also why it counts as
a report in your hands and not in the user's: at a real terminal, picking a row runs
`claude --resume` in that window.

## Reading the output

`reference/reading-output.md` covers the rows that appear only when there is something to say
(`status`'s `pending` and `sync stash` — a clone showing neither is the healthy case), the
`(default)` marker on a port meaning direnv never loaded, and which `doctor` rows warn rather than
fail.

Two more, for questions that arrive often:

- `reference/colours-and-terminal.md` — the per-clone colour identity, how to change a hue, which
  terminals get which paint layer, and the `HANGAR_CLONE*` variables.
- `reference/settings-layering.md` — which key belongs in which of the three settings files, why
  the hangar root carries no `permissions` block, and the rule that a running session never sees a
  change to either of the files it read at startup.

## One prohibition worth repeating

If you are running inside a clone rather than at the hangar root: **`hangar sync <your own index>`
starts with `git stash push --include-untracked` on the tree you are working in.** The busy-clone
skip applies only to `--all`. Naming a clone explicitly does not protect it.
