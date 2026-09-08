import pc from 'picocolors';

import { openPullRequests, repoRef, type PullRequest } from '../bitbucket.ts';
import { requireDefaultBranch } from '../config/default-branch.ts';
import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import {
  conflictedFiles,
  currentBranch,
  DETACHED,
  git,
  gitTry,
  inProgressOperation,
  refExists,
  remotes,
  syncStashes,
  syncState,
  SYNC_STASH_LABEL,
  type StashEntry,
} from '../git.ts';
import { tmuxServer, tmuxSocketName } from '../tmux.ts';
import { claudeSessionsIn, type ClaudeSession } from '../procs.ts';
import { resolveWithClaude } from '../resolve-conflicts.ts';
import { cloneLabel, confirm, fail, heading, note, ok, step, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar sync` -- bring a clone's branch up to date with whatever it will be merged into.
 *
 * Three things here are not mechanical, and all of them are deliberate choices rather than
 * defaults:
 *
 * 1. A live Claude Code session in the clone is TOLD to pause, by `send-keys` into the tmux
 *    pane on its tty. There is no other mechanism: the `claude` CLI has no subcommand that
 *    messages a running interactive session. If that session has no pane on this hangar's
 *    socket -- started by hand, or in the developer's own tmux -- the command asks the human
 *    instead of rewriting the branch under an agent that is mid-edit. It is also always told
 *    how the sync ended: exactly one `SYNC FINISHED` or `SYNC ABORTED` follows every
 *    `SYNC PAUSE`, sent from a `finally` (see `closeSessions`), because an agent waiting for
 *    a message that never comes waits forever.
 *
 * 2. The target is the branch this one's PULL REQUEST targets, which is not always the
 *    default branch and cannot be worked out locally -- see `resolveTarget`.
 *
 * 3. Conflicts are handed to a headless `claude -p` inside the clone and then verified
 *    mechanically. If that fails during the INTEGRATION the whole operation is aborted and the
 *    pre-sync state restored -- never left half-merged. The last step is the exception worth
 *    knowing: re-applying the stash happens after the integration is already committed, so
 *    when that is what fails, the branch has moved, the working tree holds unmerged paths and
 *    the stash is intact. Which is why the closing message reports the STATE it found rather
 *    than an outcome -- see `inspectAfterSync`. That run streams its progress (see
 *    `resolve-conflicts.ts`), because a silent minute here reads as a hung command and gets
 *    killed -- which leaves the rebase stopped mid-pick, the one state this command exists
 *    to avoid.
 *
 * Rebase vs merge follows the user's rule: rebase only when this is your own branch with a
 * linear history since it forked; merge when someone else started it or it already contains
 * merge commits, because rebasing those rewrites other people's commits. The two ALIASES
 * override that rule -- `hangar rebase-default` and `hangar merge-default` are this command
 * under another name, each forcing one strategy (see `decideStrategy`). What they do not change
 * is the TARGET: all three names integrate onto whatever the pull request points at, so the
 * `-default` in them is the common case rather than a promise.
 */
export type SyncOptions = {
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
  sessionNotify?: boolean | undefined;
  includeBusy?: boolean | undefined;
  onto?: string | undefined;
  strategy?: ForcedStrategy | undefined;
};

/**
 * A strategy the developer asked for, rather than one the rule below worked out.
 *
 * It arrives either as `--strategy` or as the NAME the command was invoked under:
 * `hangar rebase-default` and `hangar merge-default` are aliases of `sync` that force one each.
 * Only these two can be forced -- `up-to-date` and `ff-only` are facts about the clone rather
 * than choices, and there is nothing to force when the branch IS the target or already contains
 * it.
 */
export type ForcedStrategy = 'rebase' | 'merge';

type Strategy =
  | { kind: 'up-to-date'; target: Target }
  | { kind: 'ff-only'; target: Target; reason: string }
  | { kind: 'rebase'; target: Target; reason: string }
  | { kind: 'merge'; target: Target; reason: string };

/**
 * What this clone is being brought up to date WITH, and how sure we are of it.
 *
 * `ref` is what git is handed and is always remote-qualified. A bare branch name would be
 * ambiguous the moment a sibling clone has the same branch -- which in a stacked pull request
 * it does by definition -- and `checkout.defaultRemote=origin` is no help here: it steers
 * `git checkout` DWIM only, not `rev-parse`, `merge-base` or `rebase`.
 */
type Target = {
  readonly branch: string;
  readonly ref: string;
  /** Where this target came from, for the one line that says so. */
  readonly why: string;
  /** True when the PR could not be looked up and this is the default branch as a guess. */
  readonly guessed: boolean;
  readonly pr: PullRequest | undefined;
};

/**
 * The target, in priority order: `--onto`, then the branch's open pull request, then the
 * repo's default branch.
 *
 * The pull request is the authoritative answer and nothing local substitutes for it. A branch
 * cut from `master` may perfectly well have a PR onto `release9`, or onto another branch of
 * this very fleet (a stacked PR -- clone_02's PR onto clone_01's branch is the case this was
 * written for), and every fork-point heuristic confidently answers `master` for all of them.
 * Rebasing onto `master` there integrates the wrong base and burns a three-minute headless
 * conflict resolution deciding against it.
 *
 * Every API failure is a FALLBACK, not an error: a clone with no token, no network or a 401
 * still wants syncing, and it gets the old behaviour plus a warning that the target is a
 * guess. The one thing that does abort is genuine ambiguity -- two open PRs onto different
 * branches, where picking either silently would be worse than stopping.
 *
 * No lookup at all while we are ON the target branch: there is nothing to resolve, and a query
 * for `master` comes back with `master`'s own historical PRs (`master` -> `release9`, merged in
 * 2024), which must never become a sync target.
 */
const resolveTarget = async (
  hangar: Hangar,
  clone: Clone,
  branch: string,
  opts: SyncOptions,
): Promise<Target> => {
  if (opts.onto !== undefined) {
    // A bare name is qualified with `origin/` when that exists, for the ambiguity reason above;
    // anything already qualified (`origin/release9`, `clone_01/some-branch`) is taken verbatim.
    const qualified = `origin/${opts.onto}`;
    const ref = refExists(clone.path, qualified) ? qualified : opts.onto;
    // `branch` must be the BARE name whatever was typed: `chooseStrategy` compares it with
    // `currentBranch()`, so `--onto origin/master` while on `master` has to read as "already on
    // the target" (fast-forward) and not as a rebase of master onto itself.
    return {
      branch: stripRemote(clone, ref),
      ref,
      why: 'given with --onto',
      guessed: false,
      pr: undefined,
    };
  }

  /*
   * Asked AFTER `--onto`, and from the CONFIG rather than from this clone's `origin/HEAD`.
   * Every clone here is a clone of one repo, so its default branch is a property of the hangar:
   * it is resolved once, recorded in `forge.defaultBranch`, and read from there afterwards. A
   * run that was given its base needs none of that, which is why the question is asked here and
   * not at the top -- and `-n` never records anything, so a dry run cannot change the config.
   */
  const defaultBranch = requireDefaultBranch(hangar, { persist: opts.dryRun !== true });
  const onDefault = (why: string, guessed = false): Target => ({
    branch: defaultBranch,
    ref: `origin/${defaultBranch}`,
    why,
    guessed,
    pr: undefined,
  });

  if (branch === defaultBranch) return onDefault(`on the default branch (${defaultBranch})`);
  if (branch === DETACHED) return onDefault('detached HEAD — no branch to look a PR up by');

  const lookup = await openPullRequests(hangar, repoRef(hangar, clone.path), branch);
  if (!lookup.ok) {
    warn(`could not ask Bitbucket which branch this one's PR targets: ${lookup.reason}`);
    return onDefault(`assuming the default branch (${defaultBranch}) — PR target unknown`, true);
  }
  const destinations = [...new Set(lookup.pullRequests.map((pr) => pr.destination))];
  if (destinations.length > 1) {
    throw new CliError(
      `${clone.name}: ${branch} has open pull requests onto ${destinations.join(' and ')}`,
      `Choose one with --onto <ref>: ${lookup.pullRequests
        .map((pr) => `#${String(pr.id)} → ${pr.destination}`)
        .join(', ')}`,
    );
  }
  const pr = lookup.pullRequests[0];
  if (pr === undefined) {
    return onDefault(`no open pull request — the default branch (${defaultBranch})`);
  }
  return {
    branch: pr.destination,
    ref: `origin/${pr.destination}`,
    why: `PR #${String(pr.id)} targets ${pr.destination}`,
    guessed: false,
    pr,
  };
};

