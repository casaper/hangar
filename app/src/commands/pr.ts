import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createPullRequest,
  openPullRequests,
  pullRequestDetail,
  repoRef,
  setPullRequest,
  tokenOwner,
  usesBitbucket,
  type NewPullRequest,
  type PullRequestDetail,
  type PullRequestEdit,
} from '../bitbucket.ts';
import { humanMs, runHeadlessClaude } from '../claude-headless.ts';
import { requireDefaultBranch, tryDefaultBranch } from '../config/default-branch.ts';
import { CliError } from '../exec.ts';
import { currentBranch, DETACHED, git, gitTry, refExists } from '../git.ts';
import {
  cloneAt,
  cloneForCwd,
  cloneNameFor,
  discoverClones,
  knownClonesHint,
  requireClone,
  type Clone,
} from '../fleet.ts';
import { inferTicket } from '../jira.ts';
import {
  descriptionState,
  descriptionsIn,
  pickDescription,
  splitDescription,
  type DescriptionCandidate,
  type DescriptionState,
} from '../pr-description.ts';
import {
  prCacheIsStale,
  prCacheTtlSeconds,
  pickPullRequest,
  readCachedPr,
  refreshPullRequest,
  type CachedPullRequest,
} from '../pr-cache.ts';
import { claudeSessionsIn } from '../procs.ts';
import { confirm, note, ok, step, warn } from '../ui.ts';
import { tildify } from '../user-paths.ts';
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

/* ---- pr create / pr update -------------------------------------------------------------------
 *
 * The only two commands in this CLI that WRITE to the forge, which is what makes them different
 * in kind from everything above: a wrong `pr refresh` costs a stale character on a status bar,
 * and a wrong `pr create` is a pull request the whole team can see, with reviewers notified.
 *
 * Three properties follow from that and are worth reading before changing either:
 *
 * - **Every guard fails closed.** `openPullRequests` never throws -- offline, tokenless, a 401
 *   and malformed JSON all arrive as a soft `ok: false`, and every OTHER caller in this codebase
 *   treats that as "carry on without it". As an existence guard the same value means "we do not
 *   know whether one exists", and carrying on there opens a DUPLICATE pull request on a network
 *   timeout. So this is the one place a soft failure is promoted to an abort.
 * - **What Bitbucket answered is what gets reported, never what was sent.** That API silently
 *   accepts and drops fields it does not recognise; the create FORM's `title=` parameter was
 *   documented as working for months on exactly that behaviour. So the created pull request is
 *   parsed back out of the response and compared with the request, and the draft flag -- the one
 *   whose failure is irreversible, because a ready pull request has already notified its
 *   reviewers -- is a hard failure rather than a warning.
 * - **The clone comes from where you are standing.** Inside a clone's shell the argument may be
 *   omitted or may name that same clone, and naming a DIFFERENT one is refused. This is the
 *   fleet's own "stay in your own clone" rule reaching the one command whose mistake is
 *   published, and it is the reason `--all` does not exist here.
 */

export type CloneChoice =
  | { readonly kind: 'ok'; readonly index: number }
  /** At the hangar root with no argument: nothing to infer from. */
  | { readonly kind: 'which' }
  /** In one clone, naming another. */
  | { readonly kind: 'elsewhere'; readonly here: number; readonly asked: number };

/**
 * Which clone a forge write is for, from where it was run and what it was told.
 *
 * Pure and exported because all four cases matter and none of them is reachable in a test with a
 * real working directory: the interesting ones are "inside clone 3, asked for clone 4" and
 * "hangar root, asked for nothing", and neither can be constructed by `process.chdir`.
 */
export const prCloneChoice = (here: number | undefined, asked: number | undefined): CloneChoice => {
  if (here === undefined) {
    return asked === undefined ? { kind: 'which' } : { kind: 'ok', index: asked };
  }
  if (asked === undefined || asked === here) return { kind: 'ok', index: here };
  return { kind: 'elsewhere', here, asked };
};

/** Everything that stops a forge write before anything is asked of Bitbucket. */
export type PrBlock =
  | { readonly kind: 'no-forge' }
  | { readonly kind: 'detached' }
  | { readonly kind: 'default-branch'; readonly branch: string }
  | { readonly kind: 'not-on-origin'; readonly branch: string }
  | { readonly kind: 'unpushed'; readonly branch: string; readonly ahead: number };

