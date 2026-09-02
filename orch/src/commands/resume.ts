import { relative } from 'node:path';

import pc from 'picocolors';

import { claudeTranscripts, type ClaudeTranscript } from '../claude-sessions.ts';
import { CliError, run } from '../exec.ts';
import { cloneForCwd, knownClonesHint, requireClone, type Clone } from '../fleet.ts';
import { paint } from '../palette.ts';
import { tildify } from '../paths.ts';
import { canPick, pickOne, type PickChoice } from '../tui.ts';
import { cloneLabel, confirm, heading, note, table, truncate, visibleWidth, warn } from '../ui.ts';

/**
 * `orch-util resume [clone]` -- pick one of a clone's past Claude Code sessions and reopen it.
 *
 * Claude Code has its own `--resume` picker, and this is not a replacement for it but a way
 * around the one thing it cannot do: leave the directory it was started in. Transcripts are
 * keyed to a session's working directory, so `clone_01/angular` sessions are invisible from
 * `clone_01`, and no clone's sessions are visible from the fleet root at all. This command
 * gathers every transcript directory the clone owns, shows what each session was about, and
 * runs `claude --resume` with the right `cd` baked in.
 *
 * The list is a plain single-select (see `tui.ts`): escape leaves without resuming anything.
 * With no tty -- piped, or under another tool -- it prints the same list plus the exact command
 * per session and returns, rather than hanging on a keypress nobody can send.
 */
export type ResumeOptions = {
  limit?: string | undefined;
};

const DEFAULT_LIMIT = 20;
const DETAIL_HEIGHT = 10;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact enough for a column: `4m`, `3h`, `2d`, `5w`. */
const age = (ms: number): string => {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${String(Math.round(delta / MINUTE))}m`;
  if (delta < DAY) return `${String(Math.round(delta / HOUR))}h`;
  if (delta < 14 * DAY) return `${String(Math.round(delta / DAY))}d`;
  return `${String(Math.round(delta / (7 * DAY)))}w`;
};

const pad = (n: number): string => String(n).padStart(2, '0');

const stamp = (date: Date): string =>
  `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** What the session was about, in one line: its own title if it earned one, else its opener. */
const headline = (session: ClaudeTranscript): string =>
  session.title ?? session.firstPrompt ?? '(no summary)';

/**
 * `<age>  <subdirectory>  <what it was about>            <branch>`, with the branch pushed to
 * the right margin so the column reads down the list instead of drifting with each headline.
 *
 * The subdirectory only appears when the session was NOT started at the clone root -- which is
 * the whole reason this command exists, so `angular/` must be visible at a glance rather than
 * only in the detail pane.
 */
const rowFor = (clone: Clone, session: ClaudeTranscript, width: number): string => {
  const when = pc.dim(age(session.modifiedAtMs).padEnd(4));
  const live = session.live ? `${pc.yellow('live')} ` : '';
  const sub = relative(clone.path, session.cwd);
  const where = sub === '' ? '' : pc.dim(`${sub}/ `);
  const branchText = session.branch === undefined ? '' : truncate(session.branch, 34);
  const left = `${when} ${live}${where}`;
  const budget = width - visibleWidth(left) - branchText.length - 2;
  const title = truncate(headline(session), Math.max(16, budget));
  const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(title) - branchText.length);
  return `${left}${title}${' '.repeat(gap)}${pc.dim(branchText)}`;
};

/**
 * Break `text` over at most `lines` lines of `width`, on word boundaries where it can.
 *
 * The hard cut is measured in CODE POINTS, not UTF-16 units: a Jira ticket's emoji or a CJK
 * name sits either side of a `width` that falls between the halves of a surrogate pair, and
 * cutting there prints a replacement character in the middle of the pane.
 */
