/**
 * `hangar dev release` -- run semantic-release from a terminal, behind this repo's own gates.
 *
 * semantic-release does the release: the version from the commit types, the CHANGELOG, the
 * version bump, the release commit, the tag, the push and the GitHub release, all from
 * `.releaserc.json`. It used to run from a GitHub workflow, which never successfully cut
 * anything -- **no tag had ever been pushed to origin**, so in CI it found zero releases, would
 * have treated the next one as the first and published 1.0.0. Run from a developer's machine it
 * sees the local tags and gets the right answer, which is why moving it here fixed it.
 *
 * What this command adds is everything semantic-release will not do for itself:
 *
 * - the preflight, including the tag check that would have caught the failure above;
 * - a refusal on a breaking marker while the CLI is 0.x, which semantic-release has no setting
 *   for and would answer by cutting 1.0.0;
 * - every gate this repo has, since there is no CI to run them;
 * - a confirmation, because the next thing that happens is a push.
 *
 * `hangar-internals/reference/release.md` has the rest of the why.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError, run, runOrThrow } from '../exec.ts';
import { currentBranch, gitOut, gitTry, isDirty } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { blank, confirm, heading, note, ok, step, warn } from '../ui.ts';
import { breakingCommits, parseCommit, type ParsedCommit } from '../release/commits.ts';

export type ReleaseOptions = {
  readonly dryRun?: boolean | undefined;
  readonly skipChecks?: boolean | undefined;
};

/*
 * ASCII unit and record separators, because a commit body may hold any printable text -- these
 * bodies routinely carry blank lines, backticks and `word: value` footers, and every obvious
 * delimiter has already appeared inside one.
 */
const FIELD = '\x1f';
const RECORD = '\x1e';

const commitsSince = (root: string, from: string | undefined): ParsedCommit[] => {
  const range = from === undefined ? 'HEAD' : `${from}..HEAD`;
  return gitOut(root, ['log', range, `--format=%h${FIELD}%s${FIELD}%b${RECORD}`])
    .split(RECORD)
    .map((r) => r.trim())
    .filter((r) => r !== '')
    .map((r) => {
      const [sha = '', subject = '', body = ''] = r.split(FIELD);
      return parseCommit({ sha, subject, body });
    });
};

/**
 * The newest tag reachable from HEAD, or `undefined` in a history that has never been released.
 *
 * `git describe` rather than a version sort of every tag: this is where the range starts, so
 * REACHABILITY is what matters, not which version string sorts highest.
 */
const lastReleaseTag = (root: string): string | undefined =>
  gitTry(root, ['describe', '--tags', '--abbrev=0', '--match=v*']);

type Gate = {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
};

/**
 * Every gate this repo has, run before anything is released.
 *
 * The binaries are reached BY PATH rather than through `pnpm run`, for the reason `bin/hangar`
 * and `app/.husky/commit-msg` both do it: pnpm lives inside an fnm multishell and moves with the
 * Node version, so anything needing it fails in a shell direnv has not touched.
 *
 * Two of these carry a note the deleted workflow was the only record of. **commitlint needs its
 * config named** -- `.commitlintrc.json` is in `app/` and this runs from the hangar root, so a
 * bare invocation errors on a missing config instead of linting anything. And **`scan:secrets`
 * fails rather than skips when gitleaks is absent**: `app/.husky/pre-commit` skips deliberately,
 * because a per-machine developer tool must not block a commit, and the workflow's `scan` job
 * used to be the place that could not be skipped. This is that place now.
 */
const gates = (root: string, from: string | undefined): Gate[] => {
  const app = join(root, 'app');
  const bin = join(app, 'node_modules', '.bin');
  const list: Gate[] = [
    { name: 'typecheck', cmd: join(bin, 'tsc'), args: ['--noEmit'], cwd: app },
    { name: 'lint', cmd: join(bin, 'eslint'), args: ['.'], cwd: app },
    { name: 'format:check', cmd: join(bin, 'prettier'), args: ['--check', '.'], cwd: app },
    { name: 'test', cmd: process.execPath, args: ['--test', 'test/**/*.test.ts'], cwd: app },
    { name: 'scan:secrets', cmd: 'sh', args: ['dev/scan-secrets.sh'], cwd: app },
    { name: 'scan:literals', cmd: 'sh', args: ['dev/scrub-check.sh'], cwd: app },
    { name: 'golden', cmd: 'sh', args: ['dev/golden.sh'], cwd: app },
    {
      name: 'golden diff',
      cmd: 'git',
      args: ['diff', '--exit-code', '--', 'app/dev/golden/gated'],
      cwd: root,
    },
  ];

  if (from !== undefined) {
    list.push({
      name: 'commitlint',
      cmd: join(bin, 'commitlint'),
      args: ['--config', 'app/.commitlintrc.json', '--from', from, '--to', 'HEAD'],
      cwd: root,
    });
  }
  return list;
};