export type PrBlockFacts = {
  readonly bitbucket: boolean;
  readonly branch: string;
  readonly defaultBranch: string | undefined;
};

/** The checks both commands share. `undefined` means nothing local stands in the way. */
export const prCommonBlock = (facts: PrBlockFacts): PrBlock | undefined => {
  if (!facts.bitbucket) return { kind: 'no-forge' };
  if (facts.branch === DETACHED) return { kind: 'detached' };
  /*
   * The default branch is where pull requests go TO. One from it would target itself, and the
   * lookup for it comes back full of everything ever merged -- the same reason the bar draws
   * nothing there.
   */
  if (facts.defaultBranch !== undefined && facts.branch === facts.defaultBranch) {
    return { kind: 'default-branch', branch: facts.branch };
  }
  return undefined;
};

/**
 * `create`'s own two, on top of the shared ones.
 *
 * Both are about origin rather than about the forge, and both are refusals rather than warnings.
 * A branch origin does not have cannot be a pull request's source at all. A branch origin has
 * WITHOUT its latest commits is worse than that: the pull request opens, looks complete, and is
 * missing exactly the work the description describes -- and nothing on the page says so.
 */
export const prCreateBlock = (
  facts: PrBlockFacts & { readonly onOrigin: boolean; readonly ahead: number },
): PrBlock | undefined => {
  const common = prCommonBlock(facts);
  if (common !== undefined) return common;
  if (!facts.onOrigin) return { kind: 'not-on-origin', branch: facts.branch };
  if (facts.ahead > 0) return { kind: 'unpushed', branch: facts.branch, ahead: facts.ahead };
  return undefined;
};

export type Refusal = { readonly line: string; readonly hint?: string | undefined };

/** One line per block, plus what to do about it. `-n` prints these and so does the abort. */
export const describePrBlock = (clone: string, block: PrBlock): Refusal => {
  switch (block.kind) {
    case 'no-forge':
      return {
        line: `${clone}: this hangar has no Bitbucket forge configured`,
        hint: 'Set `forge.originUrl` to a Bitbucket repository, or `forge.kind: none` to say there is none.',
      };
    case 'detached':
      return { line: `${clone}: detached HEAD — a pull request needs a branch to come from` };
    case 'default-branch':
      return {
        line: `${clone}: on the default branch (${block.branch}) — nothing to open a pull request from`,
      };
    case 'not-on-origin':
      return {
        line: `${clone}: origin has no branch ${block.branch}`,
        // Not offered as something to do for you: pushing is the user's own action, which is
        // this fleet's rule rather than this command's caution.
        hint: `Push it first: git -C ${clone} push -u origin ${block.branch}`,
      };
    case 'unpushed':
      return {
        line: `${clone}: ${String(block.ahead)} commit(s) on ${block.branch} are not on origin`,
        hint: `A pull request opened now would be missing them. Push first: git -C ${clone} push`,
      };
  }
};

/** The two states that need something done about them. `fresh` is not a problem to describe. */
export type MissingOrStale = Exclude<DescriptionState, { readonly kind: 'fresh' }>;

export type BodyDecision =
  | { readonly kind: 'use'; readonly file: DescriptionCandidate }
  | { readonly kind: 'regenerate'; readonly state: MissingOrStale }
  | {
      readonly kind: 'refuse';
      readonly state: MissingOrStale;
      readonly reason: 'declined' | 'no-prompt' | 'busy';
    };

/**
 * Use the description that is there, have one written, or stop.
 *
 * The `busy` refusal is the one worth explaining. A clone with a live Claude Code session in it
 * already has an agent; spawning a second headless one into the same working directory is this
 * fleet's worst failure mode, and the session that is already there is better placed to write the
 * description anyway -- it has the conversation that produced the branch. So the command says so
 * instead, and `--include-busy` is for the case where the "live session" is a shell somebody left
 * open.
 */
export const bodyDecision = (
  state: DescriptionState,
  opts: {
    readonly describe: boolean;
    readonly prompt: string | undefined;
    readonly busy: boolean;
  },
): BodyDecision => {
  if (state.kind === 'fresh') return { kind: 'use', file: state.file };
  if (!opts.describe) return { kind: 'refuse', state, reason: 'declined' };
  if (opts.prompt === undefined) return { kind: 'refuse', state, reason: 'no-prompt' };
  if (opts.busy) return { kind: 'refuse', state, reason: 'busy' };
  return { kind: 'regenerate', state };
};

