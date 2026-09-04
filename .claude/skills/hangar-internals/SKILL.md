---
name: hangar-internals
description: Design rationale for the hangar fleet CLI — why sync asks Bitbucket for a branch's pull-request target instead of guessing the default branch, why merge-default reads its own name out of process.argv, how tmp merge collapses a ticket's many cached names onto one inode, what ide vscode sync rewrites per clone and what it refuses to write, what doctor checks and the two rules for anything generated into a clone, the Jira hook's fail-open contract, and why forge.defaultBranch is stored rather than re-derived. Load before editing app/src/** or debugging a sync, rebase-default, checkout-default, open, resume, tmp merge, plans collect, jira hook, ide sync, colours or doctor run. This is the why; app/CLAUDE.md is the how, and hangar-ops is the command surface.
---

# `hangar` internals

Why each command is built the way it is. This is the half of the hangar's `CLAUDE.md` that only
matters when you are **changing or debugging the CLI**, kept out of that file because it sits above
every clone and so was loaded into four sessions that can act on almost none of it.

**Every "this exists because it caught something" note is load-bearing.** The fleet has no test
suite, so these paragraphs are the regression record — the only surviving account of a bug that was
fixed and must not come back. When you change behaviour, update the note. When you tidy prose, leave
them alone.

## Read the right file, not all of them

The depth is in `reference/`, one subsystem per file. **They are not loaded until you read one**, so
take the one that matches what you are touching:

| If you are… | Read |
| --- | --- |
| changing `sync`, `merge-default`, `rebase-default` or `checkout-default`; debugging a `SYNC PAUSE`, a stash that did not come back, or the headless conflict resolver | `reference/sync.md` |
| changing `tmp merge`, `plans collect`, `jira hook` or the ticket record store; explaining a `.from-clone_NN` copy, a lost `relation:` key or a denied fetch | `reference/jira-cache.md` |
| changing `ide <kind> sync`, any `editor/*.ts` driver, or the per-clone absolute-path rewriting | `reference/editors.md` |
| changing `open`'s window handling or `resume`'s session discovery | `reference/terminal-and-sessions.md` |
| changing the zod schema, the loader, discovery, the no-config gate, or `forge.defaultBranch` | `reference/config.md` |
| changing `doctor`, any generated per-clone artifact, or the plan archive | `reference/doctor.md` |
| changing the `hangar-ops` / `hangar-dev` launch modes, their permission rules, or what a hangar-root session is told it is | `reference/modes.md` |

Two things are deliberately elsewhere:

- **The code map, the seams, and the two conventions for changing this CLI** are in
  `app/CLAUDE.md`, which Claude Code loads by itself the first time a session reads any file under
  `app/`. So they are already in context whenever you are actually editing; read that file directly
  if you have not touched `app/` yet, because the two conventions govern every edit here.
- **The command surface** — every flag, every default, which commands only report — is the
  `hangar-ops` skill. It is the operator's manual; this is not.

## The three things that decide most arguments

Stated here because they cut across every reference file:

- **A wrong answer that typechecks is the failure mode this CLI is built against.** Almost every
  value in it is a bare `string` — a clone path, a branch name, a port, a theme name — so a
  mis-wired one lints, formats, passes review and then writes into the wrong directory or aims a
  health check at a sibling's port. That is why `forge.defaultBranch` aborts instead of guessing
  `master`, why a rendered VS Code file still containing another clone's index is a hard error, and
  why `doctor` compares generated files by CONTENT and never by presence.
- **Degrade one capability at a time; never gate globally.** The editor and terminal seams declare
  what a driver can do rather than pretending the implementations are equivalent, and every caller
  drops exactly the capability that is missing. A clone configured `[zed, vscode]` cannot lose
  VS Code to Zed's launcher; GNOME Terminal cannot receive a `SYNC PAUSE` and says so once.
- **A check that is red in normal operation is a check nobody reads.** This is why `doctor` warns
  rather than fails on a `forge.defaultBranch` that disagrees with a clone's `origin/HEAD`, why how
  much of the shared cache a clone has linked is deliberately not checked at all, and why
  `tmp merge` leaves anything written in the last two minutes alone instead of reporting it.

## Changing this skill

The reference files are relocations, not rewrites: their text is the same text that was in
`CLAUDE.md` and in this file's previous single-body version. Add to them; do not summarise them. If
a new subsystem needs its own file, add a row to the table above — the table is the only index, and
a reference file nothing points at is a file nobody loads.
