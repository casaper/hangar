import { statSync } from 'node:fs';
import { join } from 'node:path';

import pc from 'picocolors';

import { prSearchUrl, repoRef, usesBitbucket, type RepoRef } from '../bitbucket.ts';
import { CliError } from '../exec.ts';
import { currentBranch, DETACHED } from '../git.ts';
import { requireClone, type Clone } from '../fleet.ts';
import { inferTicket, issueUrl, type TicketGuess } from '../jira.ts';
import { platform } from '../platform/index.ts';
import { readCachedPr, refreshPullRequest, type CachedPullRequest } from '../pr-cache.ts';
import { note, ok, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar browse ticket|pr|tmp <clone>` -- open what a clone is working on, in the browser.
 *
 * `tmp` is the odd one out: not a URL but the ticket's directory under the clone's `tmp/`, where
 * the cached records and attachments land, handed to the platform's opener -- Finder, on macOS.
 * `C-b C-f` in a clone's tmux window runs it.
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
export type BrowseWhat = 'ticket' | 'pr' | 'tmp';

export const BROWSE_WHAT: readonly BrowseWhat[] = ['ticket', 'pr', 'tmp'];

export const isBrowseWhat = (value: string): value is BrowseWhat =>
  (BROWSE_WHAT as readonly string[]).includes(value);

/**
 * A URL or a local directory to open, or the reason there is none. Never a URL missing its host.
 */
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
 * The ticket's directory under the clone's `tmp/`, given the guessed ticket and a way to ask
 * whether a directory exists -- injected, so every answer can be printed side by side in a test.
 *
 * The key is `inferTicket`'s, the one `ticketLink` uses, so the key that opens the issue and the
 * key that opens its directory cannot differ. A directory that does not exist yet is a refusal
 * rather than a fallback to `tmp/` itself: the press asked for one ticket's files, and a Finder
 * window on everything would answer a different question without saying so.
 */
export const tmpLink = (
  clone: Clone,
  ticket: TicketGuess | undefined,
  isDirectory: (path: string) => boolean,
): Link => {
  if (clone.hangar.config.tracker.kind === 'none') {
    return { kind: 'none', why: 'this hangar has no tracker configured' };
  }
  if (ticket === undefined) {
    return {
      kind: 'none',
      why: "no issue key in the branch name or in this branch's commits",
    };
  }
  const dir = join(clone.path, 'tmp', ticket.key);
  if (!isDirectory(dir)) {
    return { kind: 'none', why: `there is no tmp/${ticket.key} yet — fetch the ticket first` };
  }
  return { kind: 'url', url: dir, what: `tmp/${ticket.key}` };
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
  else if (what === 'tmp') link = tmpLink(clone, inferTicket(clone, branch), isDirectory);
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

  /*
   * A refusal and not a warning, because the tmux keys and the bar's click branch on the EXIT
   * STATUS: exiting 0 here would have them report "opened" for a press that opened nothing.
   */
  if (link.kind === 'none') {
    throw new CliError(`nothing to open for ${what} in ${clone.name}`, link.why);
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
    note('this platform has no way to hand a URL or a folder to the desktop — it is above');
    return;
  }
  if (!platform().openExternally(link.url)) throw new CliError(`could not open ${link.url}`);
  ok(`opened ${what} ${link.what} for ${clone.name}`);
};