const day = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** Why the description on disk cannot be used as it stands. */
export const describeDescriptionState = (state: MissingOrStale, lookedIn: string): Refusal => {
  if (state.kind === 'missing') {
    return { line: `no pull-request description for this branch under ${lookedIn}` };
  }
  return {
    line: `the description at ${state.file.path} was written ${day(state.file.mtimeMs)}, before this branch's last commit (${day(state.tipMs)})`,
  };
};

export type Disagreement = {
  readonly field: string;
  readonly asked: string;
  readonly answered: string;
};

/**
 * Where Bitbucket's answer differs from the request -- the check the read-back exists for.
 *
 * The title is compared because it is the field already known to be droppable on the web form,
 * and the destination because a pull request onto the wrong branch is a wrong merge waiting to be
 * approved. `draft` is here too, and its caller treats it as fatal rather than as a warning.
 */
export const readBackDisagreements = (
  asked: NewPullRequest,
  answered: PullRequestDetail,
): Disagreement[] => {
  const found: Disagreement[] = [];
  if (answered.pr.title !== asked.title) {
    found.push({ field: 'title', asked: asked.title, answered: answered.pr.title });
  }
  if (answered.pr.destination !== asked.destination) {
    found.push({
      field: 'destination',
      asked: asked.destination,
      answered: answered.pr.destination,
    });
  }
  /*
   * Trimmed, and a difference here is a warning rather than a failure: Bitbucket is entitled to
   * normalise line endings and trailing space in a Markdown body, and reporting that as a
   * dropped description would be a false alarm on every single run.
   */
  if (answered.description.trim() !== asked.body.trim()) {
    found.push({ field: 'description', asked: 'the description sent', answered: 'something else' });
  }
  if (answered.pr.draft !== asked.draft) {
    found.push({
      field: 'draft',
      asked: asked.draft ? 'draft' : 'ready for review',
      answered: answered.pr.draft ? 'draft' : 'ready for review',
    });
  }
  return found;
};

/* ---- the two actions ------------------------------------------------------------------------ */

export type PrCreateOptions = {
  onto?: string | undefined;
  title?: string | undefined;
  file?: string | undefined;
  /** Open it ready for review instead of as a draft. */
  ready?: boolean | undefined;
  /** `--no-describe` arrives here as `false`. */
  describe?: boolean | undefined;
  includeBusy?: boolean | undefined;
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
};

export type PrUpdateOptions = {
  title?: string | undefined;
  file?: string | undefined;
  keepTitle?: boolean | undefined;
  keepBody?: boolean | undefined;
  draft?: boolean | undefined;
  ready?: boolean | undefined;
  describe?: boolean | undefined;
  includeBusy?: boolean | undefined;
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
};

/**
 * Which clone, refusing to reach into another one.
 *
 * `cloneForCwd` is asked FIRST, so a shell standing in a clone needs no argument at all -- and an
 * argument naming a different clone is a refusal rather than an override. See the block comment
 * above: this is the one command whose mistake is published, and the fleet's own rule is that a
 * session works in the clone it is in.
 */
const forgeClone = (hangar: Hangar, ref: string | undefined, command: string): Clone => {
  const here = cloneForCwd(hangar);
  const asked = ref === undefined ? undefined : requireClone(hangar, ref);
  const choice = prCloneChoice(here?.index, asked?.index);
  if (choice.kind === 'which') {
    throw new CliError(
      `${command} needs a clone when it is not run from inside one`,
      knownClonesHint(hangar),
    );
  }
  if (choice.kind === 'elsewhere') {
    throw new CliError(
      `${command} will not act on ${cloneNameFor(hangar, choice.asked)} from inside ${cloneNameFor(hangar, choice.here)}`,
      "Run it in that clone's own shell, or from the hangar root.",
    );
  }
  return asked ?? here ?? cloneAt(hangar, choice.index);
};

const refuse = (clone: string, block: PrBlock): CliError => {
  const said = describePrBlock(clone, block);
  return new CliError(said.line, said.hint);
};