/**
 * `origin/master` -> `master`, `clone_01/fixes/x` -> `fixes/x`, anything else unchanged.
 *
 * Only a leading segment that really is one of this clone's remotes is removed, so a branch
 * genuinely called `origin/something` (legal, if perverse) survives.
 */
const stripRemote = (clone: Clone, ref: string): string => {
  const slash = ref.indexOf('/');
  if (slash === -1) return ref;
  return remotes(clone.path).has(ref.slice(0, slash)) ? ref.slice(slash + 1) : ref;
};

/** The target line, printed for every sync so the base is never implicit. */
const describeTarget = (hangar: Hangar, clone: Clone, target: Target): void => {
  note(`target ${target.ref}${target.guessed ? pc.yellow(' (a guess)') : ''} — ${target.why}`);
  if (target.pr !== undefined) note(pc.dim(target.pr.url));
  // Fleet-aware, and print-only: a stacked PR targets a branch a sibling clone is working in,
  // so `origin/<target>` is only as fresh as that clone's last push. Not a reason to stop, and
  // only said of an `origin/` ref -- a `clone_NN/` one IS that clone, fetched.
  const siblings = !target.ref.startsWith('origin/')
    ? []
    : discoverClones(hangar)
        .filter((other) => other.name !== clone.name && currentBranch(other.path) === target.branch)
        .map((other) => other.name);
  if (siblings.length > 0) {
    note(
      pc.dim(
        `${target.branch} is checked out in ${siblings.join(', ')} — ${target.ref} is only as fresh as its last push`,
      ),
    );
  }
};

