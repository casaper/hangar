---
name: shorten-comment
description: |
  Shortens or removes a code comment based on whether it carries information the code can't already communicate. Use this whenever the user asks to "shorten", "trim", "clean up", "condense", or "remove" a comment, doc block, JSDoc, or inline comment — whether they point to it by file+line, paste text, or just say "look at this comment". Also trigger when the user says "is this comment necessary?", "this doc is too long", "clean up the comments here", or points to a block that looks boilerplate or redundant. Pointing at a single line is enough — a bundled script finds the whole block and the declaration it is attached to. Runs at three aggressiveness levels, `low|medium|high`, defaulting to `medium`. Scope: targets build/business-logic files (components, templates, services, types, SCSS) and skips test, story, config, generated, and doc files unless explicitly overridden.
argument-hint: '[file-path-ref] [low|medium|high]'
allowed-tools: Read, Edit, Grep, Glob, Bash, Explore
---

# Comment Shortener

Evaluate whether a comment earns its place, then either remove it entirely or rewrite it as tight as possible.

## Step 0: File-scope gate

Run this **before any comment evaluation**. This skill trims comments in code that ships in the build; it leaves test, story, config, generated, and doc comments alone.

Resolve the file the comment lives in (from the file-path ref). If working from pasted text with no path, ask which file it belongs to.

`comment-at.mjs` (Step 2) prints this verdict for you as its `scope:` line, so the usual order is
one script call and then this table only when it says out of scope.

**Skip — do not trim — when the path matches any excluded pattern:**

| Pattern                                   | Why excluded                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `**/*.spec.ts`                            | Jest + Playwright tests — comments describe test intent / arrange-act-assert |
| `**/*.stories.ts`, `**/*.story.ts`        | Storybook stories — comments describe story setup                            |
| `**/*.config.ts`, `**/.storybook/**`      | Tooling config                                                               |
| `**/models/generated/**`                  | Generated OpenAPI models — regenerated on build                              |
| `**/serviceworker/**` + MSW handler files | Mock infrastructure                                                          |
| `**/*.md`, `**/*.mdx`                     | Docs / prose, not code comments                                              |

**In scope — proceed normally:** `*.component.ts`, `*.component.html`, `*.service.ts`, other `.ts` source outside `generated/`, `.scss`, and any other code that ships in the build.

**Override:** if the user has _explicitly_ asked to trim a comment in a named excluded file, proceed anyway — state once that the file is normally out of scope, then continue.

On a plain skip (no override): tell the user the file is out of scope for this skill and stop. Make no edit.

## Step 1: Refactoring-first check

Before evaluating the comment, ask whether the _code_ is the real problem.

A comment that exists because the code is unclear is a refactoring candidate, not a trimming candidate. Flag it to the user and stop — do not trim.

Refactoring is the better fix when:

- The comment restates an opaque variable or function name (rename the identifier instead)
- The comment summarises several lines that could become a named helper
- The comment explains a condition that could be extracted into a well-named boolean

If none of the above apply, proceed to Step 2.

## Step 2: Locate the comment

**By file + line — one call, and it does all of the locating:**

```bash
node .claude/skills/shorten-comment/comment-at.mjs <file>:<line>
```

Point it at any line of the comment **or at the line of code the comment sits above** — both
resolve to the same block, and the output says which reading it used. It returns the block's exact
span and kind, the scope verdict for Step 0, whether the block is a directive comment, the
declaration it is attached to (brace-balanced, so a whole method body rather than one line), and:

- **the `old_string` to hand to Edit in Step 6.** This is the part worth the call. Edit refuses a
  non-unique `old_string`, and an identical one-liner above three properties is common enough that
  the obvious answer fails; the script grows the slice by whole lines — **backwards**, so the
  comment stays at the end and the following declaration is not dragged into the replacement —
  until it matches nothing else in the file. Use it verbatim.

`--context <n>` bounds the attached code (default 60 lines, `0` to suppress); `--json` for
scripting. Exit `3` means the line holds no comment and none is attached to it — the output names
the nearest blocks above and below, so re-aim rather than guess.

**By selection / paste**: work with the provided text, and ask which file it belongs to so Step 0
can run at all.

Whichever route, judge against the **code the comment is attached to** — the whole decision depends
on what the code already communicates, and the script's `attached to:` block is there to supply it.

## Step 3: Apply the WHY test

A comment earns its place only when it answers "why" or reveals something the code literally cannot show.

**Keep if any of these are true:**

- Explains a non-obvious constraint, invariant, or side-effect ("do not remove this binding — it triggers the first SSRM `getRows`")
- Documents a workaround for a specific bug or library quirk
- Describes intent behind an unusual implementation choice
- The function name + parameter names together cannot convey it

**Drop if any of these are true:**

- Restates the identifier in plain English (`getUser()` → "Gets the user")
- Describes **what** the code does rather than **why** it does it that way — these comments will diverge from reality when the code changes
- Explains standard library / framework behavior a reader can look up
- Is a prose summary of something the type signature already expresses
- Is already documented in a nearby comment or the same concept appears twice
- Is obvious to any developer familiar with the language or framework