/** The branch tip's committer time in MILLISECONDS -- `%ct` is seconds. */
const tipCommitMs = (clone: Clone): number => {
  const seconds = gitTry(clone.path, ['log', '-1', '--format=%ct']);
  const parsed = seconds === undefined ? Number.NaN : Number.parseInt(seconds, 10);
  return Number.isFinite(parsed) ? parsed * 1000 : 0;
};

type ResolvedBody = {
  readonly title: string;
  readonly body: string;
  /** Where it came from, named in the report and in the confirmation. */
  readonly from: string;
  /** False for the keyless fallback, which belongs to no branch in particular. */
  readonly trusted: boolean;
};

type BodyOutcome =
  | { readonly kind: 'ready'; readonly text: ResolvedBody }
  /** Only ever returned on a dry run: the real run would have written one instead. */
  | { readonly kind: 'would-regenerate'; readonly state: MissingOrStale };

const readDescriptionFile = (path: string, from: string, trusted: boolean): ResolvedBody => {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    throw new CliError(`cannot read the pull-request description at ${path}`);
  }
  const text = splitDescription(content);
  if (text.title === '') {
    throw new CliError(
      `${tildify(path)} has no \`# \` heading, so there is no title to give the pull request`,
      'Add one as the first line, or pass --title.',
    );
  }
  return { title: text.title, body: text.body, from, trusted };
};

/** How long a description run may take before it is a hang rather than a long answer. */
const DESCRIBE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Have the clone's own agent write the description, then let the caller re-check the disk.
 *
 * The allowlist is what keeps this safe to start unattended: the run can read the repository,
 * run its own collector and write into `tmp/`, and it cannot commit, push or open a pull request
 * -- `Bash` is granted per prefix rather than whole. A tool outside the list is auto-denied and
 * the model reads the refusal and carries on (measured for the conflict resolver, same spawn), so
 * a list that is too tight degrades into a worse description rather than into a hang.
 */
const writeDescription = async (clone: Clone, branch: string, prompt: string): Promise<void> => {
  step(`${clone.name}: asking Claude Code in the clone to write the pull-request description`);
  note('a headless Claude Code run is now working in this clone — leave it alone');
  note(`progress follows; typically 1-3 minutes, aborted after ${humanMs(DESCRIBE_TIMEOUT_MS)}`);
  const run = await runHeadlessClaude({
    repo: clone.path,
    prompt: [
      prompt,
      '',
      `This is for the pull request that \`hangar pr create\` is about to open from branch ${branch}.`,
      'Write the description to the path your own instructions name, and print that path.',
      'Do NOT open, modify or decline a pull request yourself, and do not commit or push.',
    ].join('\n'),
    permissionMode: 'acceptEdits',
    timeoutMs: DESCRIBE_TIMEOUT_MS,
    interactive: true,
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Grep',
      'Glob',
      'Bash(node:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
      'Bash(git rev-parse:*)',
      'Bash(git merge-base:*)',
      'Bash(mkdir:*)',
    ],
  });
  if (!run.ok) {
    throw new CliError(
      `${clone.name}: the description run did not finish: ${run.reason ?? 'unknown'}`,
      'Nothing was created. Write the description in that clone yourself and run this again.',
    );
  }
};

/**
 * The title and body, from whichever of the four sources applies.
 *
 * `--file` and `--title` are taken at face value and never freshness-checked: the caller named
 * them, and second-guessing an explicit argument is how a flag stops being useful.
 */