const chooseStrategy = (clone: Clone, target: Target): Strategy => {
  const ref = target.ref;
  const branch = currentBranch(clone.path);

  if (branch === target.branch) {
    return { kind: 'ff-only', target, reason: `this IS ${target.branch} — fast-forward only` };
  }

  const base = gitTry(clone.path, ['merge-base', ref, 'HEAD']);
  if (base === undefined) {
    return { kind: 'merge', target, reason: `no common ancestor found with ${ref}` };
  }

  const behind = gitTry(clone.path, ['rev-list', '--count', `HEAD..${ref}`]) ?? '0';
  if (behind === '0') return { kind: 'up-to-date', target };

  const merges = gitTry(clone.path, ['rev-list', '--merges', `${base}..HEAD`]) ?? '';
  if (merges !== '') {
    return {
      kind: 'merge',
      target,
      reason: `${merges.split('\n').length} merge commit(s) since the fork — rebasing would rewrite them`,
    };
  }

  // "Did I create this branch?" -- the author of the OLDEST commit since the fork point.
  const authors = gitTry(clone.path, ['log', '--format=%ae', `${base}..HEAD`]) ?? '';
  const firstAuthor = authors === '' ? undefined : authors.split('\n').at(-1);
  const me = gitTry(clone.path, ['config', 'user.email']);
  if (firstAuthor === undefined) {
    return { kind: 'merge', target, reason: 'no commits of our own since the fork' };
  }
  if (me === undefined || firstAuthor !== me) {
    return {
      kind: 'merge',
      target,
      reason: `branch was started by ${firstAuthor}, not you — rebasing would rewrite their commits`,
    };
  }

  return { kind: 'rebase', target, reason: 'your branch, linear since the fork' };
};

/**
 * Which of `sync`'s three names was typed, and so which strategy it forces.
 *
 * Commander records the alias a subcommand was reached by NOWHERE -- `actionCommand.name()` is
 * always the canonical `sync` -- so the invocation itself has to be read. A WHITELIST scan
 * rather than a parser that skips global options: the parser version would be correct only
 * until the second value-taking global option is added, at which point it would silently take
 * that option's value for the subcommand. The only way to fool this one is a directory
 * literally called `rebase-default` passed to `--hangar`.
 *
 * `--strategy` outranks it, so `hangar merge-default --strategy rebase` rebases: the flag was
 * typed for this run, the name is just how the command was reached.
 */
const FORCED_BY_NAME: Readonly<Record<string, ForcedStrategy>> = {
  'rebase-default': 'rebase',
  'merge-default': 'merge',
};

export const forcedStrategy = (argv: readonly string[]): ForcedStrategy | undefined => {
  for (const token of argv) {
    const forced = FORCED_BY_NAME[token];
    if (forced !== undefined) return forced;
    if (token === 'sync') return undefined;
  }
  return undefined;
};

/**
 * The strategy actually used: the automatic choice, unless one was asked for.
 *
 * Pure, and taking the automatic RESULT rather than the clone, so every combination of the four
 * automatic kinds and the three forced values can be printed side by side without a git
 * repository to produce them -- the technique this CLI uses in place of tests.
 *
 * Two of the four automatic kinds are never overridden, because they are not opinions:
 * `ff-only` means this branch IS the target, and `up-to-date` means it already contains it.
 * Forcing a rebase or a merge there would be a no-op at best and a rebase of a branch onto
 * itself at worst.
 */
export const decideStrategy = (auto: Strategy, forced: ForcedStrategy | undefined): Strategy => {
  // Unchanged when nothing was forced AND when the force agrees -- the dry run's output is this
  // command's regression record, so it stays byte-identical whenever nothing was overridden.
  if (forced === undefined || auto.kind === forced) return auto;
  if (auto.kind !== 'rebase' && auto.kind !== 'merge') return auto;
  return {
    kind: forced,
    target: auto.target,
    reason: `asked for with ${forced === 'rebase' ? '`rebase-default`' : '`merge-default`'} (--strategy ${forced}), overriding: ${auto.reason}`,
  };
};

/**
 * The warning for the one override that makes this command do what it otherwise refuses.
 *
 * Forcing a MERGE is always safe -- it is the conservative half of the rule, and choosing it
 * over a rebase costs nothing but a merge commit. Forcing a REBASE over a merge is the opposite:
 * the automatic rule merges precisely when rebasing would rewrite commits that are not ours (a
 * branch someone else started) or that git cannot replay cleanly (merge commits since the fork).
 * That is a legitimate thing to ask for and it is not refused, but it is never done quietly.
 */
export const overrideWarning = (
  auto: Strategy,
  forced: ForcedStrategy | undefined,
): string | undefined => {
  if (forced !== 'rebase' || auto.kind !== 'merge') return undefined;
  return `rebasing as asked, against the rule that would have merged: ${auto.reason}`;
};

/**
 * The word for what is being done, for the messages a live session is sent.
 *
 * `strategy.kind` is not it: `ff-only` is a fast-forward and calling it a rebase in a message
 * that tells an agent to stop editing is the kind of small lie that gets a tool distrusted.
 */
const ACTION: Record<Strategy['kind'], string> = {
  merge: 'merge',
  rebase: 'rebase',
  'ff-only': 'fast-forward',
  'up-to-date': 'sync',
};

