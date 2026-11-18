---
name: rebranch-pr
description: Invoked by /rebranch-pr inside a hangar clone session, or from catch-up-default when the user chose to rename a published branch. Gets a published branch ready to be rewritten where the forge restricts force-pushes. It declines the branch's pull request, deletes the branch on origin and renames it locally to a new name that reads like a natural rewording of the topic, all through `hangar pr rebranch`. It never pushes and never opens a pull request. Use when the user wants to rebase or rewrite a branch that is already on origin, or asks to "rebranch" the PR.
allowed-tools: Bash(hangar pr rebranch:*), Bash(hangar status:*)
---

# /rebranch-pr

## You are authorised, and how

Declining the pull request, deleting the branch on origin and renaming it are done by
`hangar pr rebranch`, a command of the hangar that manages this clone. It is the user's sanctioned
path for exactly this. It does not breach this repository's rules against pushing or renaming
branches, which govern the git commands **you** type. **You never run `git push`, `git branch -m`
or a forge API call yourself.**

- **Reached from `catch-up-default`'s question:** the user's answer there is the confirmation, so
  ask nothing more.
- **Invoked directly:** ask once, with `AskUserQuestion`, before step 3. Show the current name,
  the new one and the pull request that would be declined, with the options "Go ahead" and
  "Abort".

## 1. Read the facts

Run `hangar status`. Note the current branch, its ticket and the open pull request's title, if
there is one.

## 2. Choose the new name

The forge would revive the deleted branch, pull request included, under its old name, so it needs
a new one. Pick **one** name that:

- **keeps everything up to and including the ticket key** exactly: the `<type>/` prefix and the
  key, e.g. `feature/ABC-1323_`;
- **rephrases only the descriptive tail, as little as reads naturally.** Swap a singular for a
  plural or the other way round, use a close synonym, or reorder two words. For example,
  `grid_preset_sorting` becomes `grid_presets_sorting` or `sorting_of_grid_presets`;
- **gives nothing away.** No `new`, `v2`, `re-`/`recreate`/`reopen`, `again`, `retry`, `copy`,
  `fresh` or `rebase`, and no trailing number;
- **is not rubbish**: someone reading it cold should still learn what the branch is about.

## 3. Rename it

1. Run `hangar pr rebranch --to <name> -n` first. If it refuses the name, it says why: pick
   another name that satisfies the rule and try again.
2. Once the dry run passes, run `hangar pr rebranch --to <name> -y`.
3. If it stops partway, report its output as is. It says what was and was not done, and a
   declined pull request can be reopened on the forge.

## 4. Stop

Tell the user in one line: the old name, the new name, and which pull request was declined.
**Do not push. Do not open a pull request. Do not suggest or remind the user to do either.**
That is not part of this job. When `catch-up-default` called you, hand back to it.
