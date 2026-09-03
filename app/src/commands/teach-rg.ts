import { spawnSync } from 'node:child_process';

import { requireClone } from '../fleet.ts';
import { CliError } from '../exec.ts';
import { claudeSessionsIn } from '../procs.ts';
import { tildify } from '../paths.ts';
import { blank, heading, note, ok, step, warn } from '../ui.ts';
import { confirm } from '../ui.ts';

/**
 * `hangar teach-rg <clone>` -- have Claude Code teach itself to reach for `rg` over `grep`
 * in one clone's own instructions.
 *
 * The point is not that ripgrep is faster in the abstract; it is that an agent reads
 * `CLAUDE.md` and the skills, and whatever those say is what it types for the next year.
 * `rg` respects .gitignore by default, searches in parallel, and takes a real regex dialect
 * -- and a `grep -r` over a repo with four `node_modules` trees is the single most common way
 * an agent wastes a minute and a chunk of its context.
 *
 * The edits land in a clone's TRACKED files, so this is the user's command and never a
 * session's: it refuses while that clone has a live Claude Code session, because two agents
 * editing one file is the failure the SYNC PAUSE protocol exists to prevent, and it runs
 * INTERACTIVELY by default so the diff is reviewed before it is committed.
 */

const SKILL = '/claude-md-management:claude-md-improver';

/** The instruction handed to the clone's own agent. A pure builder, so it can be printed. */
export const teachRgPrompt = (): string =>
  [
    SKILL,
    '',
    'Scope this run to one change only: make ripgrep the default search tool in this',
    "repository's agent instructions.",
    '',
    'Audit CLAUDE.md, AGENTS.md, .claude/skills/**/SKILL.md and .claude/agents/**, and:',
    '',
    '1. Replace instructions that tell an agent to use `grep`, `egrep` or `grep -r` with `rg`,',
    '   keeping each example working -- `rg` needs no `-r`, takes `-n` for line numbers,',
    '   `-i` for case-insensitive, `-l` for names only, `-t<type>` to filter by language and',
    '   `-g <glob>` for paths. `grep -rn X .` becomes `rg -n X`.',
    '2. State the two reasons a reader needs: rg honours .gitignore, so it does not walk',
    '   node_modules, dist or coverage; and its regex dialect supports lookarounds and',
    '   non-greedy quantifiers that BRE/ERE do not.',
    '3. Note where `grep` is still correct: reading a stream a pipe produced, and any',
    '   published script that must run where rg is not installed.',
    '4. Do NOT touch application source, tests, or CI config. Instructions only.',
    '',
    'Report the files you changed and leave them uncommitted for review.',
  ].join('\n');

export type TeachRgOptions = {
  readonly dryRun?: boolean | undefined;
  readonly yes?: boolean | undefined;
};

export const teachRg = (ref: string, opts: TeachRgOptions): void => {
  const clone = requireClone(ref);

  heading(`teach-rg — ${clone.name}`);
  note(`working directory ${tildify(clone.path)}`);

  const sessions = claudeSessionsIn(clone.path);
  if (sessions.length > 0) {
    throw new CliError(
      `${clone.name} has ${String(sessions.length)} live Claude Code session(s)`,
      "This edits that clone's tracked CLAUDE.md and .claude/** files. Close the session first, " +
        'or ask the agent in that clone to run the skill itself.',
    );
  }

  if (opts.dryRun === true) {
    step('would run, in that clone:');
    note(`claude "${SKILL} …"`);
    blank();
    process.stdout.write(`${teachRgPrompt()}\n`);
    return;
  }

  warn('this rewrites tracked files in that clone — review the diff before committing');
  if (opts.yes !== true && !confirm(`Start Claude Code in ${clone.name}?`)) {
    note('nothing done');
    return;
  }

  /*
   * Interactive, with the terminal inherited: a headless run would edit the instructions
   * every future session reads with nobody looking at the diff. The prompt is passed as the
   * first argument so the session opens with it already typed.
   */
  const res = spawnSync('claude', [teachRgPrompt()], { cwd: clone.path, stdio: 'inherit' });
  if (res.error !== undefined) {
    throw new CliError(`could not start claude: ${res.error.message}`, 'Is Claude Code on PATH?');
  }
  blank();
  ok(`session finished in ${clone.name} — check \`git -C ${clone.name} diff\` before committing`);
};