/**
 * The messages `hangar sync` types into a live session, and the guarantee they carry.
 *
 * Each one leads with a MARKER -- `SYNC PAUSE`, `SYNC FINISHED`, `SYNC ABORTED` -- and the pause
 * promises that exactly one of the other two follows it. That promise is the whole point: an
 * agent told to stop and wait has no way to tell "still working" from "died three minutes ago",
 * and the honest answer used to be that on five of the six ways this command can stop, nothing
 * ever came. So the closing message is sent from a `finally` (see `closeSessions`) and the marker
 * is what makes it recognisable in a tab full of ordinary conversation.
 */
export const pauseMessage = (hangar: Hangar, strategy: Strategy): string =>
  'SYNC PAUSE — STOP what you are doing and do not edit, stage or commit any file. ' +
  `\`hangar sync\` is about to ${ACTION[strategy.kind]} this clone onto ${strategy.target.ref}. ` +
  'If it conflicts, a separate headless Claude Code run will edit the conflicted files in this ' +
  'working tree — do not touch them yourself, even if asked, or you will both be editing the ' +
  'same file. Exactly one line beginning SYNC FINISHED or SYNC ABORTED will follow this one, ' +
  'saying whether you may resume and what state the working tree is in; nothing else will. ' +
  'Reply that you have paused, then wait for it.';

/**
 * The state of the clone at the moment sync stops, as git sees it.
 *
 * Read from git rather than tracked in flags, because the flags lie: `abortAndRestore`'s
 * `stash pop` can itself fail and only warns, so a `restored` boolean set beside it would tell
 * a paused agent its work is back when it is still in the stash. Three questions, asked once,
 * cover every path.
 */
export type TreeAfterSync = {
  readonly pending: 'rebase' | 'merge' | undefined;
  readonly conflicted: number;
  /** This run's own stash, if it is still listed -- matched on the full label, so a LEFTOVER
   *  stash from some earlier sync is never reported as this one's. */
  readonly stash: StashEntry | undefined;
};

const inspectAfterSync = (clone: Clone, stashLabel: string | undefined): TreeAfterSync => ({
  pending: inProgressOperation(clone.path),
  conflicted: conflictedFiles(clone.path).length,
  stash:
    stashLabel === undefined
      ? undefined
      : syncStashes(clone.path).find((entry) => entry.message.includes(stashLabel)),
});

/**
 * What to say about a stash that is still listed -- which is three different things.
 *
 * On the finished path the stash is a KEPT COPY: the changes are in the working tree and the
 * stash survives as a safety net (sync keeps it whenever re-applying needed conflict
 * resolution). When the re-apply is what failed, the tree holds part of them and the original
 * is still stashed. Anywhere else, the tree does not have them at all. Telling an agent "your
 * changes are not in the working tree" when they are, or the reverse, is worse than saying
 * nothing -- so this keys on the OUTCOME and never on the conflict count, which on a plain
 * abort belongs to the failed rollback rather than to any re-apply.
 */
const stashSentence = (kind: Closing, state: TreeAfterSync): string | undefined => {
  const stash = state.stash;
  if (stash === undefined) return undefined;
  const where = `the git stash entry ${stash.ref} ("${stash.message}")`;
  if (kind === 'finished') {
    return (
      `A copy of your uncommitted changes was kept in ${where}: they ARE back in the working ` +
      'tree, but re-applying them needed conflict resolution, so the stash was not dropped.'
    );
  }
  if (kind === 'aborted-after-integrating') {
    return `Re-applying your uncommitted changes did not complete — the original is still in ${where}.`;
  }
  return `Your uncommitted changes are NOT in the working tree: they are in ${where}.`;
};

/**
 * How a sync ended, from the point of view of a session that was told to wait.
 *
 * The third one is not a nicety. Re-applying the stash is the one step that happens AFTER the
 * integration is committed, so when it fails the branch really has moved -- and a message
 * saying the rebase "did not happen" would send an agent looking for commits that are sitting
 * in its history. Whether integration completed is something only this command knows, so
 * unlike the tree state it is carried rather than asked for.
 */
export type Closing = 'finished' | 'aborted' | 'aborted-after-integrating';

const OPENING: Record<Closing, (what: string) => string> = {
  finished: (what) => `SYNC FINISHED — the ${what} is done.`,
  aborted: (what) => `SYNC ABORTED — the ${what} did not happen.`,
  'aborted-after-integrating': (what) =>
    `SYNC ABORTED — the ${what} was applied and committed, but putting your uncommitted changes ` +
    'back on top of it did not finish.',
};

/**
 * Whether to resume, and it is the TREE that decides, not the outcome.
 *
 * A half-applied operation or an unmerged path means the clone cannot be worked in whichever
 * way sync ended. A successful sync that merely kept a safety-net stash, on the other hand,
 * must not freeze an agent: its files are all there, and the only thing not to touch is the
 * stash. The remaining case is a clean abort that is still holding the work -- resumable in
 * principle, except that editing would duplicate changes sitting in the stash.
 */
