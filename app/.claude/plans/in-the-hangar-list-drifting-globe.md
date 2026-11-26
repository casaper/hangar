# `hangar list`: show whether each clone has a tmux session

## Context

`hangar list`'s CLONE cell is `● <index>` in the clone's hue for every clone. The user wants it
to say whether that clone is open: a clone with a session on the hangar's tmux server
(`tmux -L hangar-<id>`) keeps the filled `●`; a clone without one gets a thin hollow `○`, still
in its hue. A glyph, not a colour, so it survives `NO_COLOR` and the MCP tool's stripped output.

## Approach

- `src/ui.ts`: add `HOLLOW_BULLET = '○'` (U+25CB, same width as `●`) and a pure
  `cloneMark(clone, open: boolean)` that paints `${open ? BULLET : HOLLOW_BULLET} ${index}` in
  the clone's hue. `cloneLabel` stays as is (every other command's heading keeps `●`).
- `src/commands/list.ts`: call `tmuxServer(hangar).sessions()` ONCE (one `list-sessions`, read
  only; returns `[]` when tmux is missing or no server runs — then every clone is `○`). Build a
  set of open clones matching `row.clone === clone.name || row.name === tmuxSessionName(clone)`,
  the same two keys `doctor.ts:1024` uses, and render the CLONE cell with `cloneMark`.
- No legend line after the table — two glyphs, documented in the operator notes. (Easy to add
  if wanted.)

## Docs

- `.claude/skills/hangar-ops/reference/command-notes.md` (the `hangar list` bullet, ~line 414):
  one sentence — `●` the clone has a session on the hangar's tmux server, `○` it does not.
- Grep `● ` claims in both CLAUDE.md files, `ops.md` and the skills for anything describing the
  list's CLONE cell, and update in step.

## Tests

- `test/list.test.ts` (or a ui test): `cloneMark(clone, true)` starts with `●`, `false` with
  `○`, both carry the index and have equal `visibleWidth`. Use `syntheticHangar()`/fixture clone.

## Verification

- `cd app && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
- `pnpm golden && git diff --exit-code dev/golden/gated` (expect no diff: list is not captured)
- `pnpm scan`
- Run real `hangar list` in the terminal: open clones `●`, closed `○`; `hangar list | cat` and
  `NO_COLOR=1 hangar list` still distinguish them.

## Commit

`feat(list): Show which clones have a tmux session, filled dot open and hollow closed`

## Tasks

- [x] `cloneMark` + `HOLLOW_BULLET` in `ui.ts`
- [x] `list.ts` reads sessions once and uses `cloneMark`
- [x] Test in `test/list.test.ts`
- [x] `command-notes.md` sentence (+ any other prose found by the grep)
- [x] Gates + manual run

## Standing tasks — keep this plan current
- [x] After every finished task: tick its box, note deviations or deferrals, and **stage this
      file in the same commit** as the work it records. Never batch plan updates afterwards.
- [ ] Last commit: `git rm` this plan.
