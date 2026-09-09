import pc from 'picocolors';

import { prSearchUrl, repoRef, usesBitbucket, type RepoRef } from '../bitbucket.ts';
import { CliError } from '../exec.ts';
import { currentBranch, DETACHED } from '../git.ts';
import { requireClone, type Clone } from '../fleet.ts';
import { inferTicket, issueUrl } from '../jira.ts';
import { platform } from '../platform/index.ts';
import { readCachedPr, refreshPullRequest, type CachedPullRequest } from '../pr-cache.ts';
import { note, ok, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar browse ticket|pr <clone>` -- open what a clone is working on, in the browser.
 *
 * Two callers, and the second one is why the command exists at all:
 *
 * - A developer, who has the clone's ticket or pull request one word away instead of copying a
 *   URL out of `hangar status`.
 * - **A click on the clone's tmux bar.** `generate/tmux-conf.ts` wraps the ticket and the pull
 *   request in `range=user` regions and binds `MouseDown1Status` to run this. tmux 3.7c cannot
 *   emit an OSC 8 hyperlink into a status line -- measured: the escape is stripped and the rest
 *   is drawn as text -- so a clickable region running a command is the mechanism rather than a
 *   workaround, and this is the command it runs.
 *
 * The click is also the reason this is the CLI and not more generated shell. Everything the bar
 * REFRESHES is shell, because tmux re-runs it every ten seconds per client; a click happens when
 * a person decides it does, so it can afford a quarter of a second of Node startup -- and in
 * exchange the URLs come from `issueUrl` and `prSearchUrl` rather than being spelled a second
 * time in a generated script.
 */
export type BrowseWhat = 'ticket' | 'pr';

export const BROWSE_WHAT: readonly BrowseWhat[] = ['ticket', 'pr'];

export const isBrowseWhat = (value: string): value is BrowseWhat =>
  (BROWSE_WHAT as readonly string[]).includes(value);

/** A URL to open, or the reason there is none. Never a URL missing its host. */
export type Link =
  | { readonly kind: 'url'; readonly url: string; readonly what: string }
  | { readonly kind: 'none'; readonly why: string };

/**
 * The ticket link for a clone, from its branch alone.
 *
 * Pure, and given its facts rather than reading them, so every one of the four answers can be
 * printed side by side in a test. The same shape `status`'s `issueRow` has, for the same reason.
 */
export const ticketLink = (clone: Clone): Link => {
  if (clone.hangar.config.tracker.kind === 'none') {
    return { kind: 'none', why: 'this hangar has no tracker configured' };
  }
  const ticket = inferTicket(clone);
  if (ticket === undefined) {
    return {
      kind: 'none',
      why: "no issue key in the branch name or in this branch's commits",
    };
  }
  const url = issueUrl(clone.hangar, ticket.key);
  if (url === undefined) return { kind: 'none', why: 'this hangar has no tracker.baseUrl' };
  return { kind: 'url', url, what: ticket.key };
};

/**
 * The pull-request link, given what is already known -- the cached PR, if any, and the branch.
 *
 * **The search URL is the answer and not a consolation**, which is what makes this total without
 * a network call: Bitbucket's pull-request list takes a branch query, so the link is correct
 * whether or not a PR exists, and the bar's bare ` PR ` label is a link to exactly this. The
 * number is only ever an improvement on it.
 */
export const pullRequestLink = (
  ref: RepoRef | undefined,
  branch: string,
  cached: CachedPullRequest | undefined,
): Link => {
  if (branch === DETACHED) {
    return { kind: 'none', why: 'detached HEAD — no branch to look a pull request up by' };
  }
  /*
   * `id` 0 is the negative record -- asked, and this branch has no pull request. Its url is
   * already the search link, so the click still lands somewhere true; what it must NOT do is
   * announce "#0", which is the one reading of the record that names a pull request that has
   * never existed.
   */
  if (cached !== undefined && cached.id !== 0) {
    return { kind: 'url', url: cached.url, what: `#${String(cached.id)}` };
  }
  const search = prSearchUrl(ref, branch);
  if (search === undefined) {
    return { kind: 'none', why: 'forge.originUrl is not a Bitbucket repository' };
  }
  return { kind: 'url', url: search, what: `pull requests for ${branch}` };
};

export type BrowseOptions = { readonly dryRun?: boolean | undefined };

export const browse = async (
  hangar: Hangar,
  what: string,
  cloneRef: string,
  opts: BrowseOptions = {},
): Promise<void> => {
  if (!isBrowseWhat(what)) {
    throw new CliError(
      `unknown thing to browse "${what}"`,
      `Try one of: ${BROWSE_WHAT.join(', ')}.`,
    );
  }
  const clone = requireClone(hangar, cloneRef);
  const branch = currentBranch(clone.path);

  let link: Link;
  if (what === 'ticket') link = ticketLink(clone);
  else {
    /*
     * The cache first, then Bitbucket -- and asking is right here in a way it never is on the
     * bar: this is one person, once, who has already decided to wait for a browser to open.
     * The answer is written back, which is how the bar comes to know the number at all without
     * `sync` having run since the branch was made.
     */
    let cached = readCachedPr(hangar, clone, branch);
    if (cached === undefined && branch !== DETACHED && usesBitbucket(hangar.config.forge)) {
      const found = await refreshPullRequest(hangar, clone, branch, {
        write: opts.dryRun !== true,
      });
      if (found.reason !== undefined) warn(`could not ask Bitbucket: ${found.reason}`);
      cached = found.record;
    }
    link = pullRequestLink(repoRef(hangar, clone.path), branch, cached);
  }

  if (link.kind === 'none') {
    warn(`nothing to open for ${what} in ${clone.name}: ${link.why}`);
    return;
  }
  note(pc.dim(link.url));
  if (opts.dryRun === true) return;
  /*
   * A capability that is false costs one line rather than the command: the URL is already
   * printed above, so a platform that cannot hand a path to a desktop leaves a link to click in
   * the terminal -- the same degradation `hangar open` makes when an emulator cannot raise a
   * window.
   */
  if (!platform().capabilities.openExternally) {
    note('this platform has no way to hand a URL to a browser — the link is above');
    return;
  }
  if (platform().openExternally(link.url)) ok(`opened ${what} ${link.what} for ${clone.name}`);
  else warn(`could not open ${link.url}`);
};
