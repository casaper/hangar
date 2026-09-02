import pc from 'picocolors';

import { openPullRequests, repoRef, type PullRequest } from '../bitbucket.ts';
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
  remoteHeadBranch,
  remotes,
  syncState,
} from '../git.ts';
import { writeToTty } from '../iterm.ts';
import { claudeSessionsIn, type ClaudeSession } from '../procs.ts';
import { resolveWithClaude } from '../resolve-conflicts.ts';
import { cloneLabel, confirm, fail, heading, note, ok, step, warn } from '../ui.ts';

/**
 * `orch-util sync` -- bring a clone's branch up to date with whatever it will be merged into.
 *
 * Three things here are not mechanical, and all of them are deliberate choices rather than
 * defaults:
 *
 * 1. A live Claude Code session in the clone is TOLD to pause, by typing into its iTerm2
 *    tab. There is no other mechanism: the `claude` CLI has no subcommand that messages a
 *    running interactive session. If the tab cannot be found the command asks the human
 *    instead of rewriting the branch under an agent that is mid-edit.
 *
 * 2. The target is the branch this one's PULL REQUEST targets, which is not always the
 *    default branch and cannot be worked out locally -- see `resolveTarget`.
 *
 * 3. Conflicts are handed to a headless `claude -p` inside the clone and then verified
 *    mechanically. If that fails, the whole operation is aborted and the pre-sync state
 *    restored -- never left half-merged. That run streams its progress (see
 *    `resolve-conflicts.ts`), because a silent minute here reads as a hung command and gets
 *    killed -- which leaves the rebase stopped mid-pick, the one state this command exists
 *    to avoid.
 *
 * Rebase vs merge follows the user's rule: rebase only when this is your own branch with a
 * linear history since it forked; merge when someone else started it or it already contains
 * merge commits, because rebasing those rewrites other people's commits.
 */
