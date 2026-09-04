import pc from 'picocolors';

import { requireDefaultBranch, tryDefaultBranch } from '../config/default-branch.ts';
import { CliError } from '../exec.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import {
  currentBranch,
  git,
  gitTry,
  inProgressOperation,
  refExists,
  syncState,
  type SyncState,
} from '../git.ts';
import { claudeSessionsIn } from '../procs.ts';
import { cloneLabel, confirm, heading, note, ok, step, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar checkout-default` -- fetch everything, then put a clone on its repo's default branch,
 * up to date.
 *
 * The command a clone needs between two tickets, and the reason it exists rather than being two
 * typed git commands is the middle step: **which branch that is comes from the hangar's config,
 * detected from git once and never guessed.** This repo's default branch is `master`, most repos
 * created since 2020 use `main`, and Hangar is meant to run over any of them -- so a hard-coded
 * name here would silently check out the wrong branch, or none, in every hangar but this one.
 * `forge.defaultBranch` holds the answer; `config/default-branch.ts` is what fills it in the
 * first time, and the reasoning for asking it once rather than per clone per command is there.
 *
 * Three things it deliberately does NOT do:
 *
 * - **It does not stash.** `sync` owns that (under a label `status` can recognise), and a
 *   checkout that quietly relocated uncommitted work from a feature branch onto the default one
 *   would be the silent-wrong-thing this fleet is built to avoid. So a dirty tree is refused
 *   when a branch SWITCH is what would carry it, and not otherwise -- see
 *   `requireCleanForSwitch`.
 * - **It only ever fast-forwards.** The point of the command is to land on a CURRENT default
 *   branch, so after the checkout it pulls -- as `git merge --ff-only origin/<default>`, using
 *   the refs the fetch above already brought, which is what makes it one network round trip
 *   rather than two. A local default branch that has DIVERGED (its own commits and origin's) is
 *   reported and left alone: reconciling that is an integration, which is `sync`'s job, with
 *   `sync`'s stash protocol and its conflict resolution behind it.
 * - **It sends no `SYNC PAUSE`.** That protocol exists because a sync holds a working tree for
 *   minutes and hands conflicts to a second Claude Code run; a checkout is one instant
 *   operation. What a live session needs here is for the human to know, so a clone with one asks
 *   for confirmation -- and `confirm` fails closed with no tty, which makes an unattended
 *   invocation refuse rather than swap the branch under a working agent.
 */
export type CheckoutDefaultOptions = {
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
  includeBusy?: boolean | undefined;
};

/**
 * What `landOnBranch` needs, which is less than a whole command's options.
 *
 * `branch` is the one addition: absent means the repo's default branch, which is the whole point
 * of this command, and present means that branch instead -- `hangar open --branch <name>` is the
 * caller for it. The resolution is the only thing it changes; every guard, the fetch and the
 * fast-forward are the same, which is what keeps `open` from growing a second, subtly different
 * idea of what it means to put a clone on a branch.
 */
export type Landing = {
  branch?: string | undefined;
  dryRun?: boolean | undefined;
  includeBusy?: boolean | undefined;
};

export const checkoutDefault = (
  hangar: Hangar,
  ref: string | undefined,
  opts: CheckoutDefaultOptions,
): void => {
  const clones = opts.all === true ? discoverClones(hangar) : [namedClone(hangar, ref)];
  const failed: string[] = [];
  const skipped: string[] = [];

  for (const clone of clones) {
    try {
      const outcome = landOnBranch(hangar, clone, opts, clones.length > 1);
      if (outcome === 'skipped') skipped.push(clone.name);
      if (outcome === 'failed') failed.push(clone.name);
    } catch (error) {
      if (!(error instanceof CliError) || clones.length === 1) throw error;
      // No `${clone.name}:` prefix -- every message `landOnBranch` throws already names the
      // clone, and the heading above it is that clone's own coloured label.
      warn(error.message);
      if (error.hint !== undefined) note(error.hint);
      failed.push(clone.name);
    }
  }

  if (clones.length > 1) {
    console.log('');
    note(
      `${clones.length - skipped.length - failed.length} on their default branch, ${skipped.length} skipped, ${failed.length} failed`,
    );
  }
  if (failed.length > 0) throw new CliError(`checkout-default failed for: ${failed.join(', ')}`);
};

export type Outcome = 'done' | 'skipped' | 'failed';

/**
 * Put one clone on a branch -- the default one, or the one asked for -- and bring it up to date.
 *
 * The body of `checkout-default`, exported because `hangar open` opens a clone on its default
 * branch too and must do it the same way, down to which trees it refuses to touch. It THROWS a
 * `CliError` for anything that should stop this clone (a half-applied rebase, uncommitted work a
 * switch would carry, a branch that exists nowhere), which lets each caller choose the severity:
 * `checkout-default` reports it as the answer to the command, `open` warns and opens the clone
 * anyway on whatever branch it already has.
 */
export const landOnBranch = (
  hangar: Hangar,
  clone: Clone,
  opts: Landing,
  sweeping: boolean,
): Outcome => {
  const wanted = opts.branch;
  heading(`${wanted ?? 'Default branch'} in ${cloneLabel(clone)}`);
  const branch = currentBranch(clone.path);
  note(`branch:   ${branch}`);

  /*
   * Every guard runs BEFORE the fetch, so a refusal is instant. The fetch is the slow part --
   * `--all` in this fleet means origin plus every sibling clone as a remote.
   *
   * None of them fires under `-n`, which has to REPORT what would stop the run rather than
   * stopping on the first one: a dry run that throws answers one question when it was asked
   * for the whole picture.
   */
  const pending = inProgressOperation(clone.path);
  if (pending !== undefined && opts.dryRun !== true) {
    throw new CliError(
      `${clone.name} is in the middle of a ${pending}`,
      // No command named in the hint: `open` calls this too, and telling a developer who typed
      // `hangar open` to re-run `checkout-default` is a small lie about what they asked for.
      `Finish it (\`git -C ${clone.path} ${pending} --continue\`) or abandon it ` +
        `(\`--abort\`), then try again.`,
    );
  }

  const state = syncState(clone.path);
  const known = wanted ?? tryDefaultBranch(hangar);
  /*
   * `tryDefaultBranch` and not the resolving form: this is the FAST half, and it must not
   * detect, network or write. Normally the config names the branch and it answers instantly;
   * when nothing does, we cannot yet tell whether a switch is coming, and refusing on a maybe
   * would break the rule `requireCleanForSwitch` exists to keep. The certain check happens
   * after the fetch, where the target is known; this one is only there to make the common
   * refusal instant.
   */
  const switching = known !== undefined && branch !== known;
  if (switching && opts.dryRun !== true) requireCleanForSwitch(hangar, clone, state);

  const sessions = claudeSessionsIn(clone.path);
  if (sessions.length > 0 && opts.includeBusy !== true && opts.dryRun !== true) {
    if (sweeping) {
      // Same rule as `sync --all`: sweeping a whole fleet must not interrupt several agents at
      // once. Named explicitly, it is a question rather than a skip.
      warn(
        `${clone.name}: skipped — ${sessions.length} live Claude session(s). --include-busy to switch anyway.`,
      );
      return 'skipped';
    }
    warn(`${sessions.length} live Claude session(s) in ${clone.name}`);
    note(
      'Switching branches changes every file that session is reading, and unlike `sync` this command sends it no message.',
    );
    if (!confirm(`Check out ${wanted ?? 'the default branch'} in ${clone.name} anyway?`)) {
      note('left alone');
      return 'skipped';
    }
  }

  if (opts.dryRun === true) {
    note(
      wanted === undefined
        ? `default:  ${known ?? pc.yellow('unrecorded — the run would detect it and write it to hangar.config.yaml')}`
        : `wanted:   ${wanted}`,
    );
    note(`worktree: ${state.dirty} modified, ${state.untracked} untracked`);
    if (pending !== undefined) {
      note(pc.yellow(`pending:  a ${pending} is in progress — the run would refuse`));
    }
    if (state.dirty > 0 && switching) {
      note(
        pc.yellow(
          `blocked:  switching branches would carry ${state.dirty} modified file(s) — the run would refuse`,
        ),
      );
    }
    note(
      `sessions: ${sessions.length === 0 ? 'none' : sessions.map((s) => `pid ${s.pid} on ${s.tty ?? 'no tty'}`).join(', ')}`,
    );
    note('(dry run — nothing was fetched or checked out)');
    return 'done';
  }

  step('git fetch --all');
  if (!git(clone.path, ['fetch', '--all'], true).ok) {
    // Not fatal: the local refs may already be new enough to check out with, and refusing over
    // an offline sibling remote would make this command useless on a train.
    warn('fetch did not complete — working from the refs this clone already has');
  }

  // Allowed to persist: this is the real run, past every guard and past the dry-run return.
  const target = wanted ?? requireDefaultBranch(hangar, { persist: true });
  note(`${wanted === undefined ? 'default:  ' : 'wanted:   '}${target}`);

  if (branch === target) {
    ok(`already on ${target}`);
  } else {
    // The fetch may have just written or corrected `origin/HEAD`, so this is the first moment the
    // switch is CERTAIN, and the only one of the two checks that is load-bearing. It re-uses the
    // pre-fetch read of the tree, which a live agent could in principle have made stale during
    // the fetch -- harmless, because a checkout that should have been refused is refused by git
    // itself, with its own message.
    requireCleanForSwitch(hangar, clone, state);
    if (!checkout(clone, target)) return 'failed';
  }

  return fastForward(hangar, clone, target) ? 'done' : 'failed';
};

