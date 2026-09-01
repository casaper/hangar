import pc from 'picocolors';

import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import {
  conflictedFiles,
  currentBranch,
  git,
  gitTry,
  remoteHeadBranch,
  syncState,
} from '../git.ts';
import { writeToTty } from '../iterm.ts';
import { claudeSessionsIn, type ClaudeSession } from '../procs.ts';
import { resolveWithClaude } from '../resolve-conflicts.ts';
import { cloneLabel, confirm, fail, heading, note, ok, step, warn } from '../ui.ts';

/**
 * `orch-util sync` -- bring a clone's branch up to date with the default branch.
 *
 * Two things here are not mechanical, and both are deliberate choices rather than defaults:
 *
 * 1. A live Claude Code session in the clone is TOLD to pause, by typing into its iTerm2
 *    tab. There is no other mechanism: the `claude` CLI has no subcommand that messages a
 *    running interactive session. If the tab cannot be found the command asks the human
 *    instead of rewriting the branch under an agent that is mid-edit.
 *
 * 2. Conflicts are handed to a headless `claude -p` inside the clone and then verified
 *    mechanically. If that fails, the whole operation is aborted and the pre-sync state
 *    restored -- never left half-merged.
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
};

type Strategy =
  | { kind: 'up-to-date'; target: string }
  | { kind: 'ff-only'; target: string; reason: string }
  | { kind: 'rebase'; target: string; reason: string }
  | { kind: 'merge'; target: string; reason: string };

const chooseStrategy = (clone: Clone): Strategy => {
  const defaultBranch = remoteHeadBranch(clone.path);
  const target = `origin/${defaultBranch}`;
  const branch = currentBranch(clone.path);

  if (branch === defaultBranch) {
    return { kind: 'ff-only', target, reason: `on the default branch (${defaultBranch})` };
  }

  const base = gitTry(clone.path, ['merge-base', target, 'HEAD']);
  if (base === undefined) {
    return { kind: 'merge', target, reason: `no common ancestor found with ${target}` };
  }

  const behind = gitTry(clone.path, ['rev-list', '--count', `HEAD..${target}`]) ?? '0';
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

const PAUSE_MESSAGE =
  'STOP what you are doing and do not edit any file. `orch-util sync` is about to rebase or merge ' +
  'this clone onto the default branch. Reply that you have paused, then wait.';

const resumeMessage = (strategy: Strategy): string =>
  `The ${strategy.kind} onto ${strategy.target} is finished. You can resume what you were doing — ` +
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
const continueRebase = (clone: Clone, strategy: Strategy): boolean => {
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
    const outcome = resolveWithClaude(clone.path, 'rebase', strategy.target);
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

const syncOne = (clone: Clone, opts: SyncOptions): boolean => {
  heading(`Syncing ${cloneLabel(clone)}`);

  const sessions = claudeSessionsIn(clone.path);
  const strategyBefore = chooseStrategy(clone);

  if (opts.dryRun === true) {
    note(`branch:   ${currentBranch(clone.path)}`);
    note(`strategy: ${strategyBefore.kind} onto ${strategyBefore.target}`);
    if (strategyBefore.kind !== 'up-to-date') note(`because:  ${strategyBefore.reason}`);
    const state = syncState(clone.path);
    note(`worktree: ${state.dirty} modified, ${state.untracked} untracked`);
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
      if (!notifySessions(sessions, PAUSE_MESSAGE)) {
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

  // 4. strategy (recomputed: the fetch may have moved the target)
  const strategy = chooseStrategy(clone);
  if (strategy.kind === 'up-to-date') {
    ok(`already up to date with ${strategy.target}`);
  } else {
    note(`${strategy.kind} onto ${strategy.target} — ${strategy.reason}`);
  }

  // 5. integrate
  let integrated = true;
  if (strategy.kind === 'ff-only') {
    const res = git(clone.path, ['merge', '--ff-only', strategy.target], true);
    integrated = res.ok;
    if (!integrated) fail('fast-forward failed — the default branch has diverged locally');
  } else if (strategy.kind === 'rebase') {
    const res = git(clone.path, ['rebase', strategy.target], true);
    integrated = res.ok || continueRebase(clone, strategy);
  } else if (strategy.kind === 'merge') {
    const res = git(clone.path, ['merge', '--no-edit', strategy.target], true);
    if (!res.ok) {
      const outcome = resolveWithClaude(clone.path, 'merge', strategy.target);
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
      `${clone.name}: ${strategy.kind} onto ${strategy.target} failed and was rolled back`,
      'Nothing was changed. Resolve by hand in the clone, or re-run after committing your work.',
    );
  }
  if (strategy.kind !== 'up-to-date') ok(`${strategy.kind} complete`);

  // 6. put the working tree back
  if (stashed) {
    // `apply`, not `pop`: the stash stays as a safety net until the apply is proven clean.
    const applied = git(clone.path, ['stash', 'apply'], true);
    if (applied.ok && conflictedFiles(clone.path).length === 0) {
      git(clone.path, ['stash', 'drop']);
      ok('re-applied your changes and dropped the stash');
    } else {
      const outcome = resolveWithClaude(clone.path, 'stash apply', strategy.target);
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

  // 7. let the session go again
  if (sessions.length > 0 && opts.sessionNotify !== false) {
    notifySessions(sessions, resumeMessage(strategy));
  }
  return true;
};

export const sync = (ref: string | undefined, opts: SyncOptions): void => {
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
      if (!syncOne(clone, opts)) failed.push(clone.name);
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