const instruction = (kind: Closing, state: TreeAfterSync): string => {
  const freeze =
    'Do not edit, stage or commit anything, and do not try to repair this yourself — tell the ' +
    'user what this message says, and wait.';
  if (state.pending !== undefined || state.conflicted > 0) return freeze;
  if (kind === 'finished') {
    const resume =
      'You can resume what you were doing — but re-read any file you had in flight first: code ' +
      'may have changed underneath you, including in the area you were working on.';
    return state.stash === undefined
      ? resume
      : `${resume} Leave the stash alone — the user drops it once they have checked the result.`;
  }
  if (state.stash === undefined) {
    return (
      'Your working tree is exactly as it was and nothing was changed, so you can resume what ' +
      'you were doing.'
    );
  }
  return (
    'Do not edit, stage or commit anything: the work you had in progress is not in the tree in ' +
    'front of you. Tell the user what this message says, and wait.'
  );
};

/**
 * The closing message: what happened, what state that leaves, and whether to resume.
 *
 * Pure, and given the facts rather than asked to work them out, so every variant can be read
 * side by side without constructing the git state that produces it.
 */
export const closingMessage = (kind: Closing, strategy: Strategy, state: TreeAfterSync): string => {
  const what = `${ACTION[strategy.kind]} onto ${strategy.target.ref}`;
  const facts = [
    state.pending === undefined
      ? undefined
      : `A ${state.pending} is still half-applied here — git is stopped in the middle of it.`,
    state.conflicted === 0
      ? undefined
      : `${state.conflicted} file(s) in this working tree have unresolved conflict markers right now.`,
    stashSentence(kind, state),
  ].filter((fact): fact is string => fact !== undefined);
  return [OPENING[kind](what), ...facts, instruction(kind, state)].join(' ');
};

/**
 * The sessions that actually got the message; the rest are reported and counted as missed.
 *
 * ## The pause goes into a tmux pane, keyed on the session's tty
 *
 * Every window `hangar open` creates is a tmux window on this hangar's own socket, so delivering
 * a line is `send-keys` into the pane sitting on that tty -- the same mechanism on every platform,
 * needing nothing from the emulator around it. That is what makes the protocol available on a
 * Linux box with no KDE, where typing into the emulator itself is not possible at all: VTE
 * exposes no API for writing into a running terminal, and the generic POSIX substitute (the
 * `TIOCSTI` ioctl) has been disabled by default since Linux 6.2 because injecting keystrokes into
 * another process's terminal is a privilege-escalation primitive.
 *
 * ## A miss is attributed, because the two kinds have different fixes
 *
 * A session Hangar did not open -- started by hand in a bare tab, or inside the developer's OWN
 * tmux on the default socket -- has no pane on our socket and cannot be reached. `procs` finds it
 * by its tty all the same, so it appears here and would otherwise read as a bug rather than as a
 * session in a place this protocol does not reach.
 *
 * None of that is a soft failure: `integrate` asks before syncing a clone whose sessions could
 * not all be reached, which is the right question -- a live agent is about to have its working
 * tree rebased under it and cannot be told.
 */
const notifySessions = (
  hangar: Hangar,
  sessions: readonly ClaudeSession[],
  message: string,
): readonly ClaudeSession[] => {
  const server = tmuxServer(hangar);
  if (!server.installed()) {
    warn('tmux is not on PATH, so no session can be told to pause');
    note('Pause them yourself. `hangar open` needs tmux too — `brew install tmux`.');
    return [];
  }
  if (!server.running()) {
    warn('no tmux server for this hangar, so nothing it opened is running');
    note(
      `Sessions outside \`tmux -L ${tmuxSocketName(hangar.id)}\` cannot be reached; pause them yourself.`,
    );
    return [];
  }

  const reached: ClaudeSession[] = [];
  for (const session of sessions) {
    if (session.tty === undefined) {
      warn(`session pid ${session.pid} has no terminal (IDE-hosted) — cannot reach it`);
      continue;
    }
    if (server.sendLine(session.tty, message)) {
      ok(`messaged the session on ${session.tty}`);
      reached.push(session);
    } else {
      warn(`the session on ${session.tty} (pid ${session.pid}) is not in this hangar's tmux`);
      note('Started by hand, or in your own tmux — `hangar open <n>` starts one that can be told.');
    }
  }
  return reached;
};

const abortAndRestore = (clone: Clone, strategy: Strategy, stashed: boolean): void => {
  if (strategy.kind === 'rebase') git(clone.path, ['rebase', '--abort']);
  if (strategy.kind === 'merge') git(clone.path, ['merge', '--abort']);
  if (stashed) {
    const res = git(clone.path, ['stash', 'pop']);
    if (res.ok) ok('restored your stashed changes');
    else
      warn('your changes are still in the stash — recover with `git stash list` / `git stash pop`');
  }
};