/**
 * Refuse to SWITCH branches over uncommitted work -- and only to switch.
 *
 * `git checkout <other>` with tracked modifications succeeds and carries them along, which is
 * how a ticket's uncommitted work quietly ends up sitting on the default branch. Untracked files
 * are not counted: a checkout leaves those exactly where they are.
 *
 * It is deliberately NOT asked when the clone is already on the default branch and only the
 * fast-forward is left. Nothing is being carried anywhere then, and `git merge --ff-only` polices
 * itself -- it refuses, in git's own words, precisely when the commits it would apply touch a
 * file the working tree has modified, and proceeds when they do not. Refusing there would make
 * the command useless in the situation people run it in most: on the default branch, with a
 * scratch edit in the tree, wanting today's commits.
 */
const requireCleanForSwitch = (hangar: Hangar, clone: Clone, state: SyncState): void => {
  if (state.dirty === 0) return;
  throw new CliError(
    `${clone.name} has ${state.dirty} modified file(s) — switching branches would carry them onto the default branch`,
    `Commit them, stash them (\`git -C ${clone.path} stash\`), or run \`hangar sync ${clone.index}\`, which stashes and restores around the integration.`,
  );
};

/**
 * Check the branch out, creating it from `origin/<branch>` when the clone has never had it.
 *
 * Explicit about both halves rather than relying on git's DWIM: a clone that is missing
 * `checkout.defaultRemote=origin` (which `doctor --fix` repairs) has more than one remote
 * offering the branch -- every sibling clone does -- and plain `git checkout <name>` refuses
 * there with "matched multiple remote tracking branches".
 */