const resolveBody = async (
  hangar: Hangar,
  clone: Clone,
  branch: string,
  opts: PrCreateOptions | PrUpdateOptions,
): Promise<BodyOutcome> => {
  if (opts.file !== undefined) {
    const text = readDescriptionFile(opts.file, opts.file, true);
    return {
      kind: 'ready',
      text: opts.title === undefined ? text : { ...text, title: opts.title },
    };
  }
  if (opts.title !== undefined) {
    return {
      kind: 'ready',
      text: { title: opts.title, body: '', from: '--title, with no description', trusted: true },
    };
  }

  const key = inferTicket(clone, branch)?.key;
  /*
   * The CLONE's own `tmp/`, not the hangar's shared store, and that is the difference between
   * this working and not. Every entry under a clone's `tmp/` is a symlink into the store -- so
   * this root reaches everything the store holds, `statSync` following the link -- but a ticket
   * directory the clone's agent created in the session that is still running is a REAL directory
   * there and has not been merged yet. `tmp merge` runs at `SessionEnd`, which is strictly after
   * the moment somebody wants a pull request for the branch they just described.
   *
   * It is also the narrower read: a description another clone wrote for the same ticket is
   * exactly the last-writer-wins hazard, and this way it is not consulted until that clone's
   * session has ended and `tmp merge` has linked it in.
   */
  const store = join(clone.path, 'tmp');
  const lookedIn = key === undefined ? tildify(store) : `${tildify(store)} (as pr…${key}….md)`;
  const tipMs = tipCommitMs(clone);
  const found = pickDescription(descriptionsIn(store, key));
  const state = descriptionState(found, tipMs);
  const prompt = hangar.config.forge.prDescriptionPrompt;
  const decision = bodyDecision(state, {
    describe: opts.describe !== false,
    prompt,
    busy: opts.includeBusy !== true && claudeSessionsIn(clone.path).length > 0,
  });

  if (decision.kind === 'use') {
    const file = decision.file;
    return {
      kind: 'ready',
      text: readDescriptionFile(file.path, tildify(file.path), file.trusted),
    };
  }
  if (decision.kind === 'refuse') {
    const said = describeDescriptionState(decision.state, lookedIn);
    const hint =
      decision.reason === 'declined'
        ? 'Drop --no-describe to have one written, or pass --file/--title.'
        : decision.reason === 'busy'
          ? `${clone.name} has a live Claude Code session — ask it to write the description, or pass --include-busy to start a second run in that clone anyway.`
          : 'Set `forge.prDescriptionPrompt` to have one written for you, or pass --file/--title.';
    throw new CliError(`${clone.name}: ${said.line}`, hint);
  }

  /*
   * A dry run stops here rather than spawning. Writing a description is a real write into a
   * store every clone links a symlink to, and `-n` changing nothing is the property this CLI's
   * whole dry-run output rests on.
   */
  if (opts.dryRun === true) return { kind: 'would-regenerate', state: decision.state };

  note(`${clone.name}: ${describeDescriptionState(decision.state, lookedIn).line}`);
  /*
   * Asked BEFORE the run, and this is the second confirmation rather than a duplicate of the one
   * further down. That one is about publishing; this one is about putting a headless agent into
   * somebody's clone for one to three minutes, which is the thing the `busy` check exists to keep
   * from happening unasked. It also matters that it fails closed: without it, an invocation with
   * no terminal spent the whole run and then declined to create anything at the end.
   */
  if (opts.yes !== true && !confirm(`Have Claude Code write the description in ${clone.name}?`)) {
    throw new CliError(
      `${clone.name}: no description was written`,
      'Nothing was created. Pass -y to allow the run without asking, or --file/--title to supply the text yourself.',
    );
  }
  // `prompt` cannot be undefined on this branch -- `bodyDecision` refuses `no-prompt` above --
  // but the narrowing does not survive the call, and a `??` here would silently send an empty
  // prompt if that ever stopped being true.
  await writeDescription(clone, branch, prompt ?? '');

  const again = pickDescription(descriptionsIn(store, key));
  const now = descriptionState(again, tipMs);
  if (now.kind !== 'fresh') {
    throw new CliError(
      `${clone.name}: the run finished but left no current description under ${lookedIn}`,
      'Nothing was created. Check what that run wrote, then run this again.',
    );
  }
  return {
    kind: 'ready',
    text: readDescriptionFile(now.file.path, tildify(now.file.path), now.file.trusted),
  };
};

const bodyLines = (body: string): string =>
  body.trim() === '' ? 'empty' : `${String(body.trim().split('\n').length)} lines`;

/**
 * `hangar pr create [clone]` -- open the pull request this branch does not have yet.
 *
 * Idempotent on purpose: a branch that already has one open is reported and left alone, exit 0,
 * because "unless one already exists" is what makes this safe to re-run without thinking about
 * whether the last run got that far.
 */