/**
 * Drive a rebase to completion, resolving each conflicted step.
 *
 * ## Every `--continue` owns the terminal, and the verdict comes from git's own state
 *
 * The continue runs with this process's terminal inherited, exactly like the `git rebase` that
 * started the operation. That is not about seeing the output: it is so that anything git
 * launches which wants an answer can be given one. An editor cannot open here at all any more
 * (`noEditorEnv` in `git.ts` has the story), but a cold gpg-agent raising a pinentry for a
 * signed commit and a `pre-commit` hook that prompts both still can -- and against a captured
 * pipe each of those is a sync that hangs with nothing on screen and a paused agent that never
 * hears how it ended.
 *
 * The price is `stderr`, which an inherited child does not capture -- so every question here is
 * put to `inProgressOperation` instead. That is the better source in any case: it reads the
 * state directory, exactly as git's own status does, where the alternatives are a `stderr`
 * string to match on and `rev-parse REBASE_HEAD`, which `git.ts` documents as being precisely
 * the wrong proxy for "is a rebase in progress". Deriving state at the moment it is reported is
 * the rule for everything in this file.
 *
 * ## A rebase that never STARTED is not a rebase that finished
 *
 * This runs whenever the initial `git rebase` exited non-zero -- which includes exiting without
 * starting anything: unstaged changes the stash did not catch, a `pre-rebase` hook refusing. In
 * that state the first continue fails with nothing in progress and nothing conflicted, which is
 * indistinguishable from a rebase that ran to completion. Reading it as completion is how `sync`
 * comes to print `rebase complete` and tell the paused agent its branch moved while nothing
 * happened at all, so the two are separated by WHEN: found on the way in, it means the rebase
 * did not start; found after a continue, it means the rebase is over.
 */
const continueRebase = async (clone: Clone, strategy: Strategy): Promise<boolean> => {
  if (inProgressOperation(clone.path) === undefined && conflictedFiles(clone.path).length === 0) {
    fail('the rebase did not start — git printed the reason above');
    return false;
  }
  for (let guard = 0; guard < 50; guard += 1) {
    if (conflictedFiles(clone.path).length === 0) {
      git(clone.path, ['rebase', '--continue'], { inherit: true });
      if (inProgressOperation(clone.path) === undefined) return true;
      if (conflictedFiles(clone.path).length === 0) {
        fail('rebase --continue stopped with nothing conflicted — see git’s output above');
        return false;
      }
    }
    const outcome = await resolveWithClaude(clone.path, 'rebase', strategy.target.ref);
    if (!outcome.resolved) {
      fail(outcome.reason ?? 'could not resolve conflicts');
      return false;
    }
    git(clone.path, ['add', '-A']);
  }
  fail('rebase did not finish after 50 steps — giving up');
  return false;
};

/**
 * What the closing message is built from, filled in as the run progresses.
 *
 * Mutable on purpose: `closeSessions` runs from a `finally`, so it can only read state that
 * outlives the block it is closing over.
 */
type Run = {
  paused: readonly ClaudeSession[];
  strategy: Strategy;
  stashLabel: string | undefined;
  /** The integration is committed. Only step 7 -- putting the stash back -- can still fail. */
  integrated: boolean;
  finished: boolean;
};

/**
 * Tell the sessions that were paused how this ended -- from a `finally`, which is the point.
 *
 * Between the pause and the resume there are six ways out of a sync: the confirm being
 * declined, a failed stash, a failed fetch, a target that does not exist, an integration that
 * was rolled back, and a stash that could not be re-applied. Five of them used to send
 * nothing at all, leaving an agent that had been told to STOP and wait doing exactly that,
 * indefinitely, while the operator saw a clean error and moved on. Sending the closing message
 * from anywhere else means six call sites and remembering all six -- including in whatever
 * exit path gets added next -- so it is structural instead.
 *
 * `notifySessions` prints per session and can only fail inside the terminal driver, which must
 * never replace the error the operator actually needs.
 */
const closeSessions = (hangar: Hangar, clone: Clone, run: Run): void => {
  if (run.paused.length === 0) return;
  try {
    const state = inspectAfterSync(clone, run.stashLabel);
    const kind: Closing = run.finished
      ? 'finished'
      : run.integrated
        ? 'aborted-after-integrating'
        : 'aborted';
    notifySessions(hangar, run.paused, closingMessage(kind, run.strategy, state));
  } catch (error) {
    warn(`could not tell the paused session(s) how this ended: ${String(error)}`);
  }
};

