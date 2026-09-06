/**
 * `hangar dev release` -- cut a release of this CLI from a terminal instead of a workflow.
 *
 * It replaces a semantic-release job that had never successfully cut anything, and the reason it
 * had not is worth keeping: no tag had ever been pushed to `origin`, so semantic-release found
 * zero releases, treated the next one as the first, and would have published **1.0.0** -- the
 * exact outcome this repo's "no `!` while the CLI is 0.x" rule exists to prevent. That failure
 * is now a preflight check rather than a workflow to repair.
 *
 * The shape is deliberately the same as the tool it replaces, because that behaviour was never
 * the problem: the version comes from the commit types, the CHANGELOG is rendered from the same
 * conventional-changelog preset, and the release commit carries both files. What changed is who
 * runs it and what happens before it: every gate in this repo runs first, and a human confirms.
 *
 * `hangar-internals/reference/release.md` has the rest of the why.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError, run, runOrThrow } from '../exec.ts';
import { currentBranch, gitOut, gitTry, isDirty, refExists } from '../git.ts';
import type { Hangar } from '../hangar.ts';
import { blank, confirm, heading, note, ok, step, warn } from '../ui.ts';
import {
  nextVersion,
  parseCommit,
  releasePlanText,
  type ParsedCommit,
} from '../release/version.ts';

export type ReleaseOptions = {
  readonly dryRun?: boolean | undefined;
  readonly skipChecks?: boolean | undefined;
  /** commander's `--no-push` / `--no-github` give these as `false`; the default is `true`. */
  readonly push: boolean;
  readonly github: boolean;
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
  const raw = gitOut(root, ['log', range, `--format=%h${FIELD}%s${FIELD}%b${RECORD}`]);

  return raw
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

/**
 * The section `changelog.sh` just wrote, lifted back out to become the tag's message.
 *
 * From the first `## ` heading to the next one -- the file opens with `# Changelog`, and the
 * release being cut is always the topmost section because it is the only one not yet tagged.
 */
const topSection = (changelog: string): string => {
  const lines = changelog.split('\n');
  const first = lines.findIndex((l) => l.startsWith('## '));
  if (first === -1) throw new CliError('CHANGELOG.md has no release section to tag with');
  const rest = lines.slice(first + 1).findIndex((l) => l.startsWith('## '));
  const end = rest === -1 ? lines.length : first + 1 + rest;
  return lines.slice(first, end).join('\n').trim();
};

type Gate = {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
};

/**
 * Every gate this repo has, run before a version is cut.
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
 * Refuse everything that would make the computed version wrong.
 *
 * The tag check is the one that matters most and the one no previous version of this had: if a
 * local tag is missing from `origin`, then whatever reads the remote -- a colleague's clone, a
 * fresh checkout, anything -- computes a different version from the same commits. That is not a
 * tidiness problem; it is how this repo's releases were going to become 1.0.0.
 */
const preflight = (root: string): void => {
  const branch = currentBranch(root);
  if (branch !== 'main') {
    throw new CliError(`releases are cut from main, and this is ${branch}`);
  }
  if (isDirty(root)) {
    throw new CliError('the working tree has uncommitted changes');
  }

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
};

export const release = (hangar: Hangar, opts: ReleaseOptions): void => {
  const root = hangar.root;
  const pkgPath = join(root, 'app', 'package.json');

  if (!existsSync(pkgPath)) {
    throw new CliError(
      'this hangar is not a checkout of the hangar CLI repository',
      '`hangar dev release` cuts a release of the CLI itself; there is nothing to release here.',
    );
  }
  const pkgText = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText) as { name: string; version: string };
  if (pkg.name !== 'hangar') {
    throw new CliError(
      `app/package.json here is \`${pkg.name}\`, not the hangar CLI`,
      '`hangar dev release` cuts a release of the CLI itself.',
    );
  }

  preflight(root);

  const from = lastReleaseTag(root);
  const commits = commitsSince(root, from);
  const next = nextVersion(pkg.version, commits);

  if (next === undefined) {
    ok(`nothing to release since ${from ?? 'the first commit'}`);
    note(`${String(commits.length)} commit(s), none of which move the version`);
    return;
  }

  const tag = `v${next.version}`;
  if (refExists(root, tag)) throw new CliError(`${tag} already exists here`);

  heading(`Release ${tag}`);
  console.log(releasePlanText({ from, current: pkg.version, next, tag, commits }));
  blank();

  if (opts.dryRun === true) {
    note('dry run -- nothing was changed');
    return;
  }

  if (opts.skipChecks === true) warn('gates skipped');
  else runGates(root, from);

  blank();
  if (!confirm(`Cut ${tag}${opts.push ? ' and push it' : ' locally'}?`)) {
    note('nothing was changed');
    return;
  }

  heading('Cutting');

  // A targeted replace, not JSON.stringify: rewriting the file would reformat every line of it
  // and put the whole package into the release diff.
  const bumped = pkgText.replace(/("version":\s*)"[^"]+"/, `$1"${next.version}"`);
  if (bumped === pkgText) {
    throw new CliError('could not find the version field in app/package.json');
  }
  writeFileSync(pkgPath, bumped);
  ok(`app/package.json  ${pkg.version} -> ${next.version}`);

  // BEFORE the tag, deliberately: `changelog.sh` reads the version from app/package.json for the
  // section it has no tag for yet, which is how the heading and the compare link come out right.
  runOrThrow('sh', ['dev/changelog.sh'], { cwd: join(root, 'app') });
  ok('CHANGELOG.md regenerated');

  const notes = topSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'));

  runOrThrow('git', ['add', '--', 'app/package.json', 'CHANGELOG.md'], { cwd: root });
  // The `release` scope is not decoration: CHANGELOG_TYPES hides `chore(release)` so this commit
  // stays out of the section it is committing. Renaming the scope brings it back in.
  runOrThrow('git', ['commit', '-m', `chore(release): ${next.version}`], { cwd: root });
  ok(`committed  chore(release): ${next.version}`);

  runOrThrow('git', ['tag', '-a', tag, '-m', notes], { cwd: root });
  ok(`tagged     ${tag}`);

  if (!opts.push) {
    note('not pushed (--no-push)');
    return;
  }
  runOrThrow('git', ['push', 'origin', 'main'], { cwd: root });
  runOrThrow('git', ['push', 'origin', tag], { cwd: root });
  ok(`pushed     main and ${tag}`);

  if (!opts.github) {
    note('no GitHub release (--no-github)');
    return;
  }
  // A missing or unauthenticated `gh` WARNS rather than fails: the tag is pushed by now and is
  // the durable artifact. A GitHub release is a rendering of it and can be made later by hand.
  const created = run('gh', ['release', 'create', tag, '--title', tag, '--notes', notes], {
    cwd: root,
  });
  if (created.ok) {
    ok(`released   ${tag} on GitHub`);
  } else {
    warn('could not create the GitHub release; the tag is pushed and it can be made by hand');
    note(created.stderr.trim() || `gh exited ${String(created.code)}`);
    note(`gh release create ${tag} --title ${tag} --notes-file <notes>`);
  }
};