export const prCreate = async (
  hangar: Hangar,
  ref: string | undefined,
  opts: PrCreateOptions = {},
): Promise<void> => {
  const clone = forgeClone(hangar, ref, 'pr create');
  const branch = currentBranch(clone.path);
  const facts = {
    bitbucket: usesBitbucket(hangar.config.forge),
    branch,
    defaultBranch: tryDefaultBranch(hangar),
  };
  const common = prCommonBlock(facts);
  if (common !== undefined) throw refuse(clone.name, common);

  /*
   * Fetched before origin is judged, on the dry run too. `onOrigin` and `ahead` read
   * remote-tracking refs, and a stale one is exactly the wrong answer here: it would report a
   * branch as unpushed that was pushed an hour ago, or -- far worse -- as pushed when the last
   * three commits are local. Only refs under `refs/remotes` move; no local branch and no file in
   * the working tree is touched, which is what makes it acceptable under `-n`.
   */
  const fetched = git(clone.path, ['fetch', '--quiet', 'origin', branch]);
  const onOrigin = fetched.ok || refExists(clone.path, `origin/${branch}`);
  const ahead = Number.parseInt(
    gitTry(clone.path, ['rev-list', '--count', `origin/${branch}..HEAD`]) ?? '0',
    10,
  );
  const block = prCreateBlock({ ...facts, onOrigin, ahead: Number.isFinite(ahead) ? ahead : 0 });
  if (block !== undefined) throw refuse(clone.name, block);

  const repo = repoRef(hangar, clone.path);
  const lookup = await openPullRequests(hangar, repo, branch);
  if (!lookup.ok) {
    /*
     * The one place a soft lookup failure becomes an abort. `ok: false` here does not mean "no
     * pull request"; it means we do not know -- and creating one on that is how a network
     * timeout turns into a duplicate pull request somebody has to decline.
     */
    throw new CliError(
      `${clone.name}: could not find out whether ${branch} already has a pull request: ${lookup.reason}`,
      'Nothing was created. This stops rather than risk opening a second one.',
    );
  }
  const already = lookup.pullRequests[0];
  if (already !== undefined) {
    ok(`${clone.name}: #${String(already.id)} is already open for ${branch}`);
    note(already.url);
    if (lookup.pullRequests.length > 1) {
      note(`(${String(lookup.pullRequests.length)} are open for this branch)`);
    }
    return;
  }

  const destination = opts.onto ?? requireDefaultBranch(hangar, { persist: opts.dryRun !== true });
  const outcome = await resolveBody(hangar, clone, branch, opts);
  const draft = opts.ready !== true;

  if (outcome.kind === 'would-regenerate') {
    note(`${clone.name}: would write a description first, then open a pull request`);
    note(`  ${describeDescriptionState(outcome.state, tildify(hangar.paths.tmp)).line}`);
    note(`  into:  ${destination}`);
    note(`  state: ${draft ? 'draft' : 'ready for review'}`);
    note('(dry run — nothing was written and no run was started)');
    return;
  }

  const text = outcome.text;
  const asked: NewPullRequest = {
    source: branch,
    destination,
    title: text.title,
    body: text.body,
    draft,
  };

  step(`${clone.name}: open a pull request from ${branch}`);
  note(`title:       ${text.title}`);
  note(`into:        ${destination}`);
  note(`description: ${text.from} (${bodyLines(text.body)})`);
  note(`state:       ${draft ? 'draft' : 'ready for review'}`);
  if (!text.trusted) {
    warn(
      'that description file is not named after this branch — the shared tmp/ store is written by every clone, so check the title above is this branch’s',
    );
  }
  if (opts.dryRun === true) {
    note('(dry run — nothing was created)');
    return;
  }
  if (opts.yes !== true && !confirm('Open this pull request?')) {
    // Also the answer with NO terminal, where `confirm` fails closed -- an MCP tool call among
    // them. So the line has to say how to mean yes, or a tool call looks like a silent no-op.
    note('nothing was created — pass -y (a tool call: `yes: true`) to skip the question');
    return;
  }

  const created = await createPullRequest(hangar, repo, asked);
  if (!created.ok) {
    throw new CliError(`${clone.name}: Bitbucket refused the pull request: ${created.reason}`);
  }
  const made = created.value;
  ok(`${clone.name}: #${String(made.pr.id)} ${made.pr.draft ? 'draft' : 'open'} → ${made.pr.url}`);
  // Through the one writer, so the clone bar names it at the next redraw rather than at the next
  // TTL -- and so the record carries the volatile fields a hand-built one would leave blank.
  await refreshPullRequest(hangar, clone, branch);

  await reportReadBack(hangar, repo, asked, made, clone.name);
};

