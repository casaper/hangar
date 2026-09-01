import { gitTry } from './git.ts';
import { bitbucketWorkspaceUrl, bitbucketRepo } from './paths.ts';

/**
 * Bitbucket links.
 *
 * There is no Bitbucket credential in `.env.shared`, so nothing here calls an API: a pull
 * request is linked by a search URL keyed on the branch, which needs no auth and lands the
 * user on the right PR (or on an empty list, which is itself the answer). Resolving the
 * actual PR id would need a token the fleet does not have.
 */
export type RepoRef = { readonly workspace: string; readonly repo: string };

const parseRemote = (url: string): RepoRef | undefined => {
  const ssh = /^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh?.[1] && ssh[2]) return { workspace: ssh[1], repo: ssh[2] };
  const https = /^https:\/\/[^@]*bitbucket\.org\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (https?.[1] && https[2]) return { workspace: https[1], repo: https[2] };
  return undefined;
};

export const repoRef = (clonePath: string): RepoRef => {
  const url = gitTry(clonePath, ['remote', 'get-url', 'origin']);
  return (
    (url === undefined ? undefined : parseRemote(url)) ?? {
      workspace: bitbucketWorkspaceUrl.split('/').pop() ?? 'acme',
      repo: bitbucketRepo,
    }
  );
};

export const repoUrl = (ref: RepoRef): string =>
  `https://bitbucket.org/${ref.workspace}/${ref.repo}`;

/**
 * A pull-request search scoped to the branch. Bitbucket's PR list accepts `query`, so this
 * shows the open PR for the branch if there is one.
 */
export const prSearchUrl = (ref: RepoRef, branch: string): string =>
  `${repoUrl(ref)}/pull-requests/?query=${encodeURIComponent(branch)}`;