/** The same facts as `closingMessage`, worded for the operator's terminal. */
const leftovers = (hangar: Hangar, state: TreeAfterSync): string =>
  [
    state.pending === undefined ? undefined : `a ${state.pending} is still in progress`,
    state.conflicted === 0 ? undefined : `${state.conflicted} file(s) still conflicted`,
    state.stash === undefined ? undefined : `your changes are in ${state.stash.ref}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');

const syncOne = async (hangar: Hangar, clone: Clone, opts: SyncOptions): Promise<boolean> => {
  heading(`Syncing ${cloneLabel(clone)}`);

  const sessions = claudeSessionsIn(clone.path);
  const branch = currentBranch(clone.path);

  // Refuse to start on top of a half-applied rebase or merge. Step 2 would `git stash push`
  // over it, which buries the in-flight state in a stash nobody will think to look in. This
  // is not hypothetical: a `sync` killed mid-resolution leaves exactly this, and re-running
  // it is the obvious next thing a developer tries.
  const pending = inProgressOperation(clone.path);
  if (pending !== undefined && opts.dryRun !== true) {
    throw new CliError(
      `${clone.name} is in the middle of a ${pending}`,
      `Finish it (\`git -C ${clone.path} ${pending} --continue\`) or abandon it ` +
        `(\`--abort\`), then run sync again.`,
    );
  }

  // The pull-request lookup is the one network call and happens ONCE, here. Whether
  // `origin/<target>` is actually in this clone is a separate question, asked after the fetch
  // below: a stacked PR can target a branch this clone has never fetched.
  const target = await resolveTarget(hangar, clone, branch, opts);
  describeTarget(hangar, clone, target);
  const autoBefore = chooseStrategy(clone, target);
  const strategyBefore = decideStrategy(autoBefore, opts.strategy);
  const overridden = overrideWarning(autoBefore, opts.strategy);
  if (overridden !== undefined) warn(overridden);

  if (opts.dryRun === true) {
    note(`branch:   ${branch}`);
    note(`strategy: ${strategyBefore.kind} onto ${target.ref}`);
    if (strategyBefore.kind !== 'up-to-date') note(`because:  ${strategyBefore.reason}`);
    if (!refExists(clone.path, target.ref)) {
      note(`missing:  ${target.ref} is not in this clone yet — the fetch would have to bring it`);
    }
    const state = syncState(clone.path);
    note(`worktree: ${state.dirty} modified, ${state.untracked} untracked`);
    if (pending !== undefined) note(`pending:  a ${pending} is in progress — sync would refuse`);
    for (const stash of syncStashes(clone.path)) {
      note(pc.yellow(`stash:    ${stash.ref} is an unreturned sync stash (${stash.age})`));
    }
    note(
      `sessions: ${sessions.length === 0 ? 'none' : sessions.map((s) => `pid ${s.pid} on ${s.tty ?? 'no tty'}`).join(', ')}`,
    );
    note('(dry run — nothing was changed)');
    return true;
  }

  const run: Run = {
    paused: [],
    strategy: strategyBefore,
    stashLabel: undefined,
    integrated: false,
    finished: false,
  };
  try {
    return await integrate(hangar, clone, opts, sessions, run);
  } finally {
    closeSessions(hangar, clone, run);
  }
};

/**
 * Everything from pausing the session to letting it go again.
 *
 * Separate from `syncOne` only so that the `try`/`finally` that guarantees the closing message
 * wraps one call rather than a hundred indented lines.
 */