const runGates = (root: string, from: string | undefined): void => {
  heading('Gates');
  for (const gate of gates(root, from)) {
    step(gate.name);
    const res = run(gate.cmd, gate.args, { cwd: gate.cwd, inherit: true });
    if (!res.ok) {
      throw new CliError(
        `the ${gate.name} gate failed (exit ${String(res.code)})`,
        'Fix it and run again, or pass --skip-checks if you have just run them by hand.',
      );
    }
  }
  ok('every gate green');
};

/**
 * Can the token in this shell actually SEE the repository semantic-release is about to release?
 *
 * Checked here rather than left to `@semantic-release/github`'s own `verifyConditions`, because
 * that runs after the whole gate suite -- so the answer arrives several minutes late, as a forty-
 * line AggregateError. It is also the failure most likely to happen: GitHub answers **404 for a
 * repository a token cannot see**, so a missing scope, a fine-grained PAT that does not list this
 * repo, and a token belonging to another account all surface as "the repository does not exist"
 * even while `git push` over SSH works perfectly. That happened here the first time, on a repo
 * that had been deleted and recreated after the token was issued.
 *
 * `gh` is used because it reads the same GH_TOKEN/GITHUB_TOKEN semantic-release does, so it tests
 * the credential that will actually be used. It is a per-machine developer tool, so its ABSENCE
 * is not a failure -- the check is skipped with a note and semantic-release still does its own.
 */
const githubReachable = (root: string): void => {
  if ((process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '') === '') {
    throw new CliError(
      'neither GH_TOKEN nor GITHUB_TOKEN is set in this shell',
      '@semantic-release/github needs one to create the release. It comes from the\n' +
        '       hangar root `.env.local` via direnv, or from your shell profile -- so either\n' +
        '       `direnv allow` here, or this shell predates the profile that sets it.',
    );
  }

  const origin = gitTry(root, ['remote', 'get-url', 'origin']);
  const slug =
    origin === undefined ? undefined : /github\.com[:/](.+?)(?:\.git)?$/.exec(origin)?.[1];
  if (slug === undefined) return; // not GitHub, or an origin shape we do not parse

  if (!run('gh', ['--version']).ok) {
    note('gh is not installed, so the token was not checked against GitHub');
    return;
  }

  /*
   * Two failures that look alike and are not, which is the whole reason this asks twice. A token
   * that does not authenticate at all fails BOTH calls; a token that authenticates but cannot see
   * this repository fails only the second, because GitHub answers 404 rather than 403 for a
   * repository you may not know exists. Both have happened here -- a stale shell for the first,
   * and a repo deleted and recreated AFTER the token was issued for the second.
   */
  const who = run('gh', ['api', 'user', '-q', '.login'], { cwd: root });
  if (!who.ok) {
    throw new CliError(
      'the token in this shell does not authenticate with GitHub',
      'The value comes from the hangar root `.env.local` via direnv, or from your shell\n' +
        '       profile. Either this shell predates it, or the token has expired or been\n' +
        '       revoked. Check with: gh api user',
    );
  }

  if (run('gh', ['api', `repos/${slug}`, '-q', '.full_name'], { cwd: root }).ok) return;

  throw new CliError(
    `the token authenticates as ${who.stdout.trim()}, but cannot see ${slug}`,
    "GitHub answers 404 for a repository a token cannot see, so this is the token's access\n" +
      '       rather than a missing repo -- git over SSH is a different credential and keeps\n' +
      `       working. A fine-grained PAT needs ${slug} in its repository list, and a repo\n` +
      '       recreated after the token was issued is NOT in it; a classic PAT needs `repo`.\n' +
      `       Check with: gh api repos/${slug}`,
  );
};

/**
 * Refuse everything that would make semantic-release answer wrongly, and say why in a sentence.
 *
 * Each of these is something it would otherwise hit halfway through, as a stack trace. The tag
 * check is the one that matters most and the one nothing had: a local tag missing from origin
 * means two readers of the same commits compute different versions -- which is how this repo's
 * releases were going to become 1.0.0 the moment CI ran them.
 */
