# The personal tools in `bin/` and the shared skills

Why `hangar-waypoint`, `hangar-commit-gate`, `hangar-rewrite` and `hangar-exec-guard` are scripts
rather than `hangar` subcommands, what each refuses, and how `personal-skills/` links. Moved out of
`app/CLAUDE.md`, which dev mode loads in full at startup.

- **`bin/hangar-waypoint` and `bin/hangar-commit-gate`** — the two personal tools every clone gets
  on PATH, and the reason both are scripts rather than `hangar` subcommands is the one
  `hangar-exec-guard` already records: the gate is a `PreToolUse` hook that runs before EVERY Bash
  call, where loading `cli.ts` costs ~0.25s of type stripping against a bare node start, and the
  waypoint is typed often enough for the same argument to hold. They are CommonJS, because the
  hangar root's `package.json` declares no `"type"` — do not "modernise" them to `import`.
  `waypoint` is pre-approved WHOLE, `restore` included, and that rests on two properties together:
  a restore records an undo snapshot before it writes, AND it refuses any path resolving to the
  repo root. The gate is pre-approved only as `status`; `lock`, `release` and `unlock` prompt,
  because an agent that can release its own gate has no gate — and the hook refuses those verbs
  and any command naming its own state file, because a permission rule matches only the START of
  a command string and `hangar-commit-gate status && … release` sails straight past one.
- **`bin/hangar-rewrite`** — amend, fixup, autosquash, rebase and reset, for history that has
  never been published. A blanket "never rewrite" rule is a proxy for the thing that actually
  matters, which is never rewriting what other people already have; this enforces the real rule
  instead of the proxy, by refusing any commit reachable from a remote-tracking ref. Every verb
  records a waypoint first, so all of it is undoable. **It is deliberately absent from
  `personalToolAllows`** — rewriting history should be asked for, never reached for, and absence
  is what makes every call prompt. **A verb that replays commits must never exit with the
  operation stopped**: a repo rule that denies `git rebase` denies `--abort` and `--continue` with
  it, so the verb aborts itself and says so. Arguments naming `origin`, `push` or `remote` are
  refused, which is why `rebase` takes a bare branch name. **Test it in a scratchpad fixture,
  never a clone, and publish by fetching**: `hangar-exec-guard` refuses `git push` even to a bare
  scratch remote, so the fixture fetches the branch into its upstream (`git fetch ../w feat:feat`)
  instead. Edit a scratch copy and `mv` it into `bin/`, because the file is live fleet-wide the
  moment it is saved.
- **`bin/hangar-exec-guard` also refuses publishing**, and the remit widened with `hangar-rewrite`
  rather than before it: a rewritten branch has diverged from its remote, which is the one moment
  a force-push looks like the obvious next step. The capability and the refusal were one decision.
  It covers `push`, `send-pack`, `http-push`, `gh pr create|merge` and hangar's own
  `pr create|update` unless the invocation carries `-n`, token-based so
  `git log --grep=push` and a file called `push.ts` survive. A managed repo may forbid pushing in
  its own rules; this is not per-project, and holds in a fresh clone and in a repo that has no
  such rule.
- **`personal-skills/` is tracked, and is the one thing this repo writes OUTSIDE its own root.**
  `hangar skills sync` links `~/.claude/skills/<name>` at it, which shadows a same-named project
  skill entirely and silently. **It is also the one artifact that cannot carry the hangar id** —
  the directory name is what makes a skill shadow, so `<id>-<name>` would shadow nothing. The
  collision with a second hangar is therefore made INSPECTABLE rather than named away: `sync`
  reads the existing link's target and refuses when it belongs elsewhere. `--adopt` replaces a
  real directory only when its content already matches byte for byte, so the failure mode is a
  refusal and never a discarded edit.
  **A new skill there also needs a row in `personal-skills/manifest.yaml`** — `name`, a
  `divergence` (`standalone` when no tracked skill carries its name) and a `reason` — then
  `hangar skills sync -n`, `sync` and `list` to link it.