const wrap = (text: string, width: number, lines: number): string[] => {
  const out: string[] = [];
  let rest = text;
  for (let i = 0; i < lines && rest !== ''; i += 1) {
    const chars = Array.from(rest);
    if (chars.length <= width) {
      out.push(rest);
      break;
    }
    if (i === lines - 1) {
      out.push(truncate(chars.slice(0, width + 1).join(''), width));
      break;
    }
    const space = rest.lastIndexOf(' ', width);
    const at = space > width / 2 ? space : chars.slice(0, width).join('').length;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  return out;
};

const labelled = (label: string, text: string, width: number, lines: number): string[] => {
  const indent = ' '.repeat(label.length);
  return wrap(text, Math.max(20, width - label.length), lines).map(
    (line, i) => `${pc.dim(i === 0 ? label : indent)}${line}`,
  );
};

/**
 * The pane under the list: the two things that say what a session was -- what it was asked
 * first and what it was asked last -- plus what it takes to identify it afterwards.
 */
const detailFor =
  (session: ClaudeTranscript) =>
  (width: number): string[] => {
    const lines: string[] = [
      pc.dim('when    ') +
        (session.startedAt === undefined ? '?' : stamp(session.startedAt)) +
        pc.dim(' → ') +
        stamp(new Date(session.modifiedAtMs)) +
        pc.dim(`  (${(session.bytes / 1e6).toFixed(1)} MB)`),
      `${pc.dim('branch  ')}${session.branch ?? '(unknown)'}`,
      `${pc.dim('in      ')}${tildify(session.cwd)}`,
      `${pc.dim('id      ')}${session.id}`,
      '',
    ];
    if (session.firstPrompt !== undefined)
      lines.push(...labelled('asked   ', session.firstPrompt, width, 3));
    if (session.lastPrompt !== undefined)
      lines.push(...labelled('last    ', session.lastPrompt, width, 2));
    if (session.live) {
      lines.push(pc.yellow('! a claude session is running in that directory — this may be it'));
    }
    return lines;
  };

const choicesFor = (clone: Clone, sessions: readonly ClaudeTranscript[]): PickChoice[] =>
  sessions.map((session) => ({
    row: (width: number) => rowFor(clone, session, width),
    detail: detailFor(session),
  }));

/** No tty: say what there is and exactly how to resume each one, then get out of the way. */
const printList = (clone: Clone, sessions: readonly ClaudeTranscript[]): void => {
  heading(`${cloneLabel(clone)} ${clone.name} — ${String(sessions.length)} resumable sessions`);
  table(
    sessions.map((session) => [
      age(session.modifiedAtMs),
      truncate(headline(session), 60),
      pc.dim(`cd ${tildify(session.cwd)} && claude --resume ${session.id}`),
    ]),
  );
  note('not a terminal, so the picker is not available — copy one of the commands above');
};

const limitOf = (opts: ResumeOptions): number => {
  if (opts.limit === undefined) return DEFAULT_LIMIT;
  // `parseInt` would take `20abc` as 20; a mistyped count should be said out loud.
  const parsed = /^\d+$/.test(opts.limit) ? Number.parseInt(opts.limit, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--limit needs a number, got ${opts.limit}`, '0 shows every session');
  }
  return parsed === 0 ? Number.MAX_SAFE_INTEGER : parsed;
};

const cloneFor = (ref: string | undefined): Clone => {
  if (ref !== undefined) return requireClone(ref);
  const here = cloneForCwd();
  if (here !== undefined) return here;
  throw new CliError(
    'resume needs a clone, and this directory is not inside one',
    knownClonesHint(),
  );
};

export const resume = async (ref: string | undefined, opts: ResumeOptions): Promise<void> => {
  const clone = cloneFor(ref);
  const all = claudeTranscripts(clone);
  if (all.length === 0) {
    warn(`no resumable Claude Code sessions found for ${clone.name}`);
    note('a session shows up here once it has been asked something');
    return;
  }
  const sessions = all.slice(0, limitOf(opts));

  if (!canPick()) {
    printList(clone, sessions);
    return;
  }

  const shown =
    sessions.length === all.length
      ? `${String(all.length)} sessions`
      : `${String(sessions.length)} of ${String(all.length)} sessions`;
  const picked = await pickOne({
    heading: () =>
      `${cloneLabel(clone)} ${paint(clone.colour, clone.name)} ${pc.dim(`· ${shown} · newest first`)}`,
    choices: choicesFor(clone, sessions),
    detailHeight: DETAIL_HEIGHT,
    // The fleet marks a clone with its own coloured bullet everywhere else; a list of one
    // clone's sessions is no place to introduce a second convention.
    marker: paint(clone.colour, '●'),
  });
  if (picked === undefined) {
    note('nothing resumed');
    return;
  }
  const session = sessions[picked];
  if (session === undefined) return;

  // A live session in that directory may BE this one, and resuming it puts two Claude Code
  // sessions in one clone -- the fleet's worst failure. There is no way to ask a running
  // session which transcript it owns, so the developer is asked instead.
  if (
    session.live &&
    !confirm(`A claude session is live in ${tildify(session.cwd)}. Resume anyway?`)
  ) {
    note('nothing resumed');
    return;
  }

  note(`resuming in ${tildify(session.cwd)} — ${headline(session)}`);
  const res = run('claude', ['--resume', session.id], { cwd: session.cwd, inherit: true });
  if (res.code === -1) {
    throw new CliError(
      'could not launch claude',
      'Is the `claude` CLI on your PATH? The session is still there — nothing was changed.',
    );
  }
};