export type SyncOptions = {
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
  sessionNotify?: boolean | undefined;
  includeBusy?: boolean | undefined;
  onto?: string | undefined;
};

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
const resolveTarget = async (clone: Clone, branch: string, opts: SyncOptions): Promise<Target> => {
  const defaultBranch = remoteHeadBranch(clone.path);
  const onDefault = (why: string, guessed = false): Target => ({
    branch: defaultBranch,
    ref: `origin/${defaultBranch}`,
    why,
    guessed,
    pr: undefined,
  });

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
  if (branch === defaultBranch) return onDefault(`on the default branch (${defaultBranch})`);
  if (branch === DETACHED) return onDefault('detached HEAD — no branch to look a PR up by');

  const lookup = await openPullRequests(repoRef(clone.path), branch);
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
const describeTarget = (clone: Clone, target: Target): void => {
  note(`target ${target.ref}${target.guessed ? pc.yellow(' (a guess)') : ''} — ${target.why}`);
  if (target.pr !== undefined) note(pc.dim(target.pr.url));
  // Fleet-aware, and print-only: a stacked PR targets a branch a sibling clone is working in,
  // so `origin/<target>` is only as fresh as that clone's last push. Not a reason to stop, and
  // only said of an `origin/` ref -- a `clone_NN/` one IS that clone, fetched.
  const siblings = !target.ref.startsWith('origin/')
    ? []
    : discoverClones()
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

const pauseMessage = (strategy: Strategy): string =>
  'STOP what you are doing and do not edit any file. `orch-util sync` is about to ' +
  `${strategy.kind === 'merge' ? 'merge' : 'rebase'} this clone onto ${strategy.target.ref}. ` +
  'If it conflicts, a separate headless Claude Code run will ' +
  'edit the conflicted files in this working tree — do not touch them yourself, even if asked, ' +
  'or you will both be editing the same file. Reply that you have paused, then wait.';

const resumeMessage = (strategy: Strategy): string =>
  `The ${strategy.kind} onto ${strategy.target.ref} is finished. You can resume what you were doing — ` +
  'but re-read any file you had in flight first: code may have changed underneath you, ' +
  'including in the area you were working on.';

const notifySessions = (sessions: readonly ClaudeSession[], message: string): boolean => {
  let allReached = true;
  for (const session of sessions) {
    if (session.tty === undefined) {
      warn(`session pid ${session.pid} has no terminal (IDE-hosted) — cannot reach it`);
      allReached = false;
      continue;
    }
    if (writeToTty(session.tty, message)) ok(`messaged the session on ${session.tty}`);
    else {
      warn(`could not find an iTerm2 tab for ${session.tty} (pid ${session.pid})`);
      allReached = false;
    }
  }
  return allReached;
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

/** Drive a rebase to completion, resolving each conflicted step. */
const continueRebase = async (clone: Clone, strategy: Strategy): Promise<boolean> => {
  for (let guard = 0; guard < 50; guard += 1) {
    if (conflictedFiles(clone.path).length === 0) {
      const cont = git(clone.path, ['-c', 'core.editor=true', 'rebase', '--continue']);
      if (cont.ok) return true;
      if (cont.stderr.includes('no rebase in progress')) return true;
      if (conflictedFiles(clone.path).length === 0) {
        fail(cont.stderr.trim() || 'rebase --continue failed');
        return false;
      }
    }
    const outcome = await resolveWithClaude(clone.path, 'rebase', strategy.target.ref);
    if (!outcome.resolved) {
      fail(outcome.reason ?? 'could not resolve conflicts');
      return false;
    }
    git(clone.path, ['add', '-A']);
    const cont = git(clone.path, ['-c', 'core.editor=true', 'rebase', '--continue']);
    if (cont.ok && conflictedFiles(clone.path).length === 0) {
      const stillRebasing = gitTry(clone.path, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']);
      if (stillRebasing === undefined) return true;
    }
  }
  fail('rebase did not finish after 50 steps — giving up');
  return false;
};

const syncOne = async (clone: Clone, opts: SyncOptions): Promise<boolean> => {
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
  const target = await resolveTarget(clone, branch, opts);
  describeTarget(clone, target);
  const strategyBefore = chooseStrategy(clone, target);

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
    note(
      `sessions: ${sessions.length === 0 ? 'none' : sessions.map((s) => `pid ${s.pid} on ${s.tty ?? 'no tty'}`).join(', ')}`,
    );
    note('(dry run — nothing was changed)');
    return true;
  }

  // 1. pause any live session
  if (sessions.length > 0) {
    if (opts.sessionNotify === false) {
      warn(`${sessions.length} live Claude session(s) — not notified (--no-session-notify)`);
    } else {
      step(`pausing ${sessions.length} live Claude Code session(s)`);
      if (!notifySessions(sessions, pauseMessage(strategyBefore))) {
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
    const label = `orch-util-sync ${new Date().toISOString()}`;
    const res = git(clone.path, ['stash', 'push', '--include-untracked', '-m', label]);
    if (!res.ok) throw new CliError(`could not stash ${clone.name}`, res.stderr.trim());
    stashed = true;
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
  const strategy = chooseStrategy(clone, target);
  if (strategy.kind === 'up-to-date') {
    ok(`already up to date with ${target.ref}`);
  } else {
    note(`${strategy.kind} onto ${target.ref} — ${strategy.reason}`);
  }

  // 6. integrate
  let integrated = true;
  if (strategy.kind === 'ff-only') {
    const res = git(clone.path, ['merge', '--ff-only', target.ref], true);
    integrated = res.ok;
    if (!integrated) fail(`fast-forward failed — ${target.branch} has diverged locally`);
  } else if (strategy.kind === 'rebase') {
    const res = git(clone.path, ['rebase', target.ref], true);
    integrated = res.ok || (await continueRebase(clone, strategy));
  } else if (strategy.kind === 'merge') {
    const res = git(clone.path, ['merge', '--no-edit', target.ref], true);
    if (!res.ok) {
      const outcome = await resolveWithClaude(clone.path, 'merge', strategy.target.ref);
      if (outcome.resolved) {
        git(clone.path, ['add', '-A']);
        integrated = git(clone.path, ['-c', 'core.editor=true', 'merge', '--continue']).ok;
      } else {
        fail(outcome.reason ?? 'could not resolve merge conflicts');
        integrated = false;
      }
    }
  }

  if (!integrated) {
    abortAndRestore(clone, strategy, stashed);
    throw new CliError(
      `${clone.name}: ${strategy.kind} onto ${target.ref} failed and was rolled back`,
      'Nothing was changed. Resolve by hand in the clone, or re-run after committing your work.',
    );
  }
  if (strategy.kind !== 'up-to-date') ok(`${strategy.kind} complete`);

  // 7. put the working tree back
  if (stashed) {
    // `apply`, not `pop`: the stash stays as a safety net until the apply is proven clean.
    const applied = git(clone.path, ['stash', 'apply'], true);
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

  // 8. let the session go again
  if (sessions.length > 0 && opts.sessionNotify !== false) {
    notifySessions(sessions, resumeMessage(strategy));
  }
  return true;
};

export const sync = async (ref: string | undefined, opts: SyncOptions): Promise<void> => {
  const clones = opts.all === true ? discoverClones() : [namedClone(ref)];
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
      if (!(await syncOne(clone, opts))) failed.push(clone.name);
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

const namedClone = (ref: string | undefined): Clone => {
  if (ref === undefined) {
    throw new CliError('sync needs a clone name, or --all', knownClonesHint());
  }
  return requireClone(ref);
};