const preflight = (root: string): string | undefined => {
  const branch = currentBranch(root);
  if (branch !== 'main') {
    throw new CliError(
      `releases are cut from main, and this is ${branch}`,
      '`.releaserc.json` names main as the only release branch.',
    );
  }
  if (isDirty(root)) throw new CliError('the working tree has uncommitted changes');

  githubReachable(root);

  step('fetching origin');
  const fetched = run('git', ['fetch', '--tags', 'origin'], { cwd: root });
  if (!fetched.ok) {
    throw new CliError('could not fetch origin', fetched.stderr.trim() || undefined);
  }

  const behind = gitOut(root, ['rev-list', '--count', 'HEAD..origin/main']);
  if (behind !== '0') {
    throw new CliError(
      `main is ${behind} commit(s) behind origin/main`,
      'Integrate origin/main first -- a release must describe what is actually published.',
    );
  }

  const local = gitOut(root, ['tag', '--list', 'v*'])
    .split('\n')
    .filter((t) => t !== '');
  const remote = new Set(
    runOrThrow('git', ['ls-remote', '--tags', '--refs', 'origin'], { cwd: root })
      .split('\n')
      .map((l) => l.split('refs/tags/')[1] ?? '')
      .filter((t) => t.startsWith('v')),
  );
  const missing = local.filter((t) => !remote.has(t));
  if (missing.length > 0) {
    throw new CliError(
      `${String(missing.length)} tag(s) exist here but not on origin: ${missing.join(', ')}`,
      'Push them first -- anything reading the remote would compute a different version:\n' +
        '         git push origin --tags',
    );
  }

  const from = lastReleaseTag(root);

  /*
   * The one policy semantic-release cannot be told. Its answer to a breaking marker below 1.0.0
   * is to cut 1.0.0, and `app/CLAUDE.md` says that is a decision somebody makes rather than a
   * side effect of a commit message. So it is refused here, before the pipeline starts.
   */
  const pkg = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')) as {
    version: string;
  };
  if (pkg.version.startsWith('0.')) {
    const breaking = breakingCommits(commitsSince(root, from));
    if (breaking.length > 0) {
      throw new CliError(
        `${breaking.length === 1 ? 'a commit is' : `${String(breaking.length)} commits are`} ` +
          `marked as breaking, and this CLI is ${pkg.version}: ` +
          breaking.map((c) => c.sha).join(', '),
        'semantic-release would cut 1.0.0, and that is a decision rather than a commit message.\n' +
          '       Reword the commit to drop the `!` and any `BREAKING CHANGE:` footer.',
      );
    }
  }

  return from;
};

/**
 * What a failed release actually left behind, which is three different states and one message
 * each.
 *
 * semantic-release runs `prepare` (changelog, version bump, release commit), then tags, then
 * **pushes**, and only then `publish` (the GitHub release). So the most likely failure -- a token
 * that can read the repo but not write a release -- leaves everything already on origin, and the
 * first version of this hint said the opposite and told the reader to `git reset --hard`. On a
 * pushed release that is wrong and needs a force-push to carry out. Hence: ask git, do not guess.
 */
const failureHint = (root: string, dryRun: boolean): string | undefined => {
  if (dryRun) return undefined;

  const tag = (gitTry(root, ['tag', '--points-at', 'HEAD']) ?? '')
    .split('\n')
    .find((t) => t.startsWith('v'));
  if (tag === undefined) return 'Nothing was committed or tagged; the tree is as it was.';

  const pushed = run('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`], {
    cwd: root,
  }).ok;

  if (pushed) {
    return (
      `${tag} is committed, tagged AND PUSHED -- do not reset. Only the GitHub release\n` +
      '       is missing, and it can be made from the top section of CHANGELOG.md:\n' +
      `         gh release create ${tag} --title ${tag} --notes-file <notes>\n` +
      '       Running this command again would find nothing to release, which is correct.'
    );
  }
  return (
    `${tag} is committed and tagged HERE and is not on origin. To undo:\n` +
    `         git reset --hard HEAD~1 && git tag -d ${tag}`
  );
};

export const release = (hangar: Hangar, opts: ReleaseOptions): void => {
  const root = hangar.root;
  const pkgPath = join(root, 'app', 'package.json');
  const dryRun = opts.dryRun === true;

  if (!existsSync(pkgPath)) {
    throw new CliError(
      'this hangar is not a checkout of the hangar CLI repository',
      '`hangar dev release` cuts a release of the CLI itself; there is nothing to release here.',
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string };
  if (pkg.name !== 'hangar') {
    throw new CliError(
      `app/package.json here is \`${pkg.name}\`, not the hangar CLI`,
      '`hangar dev release` cuts a release of the CLI itself.',
    );
  }

  const from = preflight(root);
  const commits = commitsSince(root, from);

  heading(dryRun ? 'Release (dry run)' : 'Release');
  note(`${String(commits.length)} commit(s) since ${from ?? 'the first commit'}`);

  if (opts.skipChecks === true) warn('gates skipped');
  else runGates(root, from);

  if (!dryRun) {
    blank();
    if (!confirm('Hand over to semantic-release? It commits, tags, pushes and releases.')) {
      note('nothing was changed');
      return;
    }
  }

  /*
   * From the HANGAR ROOT, not from app/: `.releaserc.json` is there, and semantic-release takes
   * the repository and its remote from the working directory. The binary is reached by path
   * because there is no package.json at that level with a dependency to resolve it from.
   *
   * `--no-ci` is what makes a local run legal: without it semantic-release detects no CI
   * environment and refuses. It is not a weakening -- the branch check, the up-to-date check and
   * the whole verifyConditions pipeline still run.
   */
  const args = ['--no-ci', ...(dryRun ? ['--dry-run'] : [])];
  const res = run(join(root, 'app', 'node_modules', '.bin', 'semantic-release'), args, {
    cwd: root,
    inherit: true,
  });
  if (!res.ok) {
    throw new CliError(`semantic-release exited ${String(res.code)}`, failureHint(root, dryRun));
  }
  ok(dryRun ? 'dry run complete -- nothing was changed' : 'released');
};