**Comment decay test** — ask: "Will this comment still be true when the code changes?"
If "no" or "maybe", it is a _what_ comment masquerading as a _why_. Remove it.

### Tag-specific guidance

TypeScript's type system makes some JSDoc tags redundant. Use this table to decide quickly:

| Tag                                 | Value in TypeScript                                | Action                                                                                                    |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@throws`                           | Types cannot express when/why errors occur         | **Keep** — document the condition and exception type                                                      |
| `@example`                          | Types cannot show usage patterns or edge cases     | **Keep** — focus on non-obvious cases                                                                     |
| `@deprecated`                       | Not in types                                       | **Keep** — must state _why_ deprecated and what to use instead                                            |
| `@see`                              | Not in types                                       | **Keep** — link to related symbols or docs                                                                |
| `@remarks`                          | Not in types                                       | **Keep** if the body passes the WHY test above                                                            |
| `@type {T}`                         | Redundant — already in the TypeScript signature    | **Remove**                                                                                                |
| `@param {T} name`                   | Type part is redundant; description may have value | **Remove the `{T}`; keep the description only if it documents a constraint or invariant not in the type** |
| `@returns {T}`                      | Type part is redundant; description may have value | **Remove the `{T}`; keep the description only if the return behaviour is non-obvious**                    |
| `@param name` (obvious description) | Restates the identifier                            | **Remove**                                                                                                |

> "JSDoc must not repeat what TypeScript's type system already expresses." — Google TypeScript Style Guide

When in doubt, re-read the code. If a reader would understand the code without the comment, the comment is noise.

## Step 4: Decide

| Outcome                                | Action                                  |
| ---------------------------------------- | ------------------------------------------ |
| Comment exists because code is unclear | **Flag for refactoring** (Step 1)       |
| Nothing survives the WHY test          | **Remove** the entire block             |
| Some sentences survive                 | **Rewrite** with only those sentences   |
| Everything survives but is verbose     | **Shorten** — same meaning, fewer words |

### Examples

**Redundant `@param` type vs. constraint that adds value:**

```ts
// ❌ Remove — type is in the signature; description restates the name
/** @param {string} userId - The user's ID */
async getUser(userId: string): Promise<User>

// ✅ Keep — documents a constraint the type cannot express
/** @param userId - Must be non-empty; caller is responsible for validation */
async getUser(userId: string): Promise<User>
```

**What comment (will decay) vs. why comment (stays true):**

```ts
// ❌ Remove — describes what the code does; will lie when the sort key changes
// Sort items by creation date
items.sort(byCreatedAt);

// ✅ Keep — explains the decision; stays true even if the sort key changes
// Stable insertion order required — UI diffs are noisy if sort is non-deterministic
items.sort(byCreatedAt);
```

**Refactoring candidate — rename instead of trimming:**

```ts
// ❌ Don't trim — the comment exists because the name is opaque; trim fixes nothing
// k = retry backoff multiplier in milliseconds
const k = 250;

// ✅ Rename; no comment needed
const retryBackoffMs = 250;
```

## Aggressiveness: `low` | `medium` | `high`

**`medium` is the default and is exactly Steps 3 and 4 as written above.** The other two are
modifiers _around_ that judgment, never edits to it — if a level seems to need the WHY test or the
tag table changed, the level is being read wrong.

| Level              | What it changes                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `low`              | **Never deletes a whole block.** Anything Step 4 would remove is instead rewritten to its shortest true form; if literally nothing survives, leave the block and report `would delete at medium`. The tag table still applies _inside_ the block, so redundant `{T}` types and name-restating `@param`s still go.           |
| `medium` (default) | Steps 3 and 4, unmodified.                                                                                                                                                                                                                                                                                                  |
| `high`             | Step 4 plus: delete any block that is not a constraint/invariant/side-effect, a bug or library workaround, or the intent behind an unusual choice. Drop `@example` and `@remarks` that only restate what the signature already shows. Collapse every surviving multi-line block to single-line wherever it fits ~100 chars. |

**The floor no level crosses.** `@throws`, `@deprecated` and `@see` are never removed — nothing in
the code or the types can recover what they say. Neither are directive comments
(`eslint-disable`, `@ts-expect-error`, `prettier-ignore`, `#region` and friends): they carry machine
meaning, and `high` is not a licence to break lint.

**Step 1 is level-independent.** A comment that exists because the code is unclear is flagged and
left alone at `low`, `medium` and `high` alike — trimming it fixes nothing and deleting it loses
information, at any aggressiveness.

Pick `low` for shared or public API and for files you do not own; `high` when the user has said the
comments are bloated and wants them gone. **State the level you ran at** in your response — the
same comment legitimately gets three different verdicts, and a report that omits which one is
unreadable a week later.

## Step 5: Format

