import { usesBitbucket } from '../bitbucket.ts';
import { CliError } from '../exec.ts';
import { currentBranch, DETACHED } from '../git.ts';
import { discoverClones, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import {
  prCacheIsStale,
  prCacheTtlSeconds,
  readCachedPr,
  refreshPullRequest,
  type CachedPullRequest,
} from '../pr-cache.ts';
import { note, ok, step, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar pr refresh <clone>…` -- ask Bitbucket what each clone's branch has open, and write it
 * down for the bar to draw.
 *
 * ## Who actually runs this
 *
 * Mostly nobody, by hand. The caller that matters is `clone-tmux-status.sh`, which spawns it
 * DETACHED when the record it just read is older than `forge.prCacheTtlSeconds` -- so the bar
 * draws the stale value immediately and the fresh one arrives at the next redraw. That is the
 * whole reason this is a command rather than something inline: the status script may never wait
 * on the network, and a detached process is the only way to want an answer without waiting.
 *
 * It follows that this is **the one command in this CLI whose normal invocation nobody sees**.
 * Its output is written for the times somebody runs it themselves -- which is when the bar is
 * saying something surprising and the question is why.
 *
 * ## Concurrency is the caller's problem, and it is already solved
 *
 * Six clones times three windows redrawing every few seconds is a stampede waiting to happen, so
 * the status script takes an atomic `mkdir` lock per clone before spawning and releases it after.
 * Nothing is re-checked here: a person typing the command means it, and the lock exists to stop
 * the bar from asking the same question twenty times, not to stop a human from asking twice.
 */
export type PrOptions = {
  all?: boolean | undefined;
  /** Ask even for a record that is still inside its TTL. */
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
  quiet?: boolean | undefined;
};

export type PrAction =
  | { readonly kind: 'no-forge'; readonly clone: string }
  | { readonly kind: 'detached'; readonly clone: string }
  | { readonly kind: 'default-branch'; readonly clone: string; readonly branch: string }
  | { readonly kind: 'fresh'; readonly clone: string; readonly age: number }
  | { readonly kind: 'ask'; readonly clone: string; readonly branch: string };

/**
 * The facts turned into one action per clone, and nothing else.
 *
 * Pure and exported for the reason every decision in this CLI is: `-n` renders exactly this and
 * stops, so a dry run cannot describe something the real run would not do, and every branch is
 * printable in a test without a network.
 */
export const prPlan = (
  facts: {
    readonly clone: string;
    readonly branch: string;
    readonly defaultBranch: string | undefined;
    readonly bitbucket: boolean;
    readonly cached: CachedPullRequest | undefined;
  },
  ttlSeconds: number,
  opts: PrOptions,
  now = Math.floor(Date.now() / 1000),
): PrAction => {
  if (!facts.bitbucket) return { kind: 'no-forge', clone: facts.clone };
  if (facts.branch === DETACHED) return { kind: 'detached', clone: facts.clone };
  /*
   * The default branch has no pull request of its own, and a query for it comes back full of
   * everything ever merged into it -- the same reason the bar draws nothing there.
   */
  if (facts.defaultBranch !== undefined && facts.branch === facts.defaultBranch) {
    return { kind: 'default-branch', clone: facts.clone, branch: facts.branch };
  }
  if (opts.force !== true && !prCacheIsStale(facts.cached, ttlSeconds, now)) {
    return { kind: 'fresh', clone: facts.clone, age: now - (facts.cached?.fetchedAt ?? 0) };
  }
  return { kind: 'ask', clone: facts.clone, branch: facts.branch };
};

export const describePrAction = (action: PrAction): string => {
  switch (action.kind) {
    case 'no-forge':
      return `${action.clone}: this hangar has no Bitbucket forge configured — nothing to ask`;
    case 'detached':
      return `${action.clone}: detached HEAD — no branch to look a pull request up by`;
    case 'default-branch':
      return `${action.clone}: on the default branch (${action.branch}) — no pull request of its own`;
    case 'fresh':
      return `${action.clone}: cached ${String(action.age)}s ago, still fresh — \`--force\` to ask anyway`;
    case 'ask':
      return `${action.clone}: ask Bitbucket about ${action.branch}`;
  }
};

/** One line describing what the bar will now draw. The reason anybody runs this by hand. */
export const describeRecord = (record: CachedPullRequest): string => {
  if (record.id === 0) return 'no pull request for this branch';
  const bits = [`#${String(record.id)}`, record.draft ? 'draft' : record.state];
  if (record.state === 'open') {
    bits.push(`ci ${record.ci}`, `review ${record.review}`);
  }
  return bits.join(' · ');
};

const resolveClones = (hangar: Hangar, refs: readonly string[], opts: PrOptions): Clone[] => {
  if (opts.all === true) return discoverClones(hangar);
  if (refs.length === 0)
    throw new CliError('pr refresh needs a clone name, or --all', knownClonesHint(hangar));
  const byIndex = new Map<number, Clone>();
  for (const ref of refs) {
    const clone = requireClone(hangar, ref);
    byIndex.set(clone.index, clone);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

export const prRefresh = async (
  hangar: Hangar,
  refs: readonly string[],
  opts: PrOptions = {},
): Promise<void> => {
  const clones = resolveClones(hangar, refs, opts);
  const ttl = prCacheTtlSeconds(hangar);
  const bitbucket = usesBitbucket(hangar.config.forge);
  const quiet = opts.quiet === true;

  for (const clone of clones) {
    const branch = currentBranch(clone.path);
    const action = prPlan(
      {
        clone: clone.name,
        branch,
        defaultBranch: hangar.config.forge.defaultBranch,
        bitbucket,
        cached: readCachedPr(hangar, clone, branch),
      },
      ttl,
      opts,
    );
    if (action.kind !== 'ask') {
      if (!quiet) note(describePrAction(action));
      continue;
    }
    if (opts.dryRun === true) {
      note(describePrAction(action));
      continue;
    }
    if (!quiet) step(`${clone.name}: ${branch}`);
    const found = await refreshPullRequest(hangar, clone, branch);
    if (found.reason !== undefined) {
      /*
       * A warning and not a throw, and the loop carries on. `--all` over six clones must not
       * lose five answers to one clone's 401, and the bar keeps whatever it had -- nothing
       * restamped `fetchedAt`, so the next redraw tries again.
       */
      warn(`${clone.name}: could not ask Bitbucket: ${found.reason}`);
      continue;
    }
    if (!quiet && found.record !== undefined) ok(describeRecord(found.record));
  }

  if (opts.dryRun === true) note('(dry run — nothing was written)');
};