/**
 * What Bitbucket answered against what it was asked, and the draft ladder.
 *
 * Everything but `draft` is a warning: a title Bitbucket rewrote is worth knowing about and is
 * fixable on the page. `draft` is not, and that asymmetry is the reason this function exists --
 * a pull request that opened ready for review has already notified its reviewers, and no later
 * edit un-notifies them. So it is asked for a second time through an update, read back again,
 * and only then reported as a failure.
 *
 * **The published schema documents `draft` on the create call, and that is not enough to skip
 * this.** The same schema documents `state` as a query parameter of the pull-request list, where
 * it is silently ignored whenever `q` is present -- measured, and recorded in `bitbucket.ts`. So
 * this API's own specification has been demonstrated to describe a field that does not behave as
 * written, which is the whole argument for reading back what it did rather than trusting what it
 * documents.
 */
const reportReadBack = async (
  hangar: Hangar,
  repo: ReturnType<typeof repoRef>,
  asked: NewPullRequest,
  made: PullRequestDetail,
  clone: string,
): Promise<void> => {
  const off = readBackDisagreements(asked, made);
  for (const said of off) {
    if (said.field === 'draft') continue;
    warn(
      `${clone}: Bitbucket did not take the ${said.field} it was sent (asked ${said.asked}, answered ${said.answered})`,
    );
  }
  if (!off.some((said) => said.field === 'draft')) return;

  warn(
    `${clone}: #${String(made.pr.id)} came back as ${made.pr.draft ? 'a draft' : 'ready for review'} — asking again through an update`,
  );
  const fixed = await setPullRequest(hangar, repo, made.pr.id, {
    title: made.pr.title,
    description: made.description,
    destination: made.pr.destination,
    closeSourceBranch: made.closeSourceBranch,
    reviewerUuids: made.reviewerUuids,
    draft: asked.draft,
  });
  if (fixed.ok && fixed.value.pr.draft === asked.draft) {
    ok(`${clone}: #${String(made.pr.id)} is now ${asked.draft ? 'a draft' : 'ready for review'}`);
    return;
  }
  throw new CliError(
    `${clone}: #${String(made.pr.id)} exists but is ${made.pr.draft ? 'a draft' : 'ready for review'}, not ${asked.draft ? 'a draft' : 'ready for review'}`,
    asked.draft
      ? 'It is open and its reviewers may already have been notified. Mark it a draft on its page, or decline it.'
      : 'Publish it from its page when you are ready.',
  );
};

/**
 * `hangar pr update [clone]` -- rewrite the title, the body, or the draft state.
 *
 * **Only on a pull request the token owner authored.** The API permits rewriting anybody's, so
 * nothing but this check stands between a description refresh and quietly rewriting a colleague's
 * pull request -- which is why a token that cannot say who it belongs to is a refusal rather than
 * a skipped check.
 */
