import pc from 'picocolors';

import { usesBitbucket } from '../bitbucket.ts';
import { discoverClones } from '../fleet.ts';
import { issueKeyInBranch } from '../generate/tmux-status-sh.ts';
import { currentBranch, lastCommit } from '../git.ts';
import {
  prCacheIsStale,
  prCacheTtlSeconds,
  readCachedPr,
  refreshPullRequest,
  takePrRefreshLock,
  type CachedPullRequest,
} from '../pr-cache.ts';
import { cloneLabel, note, table, truncate } from '../ui.ts';
import { prPlan } from './pr.ts';
import type { Hangar } from '../hangar.ts';

/**
 * How long `list` waits for Bitbucket, across every clone at once.
 *
 * The two calls behind one refresh take under a second together, but each may run to eight before
 * the request timeout gives up -- so with no network an unbounded `list` would take sixteen
 * seconds, and clone sessions and the MCP tool call it freely. Whatever has not answered by then is
 * drawn from the cache and marked stale.
 */
const LIST_REFRESH_DEADLINE_MS = 3000;

/**
 * How much branch one row carries. The ticket has its own column, so what is cut is the tail of
 * the description -- the part that says least -- and the row fits a terminal instead of wrapping.
 * The whole name is `hangar status <n>`'s, and the tmux footer's.
 */
const BRANCH_MAX = 40;

/** What `list` knows about one clone's pull request. */
export type ListPr =
  /** Default branch, detached HEAD or no Bitbucket forge: there is no pull request to have. */
  | { readonly kind: 'none' }
  /** Nobody has asked yet, and this run did not either. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly record: CachedPullRequest; readonly stale: boolean };

const dash = pc.dim('-');

/**
 * The PR, BUILD and REVIEW cells for one clone. Pure, so every variant prints without a network.
 *
 * A merged, declined or superseded pull request shows its state and nothing else, as the bar
 * does: its build and its reviews are settled, and nobody is deciding anything on them.
 */
export const listPrCells = (pr: ListPr): readonly [string, string, string] => {
  if (pr.kind === 'none') return [dash, dash, dash];
  if (pr.kind === 'unknown') return [pc.dim('?'), dash, dash];
  const { record, stale } = pr;
  if (record.id === 0) return [pc.dim(stale ? 'none (stale)' : 'none'), dash, dash];
  const number = `#${String(record.id)}`;
  const label =
    record.state !== 'open'
      ? `${record.state} ${number}`
      : record.draft
        ? `draft ${number}`
        : number;
  const prCell = stale ? pc.dim(`${label} (stale)`) : label;
  if (record.state !== 'open') return [prCell, dash, dash];

  const build =
    record.ci === 'pass'
      ? pc.green('✓ pass')
      : record.ci === 'fail'
        ? pc.red('✗ fail')
        : record.ci === 'running'
          ? pc.yellow('◌ running')
          : dash;
  const counts =
    record.reviewers > 0 ? ` ${String(record.approvals)}/${String(record.reviewers)}` : '';
  const review =
    record.review === 'approved'
      ? pc.green(`approved${counts}`)
      : record.review === 'changes'
        ? pc.red(`changes${counts}`)
        : record.review === 'pending'
          ? pc.yellow(`pending${counts}`)
          : pc.dim('no reviewers');
  return [prCell, build, review];
};

/**
 * `hangar list` -- what clones exist, where each one is, and what each is working on.
 *
 * The branch column is read live from each clone. Never infer a clone's branch from its
 * number or from any table in CLAUDE.md: clones are interchangeable and equal in rank, and
 * whatever a clone has checked out right now is the only answer.
 *
 * The pull request comes out of the same cache the tmux bar draws, and a record past its TTL is
 * refreshed first -- through `refreshPullRequest`, the one writer, under the bar's own lock, and
 * inside one deadline for the whole fleet. That makes this a report that may write the cache,
 * which is what the bar does on every redraw anyway. `--no-refresh` asks Bitbucket for nothing.
 */
export const list = async (
  hangar: Hangar,
  opts: { readonly refresh?: boolean | undefined } = {},
): Promise<void> => {
  const clones = discoverClones(hangar);
  if (clones.length === 0) {
    note('No clones found. Create one with `hangar add-clone`.');
    return;
  }

  const ttl = prCacheTtlSeconds(hangar);
  const bitbucket = usesBitbucket(hangar.config.forge);
  const facts = clones.map((clone) => {
    const branch = currentBranch(clone.path);
    const cached = readCachedPr(hangar, clone, branch);
    const plan = prPlan(
      {
        clone: clone.name,
        branch,
        defaultBranch: hangar.config.forge.defaultBranch,
        bitbucket,
        cached,
      },
      ttl,
      {},
    );
    return { clone, branch, cached, plan };
  });

  const problems: string[] = [];
  if (opts.refresh !== false) {
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, LIST_REFRESH_DEADLINE_MS);
    await Promise.all(
      facts
        .filter((f) => f.plan.kind === 'ask')
        .map(async (f) => {
          // Held means a redraw is already asking about this clone; its answer is the same one.
          const release = takePrRefreshLock(hangar, f.clone);
          if (release === undefined) return;
          try {
            const found = await refreshPullRequest(hangar, f.clone, f.branch, {
              signal: deadline.signal,
            });
            if (found.reason !== undefined) {
              const why = deadline.signal.aborted
                ? `no answer within ${String(LIST_REFRESH_DEADLINE_MS / 1000)}s`
                : found.reason;
              problems.push(`${f.clone.name}: ${why}`);
            } else if (found.record !== undefined) f.cached = found.record;
          } finally {
            release();
          }
        }),
    );
    clearTimeout(timer);
  }

  const rows: string[][] = [
    ['CLONE', 'COLOUR', 'BRANCH', 'ISSUE', 'PR', 'BUILD', 'REVIEW', 'LAST COMMIT'].map((h) =>
      pc.dim(h),
    ),
  ];
  for (const { clone, branch, cached, plan } of facts) {
    const commit = lastCommit(clone.path);
    const commitCell =
      commit === undefined
        ? pc.dim('(no commits)')
        : `${pc.yellow(commit.sha)} ${pc.dim(commit.date)} ${pc.dim(truncate(commit.committer, 18))} ${truncate(commit.subject, 50)}`;
    const key = issueKeyInBranch(hangar, branch);
    const pr: ListPr =
      plan.kind === 'no-forge' || plan.kind === 'detached' || plan.kind === 'default-branch'
        ? { kind: 'none' }
        : cached === undefined
          ? { kind: 'unknown' }
          : { kind: 'known', record: cached, stale: prCacheIsStale(cached, ttl) };
    rows.push([
      cloneLabel(clone),
      clone.colour.name,
      truncate(branch, BRANCH_MAX),
      key === '' ? dash : key,
      ...listPrCells(pr),
      commitCell,
    ]);
  }
  table(rows);
  for (const problem of problems) note(pc.dim(`could not ask Bitbucket about ${problem}`));
};