All low-level formatting (asterisk alignment, line spacing, tag gaps, `*` prefixes) is auto-fixed — write the content and let the formatter handle style; never align by hand. Run `node .claude/skills/format/format.mjs <touched files>` as a clean-up once the work is majorly done, or leave it to `lint-staged` at commit.

**What you must get right (not auto-converted):**

### Single-line vs multi-line

The linter does NOT convert between forms — choose based on text length.

- **Single-line** (≤ ~100 chars): `/**` and `*/` on the same line.
- **Multi-line** (> ~100 chars): `/**` alone on its opening line (`jsdoc/multiline-blocks`).

```ts
/** First emission triggers SSRM `getRows` — do not remove the `[columnDefs]` binding. */
readonly currentColumns = this.colSchemaService.currentColumns;
```

```ts
/**
 * Back-compat alias for the previous `modules` signal.
 * `ModuleEntity extends ModuleState` so all existing field reads still compile.
 */
modules: computed<ModulesState>(() => store.entityMap()),
```

#### Where to wrap a multi-line block

`eslint --fix` does NOT reflow JSDoc prose — it preserves the line breaks you write. So
**you** choose each wrap point. Break at clause or phrase boundaries, not wherever the
~100-char margin happens to fall.

Rule: **for the same line count, move the break to the most natural boundary.** Prefer, in
order, a sentence end → a comma or clause joint (`so`, `because`, `but`, `which`) → a
phrase gap. Never split a parenthetical, a `{@link}`, or a `code span` across the wrap when
keeping it whole costs no extra line.

```ts
// ❌ Margin-driven wrap — splits the parenthetical across two lines
/**
 * Includes `formGroupsArray.statusChanges` so async-validator transitions (PENDING → VALID or
 * INVALID) refresh footer button state.
 */

// ✅ Clause-driven wrap — the parenthetical stays intact
/**
 * Includes `formGroupsArray.statusChanges` so async-validator transitions
 * (PENDING → VALID or INVALID) refresh footer button state.
 */
```

```ts
// ❌ Same two lines, but the break lands mid-clause
/**
 * Drafts are stored in sessionStorage, which is isolated per tab, so opening the same form in
 * another tab starts fresh.
 */

// ✅ Same two lines — break moved onto the comma boundary
/**
 * Drafts are stored in sessionStorage, which is isolated per tab,
 * so opening the same form in another tab starts fresh.
 */
```

### Inline comments

`//` with a space. Never `/* */` for non-JSDoc content — banned by `jsdoc/no-bad-blocks`.

```ts
// Visibility events fired during init are not user actions; refresh here corrupts column order.
if (something === xy) return;
```

### TSDoc tag syntax

Tags must be valid TSDoc (`tsdoc/syntax` warns). See the tag table in Step 3 for value judgments.

Custom tags defined in `tsdoc.json` for this project: `@default`, `@export`, `@note`, `@remark`, `@switch`, `@type`

### Removal

Delete the entire block including surrounding blank lines. No placeholder, no `// removed`, nothing.

## Step 6: Apply

Use the Edit tool with the **`old_string` Step 2 printed**, verbatim — it is already grown to be
unique in the file, which is the one thing Edit will refuse over. Do not retype it from a Read, and
do not reformat or touch any surrounding code.

When the `old_string` was grown, the extra lines are context: reproduce them unchanged in
`new_string` and change only the comment. Removing a block means `new_string` is those context lines
alone.

Then report per **Reporting** below — for a single comment that is the rewritten line and the
level, and nothing else.

## Reporting — the edit is the verdict

**Owned here; `shorten-changed-comments` and `shorten-all-comments` honour it, workers included.**
The user reads the diff, not an account of it, and a sentence of justification per block is the
slowest part of every sweep.

- **Never write the reasoning out.** Not why a block went, not why one stayed, not which clause of
  the WHY test decided it. Steps 3 and 4 are how you decide, not what you say.
- **One line per changed block**, nothing at all for unchanged ones: `path/file.ts:42 — removed`,
  `path/file.ts:17-20 — 4→1`. No before/after pair, no quoted comment text.
- **Unchanged and directive blocks are a count**, never a list.
- **Say the level once**, in the first line — never per block.
- **No progress commentary** between blocks or between files.
- **Two exceptions, because there the reason _is_ the deliverable:** a refactor flag carries the
  rename or extraction you would suggest, and anything you could not resolve says what blocked it.
- **A single comment** (this skill on its own): print the rewritten line and the level. That is the
  whole report; a removal is the word `removed` and nothing else.
- Asked afterwards why a particular block went, answer then. Answering in advance, for thirty
  blocks, is what this section exists to stop.

<!--
Personal override of a same-named project skill. A user-level skill replaces the project's copy
entirely and silently, on this machine, in every repo, so this file -- not the tracked one -- is
what actually runs.

Content and rationale are tracked in the hangar that manages this checkout; `hangar skills list`
reports when the project original moves underneath this override, which nothing else would.

The scripts this skill invokes (comment-at.mjs, format.mjs) stay wherever the invoking repo's
tracked copy is: paths here resolve against cwd, not against this file, so nothing had to be
copied but the prose.
-->