const integrate = async (
  hangar: Hangar,
  clone: Clone,
  opts: SyncOptions,
  sessions: readonly ClaudeSession[],
  run: Run,
): Promise<boolean> => {
  const target = run.strategy.target;

  // 1. pause any live session
  if (sessions.length > 0) {
    if (opts.sessionNotify === false) {
      warn(`${sessions.length} live Claude session(s) — not notified (--no-session-notify)`);
    } else {
      step(`pausing ${sessions.length} live Claude Code session(s)`);
      run.paused = notifySessions(hangar, sessions, pauseMessage(hangar, run.strategy));
      if (run.paused.length !== sessions.length) {
        if (!confirm('Some sessions could not be reached. Sync anyway?')) {
          note('skipped');
          return false;
        }
      }
    }
  }

  // 2. stash
  const dirty = syncState(clone.path);
  const stashNeeded = dirty.dirty > 0 || dirty.untracked > 0;
  let stashed = false;
  if (stashNeeded) {
    const label = `${SYNC_STASH_LABEL} ${new Date().toISOString()}`;
    const res = git(clone.path, ['stash', 'push', '--include-untracked', '-m', label]);
    if (!res.ok) throw new CliError(`could not stash ${clone.name}`, res.stderr.trim());
    stashed = true;
    run.stashLabel = label;
    ok(`stashed ${dirty.dirty + dirty.untracked} file(s) as "${label}"`);
  }

  // 3. fetch
  step('git fetch --all --prune');
  const fetched = git(clone.path, ['fetch', '--all', '--prune']);
  if (!fetched.ok) {
    if (stashed) git(clone.path, ['stash', 'pop']);
    throw new CliError(`fetch failed in ${clone.name}`, fetched.stderr.trim());
  }

  // 4. the target has to EXIST before anything is integrated onto it. Refusing here rather
  //    than falling back to the default branch is the point: a rebase onto the wrong base is
  //    the expensive thing to undo in this command, and it would look like it worked.
  if (!refExists(clone.path, target.ref)) {
    if (stashed) git(clone.path, ['stash', 'pop']);
    throw new CliError(
      `${clone.name}: ${target.ref} does not exist, even after fetching`,
      `${
        target.pr === undefined
          ? 'Nothing on origin goes by that name.'
          : `PR #${String(target.pr.id)} targets ${target.branch}, but origin has no such branch — deleted since?`
      } Pick a base with --onto <ref>.${stashed ? ' Your changes were restored from the stash.' : ''}`,
    );
  }

  // 5. strategy (recomputed: the fetch may have moved the target)
  const auto = chooseStrategy(clone, target);
  const strategy = decideStrategy(auto, opts.strategy);
  const overridden = overrideWarning(auto, opts.strategy);
  if (overridden !== undefined) warn(overridden);
  run.strategy = strategy;
  if (strategy.kind === 'up-to-date') {
    ok(`already up to date with ${target.ref}`);
  } else {
    note(`${strategy.kind} onto ${target.ref} — ${strategy.reason}`);
  }

  // 6. integrate
  let integrated = true;
  if (strategy.kind === 'ff-only') {
    const res = git(clone.path, ['merge', '--ff-only', target.ref], { inherit: true });
    integrated = res.ok;
    if (!integrated) fail(`fast-forward failed — ${target.branch} has diverged locally`);
  } else if (strategy.kind === 'rebase') {
    const res = git(clone.path, ['rebase', target.ref], { inherit: true });
    integrated = res.ok || (await continueRebase(clone, strategy));
  } else if (strategy.kind === 'merge') {
    const res = git(clone.path, ['merge', '--no-edit', target.ref], { inherit: true });
    if (!res.ok) {
      const outcome = await resolveWithClaude(clone.path, 'merge', strategy.target.ref);
      if (outcome.resolved) {
        git(clone.path, ['add', '-A']);
        // Same two rules as `continueRebase`: the terminal is the child's, so anything wanting
        // an answer can be given one, and whether the merge landed is read back off git rather
        // than taken from an exit code -- `run.integrated` is what a paused agent is told.
        git(clone.path, ['merge', '--continue'], { inherit: true });
        integrated = inProgressOperation(clone.path) === undefined;
      } else {
        fail(outcome.reason ?? 'could not resolve merge conflicts');
        integrated = false;
      }
    }
  }

  if (!integrated) {
    abortAndRestore(clone, strategy, stashed);
    // Asked, not assumed: `abortAndRestore`'s `stash pop` can fail, and it only warns.
    const left = leftovers(hangar, inspectAfterSync(clone, run.stashLabel));
    throw new CliError(
      `${clone.name}: ${strategy.kind} onto ${target.ref} failed and was rolled back`,
      left === ''
        ? 'Your working tree is back as it was. Resolve by hand in the clone, or re-run after ' +
            'committing your work.'
        : `The rollback did not leave this clone clean — ${left}. Sort that out first; ` +
            'sync will refuse to start again until it is.',
    );
  }
  if (strategy.kind !== 'up-to-date') ok(`${strategy.kind} complete`);
  // Only when the branch actually MOVED. `up-to-date` integrated nothing, and claiming
  // otherwise to a paused agent -- "applied and committed" when HEAD never changed -- is the
  // same false statement as the one this outcome exists to prevent, pointing the other way.
  // `ff-only` does move the branch, so it counts.
  if (strategy.kind !== 'up-to-date') run.integrated = true;

  // 7. put the working tree back
  if (stashed) {
    // `apply`, not `pop`: the stash stays as a safety net until the apply is proven clean.
    const applied = git(clone.path, ['stash', 'apply'], { inherit: true });
    if (applied.ok && conflictedFiles(clone.path).length === 0) {
      git(clone.path, ['stash', 'drop']);
      ok('re-applied your changes and dropped the stash');
    } else {
      const outcome = await resolveWithClaude(clone.path, 'stash apply', strategy.target.ref);
      if (outcome.resolved && conflictedFiles(clone.path).length === 0) {
        ok('re-applied your changes (conflicts resolved)');
        warn('the stash was KEPT — verify the result, then `git stash drop`');
      } else {
        fail(outcome.reason ?? 'could not re-apply your stashed changes cleanly');
        warn(
          `your changes are still in the stash in ${clone.name} — resolve by hand, then drop it`,
        );
        return false;
      }
    }
  }

  // 8. done -- `closeSessions` is what lets the paused sessions go again
  run.finished = true;
  return true;
};

export const sync = async (
  hangar: Hangar,
  ref: string | undefined,
  opts: SyncOptions,
): Promise<void> => {
  const clones = opts.all === true ? discoverClones(hangar) : [namedClone(hangar, ref)];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const clone of clones) {
    // `--all` deliberately leaves busy clones alone: pausing several agents' tabs in one
    // sweep is far more disruptive than skipping and saying so.
    if (opts.all === true && opts.includeBusy !== true && opts.dryRun !== true) {
      const sessions = claudeSessionsIn(clone.path);
      if (sessions.length > 0) {
        warn(
          `${clone.name}: skipped — ${sessions.length} live Claude session(s). --include-busy to sync anyway.`,
        );
        skipped.push(clone.name);
        continue;
      }
    }
    try {
      if (!(await syncOne(hangar, clone, opts))) failed.push(clone.name);
    } catch (error) {
      if (!(error instanceof CliError) || clones.length === 1) throw error;
      fail(`${clone.name}: ${error.message}`);
      if (error.hint !== undefined) note(error.hint);
      failed.push(clone.name);
    }
  }

  if (clones.length > 1) {
    console.log('');
    note(
      `${clones.length - skipped.length - failed.length} synced, ${skipped.length} skipped, ${failed.length} failed`,
    );
  }
  if (failed.length > 0) throw new CliError(`sync failed for: ${failed.join(', ')}`);
  if (skipped.length > 0) note(pc.dim(`skipped (busy): ${skipped.join(', ')}`));
};

const namedClone = (hangar: Hangar, ref: string | undefined): Clone => {
  if (ref === undefined) {
    throw new CliError('sync needs a clone name, or --all', knownClonesHint(hangar));
  }
  return requireClone(hangar, ref);
};