export const prUpdate = async (
  hangar: Hangar,
  ref: string | undefined,
  opts: PrUpdateOptions = {},
): Promise<void> => {
  if (opts.draft === true && opts.ready === true) {
    throw new CliError('--draft and --ready contradict each other');
  }
  const clone = forgeClone(hangar, ref, 'pr update');
  const branch = currentBranch(clone.path);
  const common = prCommonBlock({
    bitbucket: usesBitbucket(hangar.config.forge),
    branch,
    defaultBranch: tryDefaultBranch(hangar),
  });
  if (common !== undefined) throw refuse(clone.name, common);

  const keepTitle = opts.keepTitle === true;
  const keepBody = opts.keepBody === true;
  const wantDraft = opts.draft === true ? true : opts.ready === true ? false : undefined;
  if (keepTitle && keepBody && wantDraft === undefined) {
    throw new CliError(
      `${clone.name}: --keep-title and --keep-body together leave nothing to update`,
      'Drop one of them, or pass --draft/--ready to change only that.',
    );
  }

  const repo = repoRef(hangar, clone.path);
  // `anyState`, so a merged or declined pull request is REPORTED as such rather than as absent:
  // "there is none" would send somebody to `pr create` to open a second one.
  const lookup = await openPullRequests(hangar, repo, branch, { anyState: true });
  if (!lookup.ok) {
    throw new CliError(
      `${clone.name}: could not ask Bitbucket about ${branch}: ${lookup.reason}`,
      'Nothing was changed.',
    );
  }
  const found = pickPullRequest(lookup.pullRequests);
  if (found === undefined) {
    throw new CliError(
      `${clone.name}: ${branch} has no pull request to update`,
      'Open one with `hangar pr create`.',
    );
  }
  if (found.state !== 'open') {
    throw new CliError(
      `${clone.name}: #${String(found.id)} is ${found.state} — there is nothing to rewrite`,
    );
  }

  const me = await tokenOwner(hangar);
  if (!me.ok) {
    throw new CliError(
      `${clone.name}: cannot tell whose pull request #${String(found.id)} is: ${me.reason}`,
      'This command rewrites only your own, so it stops rather than assume. A repository-scoped access token cannot answer this; a personal one can.',
    );
  }
  if (found.author === '' || found.author !== me.value) {
    throw new CliError(
      `${clone.name}: #${String(found.id)} was opened by ${found.authorName === '' ? 'somebody else' : found.authorName}, not by you`,
      'hangar pr update only rewrites pull requests the token owner authored.',
    );
  }

  const detail = await pullRequestDetail(hangar, repo, found.id);
  if (!detail.ok) {
    throw new CliError(
      `${clone.name}: could not read #${String(found.id)} back before rewriting it: ${detail.reason}`,
      'Nothing was changed.',
    );
  }
  const current = detail.value;

  const outcome =
    keepTitle && keepBody ? undefined : await resolveBody(hangar, clone, branch, opts);
  if (outcome?.kind === 'would-regenerate') {
    note(`${clone.name}: would write a description first, then rewrite #${String(found.id)}`);
    note(`  ${describeDescriptionState(outcome.state, tildify(hangar.paths.tmp)).line}`);
    note('(dry run — nothing was written and no run was started)');
    return;
  }
  const text = outcome?.text;

  const edit: PullRequestEdit = {
    title: keepTitle || text === undefined ? current.pr.title : text.title,
    description: keepBody || text === undefined ? current.description : text.body,
    // Carried, never chosen: this is a read-modify-write, and a `PUT` that omitted these would
    // clear them -- reviewers most of all.
    destination: current.pr.destination,
    closeSourceBranch: current.closeSourceBranch,
    reviewerUuids: current.reviewerUuids,
    ...(wantDraft === undefined ? {} : { draft: wantDraft }),
  };

  step(`${clone.name}: rewrite #${String(found.id)} (${branch} → ${current.pr.destination})`);
  note(
    `title:       ${edit.title === current.pr.title ? `${edit.title} (unchanged)` : edit.title}`,
  );
  note(
    `description: ${
      edit.description === current.description
        ? 'unchanged'
        : `${text?.from ?? 'unchanged'} (${bodyLines(edit.description)})`
    }`,
  );
  note(
    `state:       ${
      wantDraft === undefined
        ? `${current.pr.draft ? 'draft' : 'ready for review'} (unchanged)`
        : wantDraft
          ? 'draft'
          : 'ready for review'
    }`,
  );
  if (text !== undefined && !text.trusted) {
    warn(
      'that description file is not named after this branch — the shared tmp/ store is written by every clone, so check the title above is this branch’s',
    );
  }
  if (opts.dryRun === true) {
    note('(dry run — nothing was changed)');
    return;
  }
  if (opts.yes !== true && !confirm(`Rewrite pull request #${String(found.id)}?`)) {
    note('nothing was changed — pass -y (a tool call: `yes: true`) to skip the question');
    return;
  }

  const written = await setPullRequest(hangar, repo, found.id, edit);
  if (!written.ok) {
    throw new CliError(`${clone.name}: Bitbucket refused the update: ${written.reason}`);
  }
  const now = written.value;
  ok(
    `${clone.name}: #${String(now.pr.id)} updated — ${now.pr.draft ? 'draft' : 'ready for review'} → ${now.pr.url}`,
  );
  await refreshPullRequest(hangar, clone, branch);

  if (now.pr.title !== edit.title) {
    warn(`${clone.name}: Bitbucket kept the title as ${now.pr.title}`);
  }
  if (now.description.trim() !== edit.description.trim()) {
    warn(`${clone.name}: Bitbucket did not store the description it was sent`);
  }
  if (wantDraft !== undefined && now.pr.draft !== wantDraft) {
    throw new CliError(
      `${clone.name}: #${String(now.pr.id)} is still ${now.pr.draft ? 'a draft' : 'ready for review'}`,
      'The title and description were saved; only the state was not. Change it on its page.',
    );
  }
};