const checkout = (clone: Clone, branch: string): boolean => {
  const local = refExists(clone.path, `refs/heads/${branch}`);
  const remote = `origin/${branch}`;
  if (!local && !refExists(clone.path, remote)) {
    throw new CliError(
      `${clone.name}: neither ${branch} nor ${remote} is in this clone`,
      'The fetch above did not bring it. Check that origin still has that branch.',
    );
  }
  const args = local ? ['checkout', branch] : ['checkout', '-b', branch, '--track', remote];
  step(`git ${args.join(' ')}`);
  if (git(clone.path, args, true).ok) {
    ok(`on ${branch}${local ? '' : ` (created from ${remote})`}`);
    return true;
  }
  warn(`could not check out ${branch}`);
  return false;
};

/**
 * Bring the branch we just checked out up to the origin copy the fetch already brought.
 *
 * `git merge --ff-only origin/<branch>` rather than `git pull`: the fetch happened at the top of
 * this run, so pulling again would be a second round trip for refs we already have -- and
 * `--ff-only` is the whole safety story. It can only move the branch pointer forward, so it
 * cannot conflict, cannot write a merge commit and cannot touch a file the working tree has
 * modified (which is refused before the fetch anyway).
 *
 * The three states it distinguishes matter more than the fast-forward itself. AHEAD-only means
 * unpushed commits sitting on the default branch, which is worth saying out loud but is nothing
 * to pull. DIVERGED means both, and it stops here: reconciling that needs a rebase or a merge,
 * which is `sync` -- with its stash label, its live-session pause and its conflict resolution.
 * Doing it silently under a command whose name says "checkout" is exactly the surprise this
 * fleet is built to avoid.
 */
const fastForward = (hangar: Hangar, clone: Clone, branch: string): boolean => {
  const remote = `origin/${branch}`;
  // A branch that exists only here has nothing to pull, and saying so beats warning that a
  // comparison failed. Reachable through `--branch <name>`: an unpushed local branch.
  if (!refExists(clone.path, remote)) {
    ok(`on ${branch} — local only, so there is nothing to pull`);
    return true;
  }
  const counts = gitTry(clone.path, ['rev-list', '--left-right', '--count', `${remote}...HEAD`]);
  if (counts === undefined) {
    warn(`could not compare ${branch} with ${remote}`);
    return true;
  }
  const [behindRaw = '0', aheadRaw = '0'] = counts.split(/\s+/);
  const behind = Number.parseInt(behindRaw, 10);
  const ahead = Number.parseInt(aheadRaw, 10);

  if (ahead > 0 && behind > 0) {
    warn(`${branch} has diverged from ${remote}: ${ahead} commit(s) here, ${behind} there`);
    note(
      `Left as it is — \`hangar sync ${clone.index}\` rebases or merges it, which is what reconciling that needs.`,
    );
    return true;
  }
  if (behind === 0) {
    if (ahead > 0) note(`${ahead} commit(s) here are not on ${remote} yet — nothing to pull`);
    ok(`up to date with ${remote}`);
    return true;
  }

  step(`git merge --ff-only ${remote}`);
  if (!git(clone.path, ['merge', '--ff-only', remote], true).ok) {
    warn(`could not fast-forward ${branch} to ${remote}`);
    return false;
  }
  ok(`fast-forwarded ${behind} commit(s) to ${remote}`);
  return true;
};

const namedClone = (hangar: Hangar, ref: string | undefined): Clone => {
  if (ref === undefined) {
    throw new CliError('checkout-default needs a clone name, or --all', knownClonesHint(hangar));
  }
  return requireClone(hangar, ref);
};
