import { join } from 'node:path';

import type { HangarConfig } from './config/schema.ts';

/**
 * The hangar this invocation acts on, resolved once in `cli.ts` and threaded from there.
 *
 * Everything that used to be a module constant in `paths.ts` hangs off this instead, because a
 * value derived from a root that comes from a FILE cannot be evaluated at import time. That is
 * not a style preference: five such constants in this CLI embedded the root in text that gets
 * written into a live clone, and a wrong absolute path there typechecks, lints, and is invisible
 * until someone opens the file.
 *
 * Threaded rather than held in a module-level singleton, for the reasons Track B recorded:
 *
 * - a singleton breaks this repo's own regression technique, which is to print pure builders
 *   side by side without constructing the state that produces them;
 * - it cannot render two hangars in one process, which `pnpm golden` and `doctor` both want;
 * - and it would put initialisation ORDER between a module's import and its correctness, which
 *   is the failure above, moved rather than fixed.
 *
 * `Clone` carries a back-reference to its hangar, and that is what keeps the seven
 * byte-compared per-clone builders at their existing signatures -- so `doctor`'s comparison and
 * its `--fix` writer, the highest-consequence code here, did not move when this landed.
 */
export type HangarPaths = {
  /** The hangar root itself: the directory holding `hangar.config.yaml` and the clones. */
  readonly root: string;
  readonly configFile: string;
  /** `bin/hangar` -- baked into the clone hooks, which run with an unpredictable PATH. */
  readonly bin: string;
  readonly plans: string;
  readonly tmp: string;
  /**
   * One record per tracker ticket. Deliberately NOT linked into the clones like the other store
   * entries: no skill owns this path, and a symlink in a clone would invite writing into it.
   */
  readonly jiraTickets: string;
  /**
   * Hangar-wide secrets, outside every clone so no clone can commit them.
   *
   * Named by `secrets.file`; `.env.shared` is only the default.
   */
  readonly envShared: string;
  readonly cloneColoursScript: string;
  readonly terminalHookScript: string;
  /**
   * The explicit clone -> colour assignments. INPUT, and the only per-clone value not derived
   * from the index.
   *
   * Under `.hangar/` rather than at the root, because at the root it was TRACKED -- and a
   * tracked file that a hangar command rewrites (`hangar colours change`) is a merge conflict on
   * every `git pull` from a published upstream. Untracking it in place was the wrong move for
   * the opposite reason: nothing regenerates this file, so an untracked one at the root is one
   * `git clean -fdx` from unrecoverable.
   */
  readonly colourAssignmentsFile: string;
  /**
   * Where the file USED to live, read as a fallback and never written.
   *
   * Permanent, not a migration window: a `git pull` into a checkout from before the move
   * restores the tracked root-level file, and the reader still has to find it. `doctor --fix`
   * migrates it forward when both exist.
   */
  readonly legacyColourAssignmentsFile: string;
  /**
   * One statusline script for every clone; it derives the hue from its stdin payload.
   *
   * Named with the hangar id, because it lives in `~/.claude` -- outside the hangar root, where
   * a second hangar would otherwise overwrite it. That is the rule for everything here: what a
   * hangar writes outside its own root carries its id; what it writes inside does not.
   */
  readonly statuslineScript: string;
  /**
   * The shared memory directory every clone of this hangar points `autoMemoryDirectory` at.
   *
   * File-based memory is keyed to the git repository root, and the clones are separate repos, so
   * without this each clone would keep its own -- and a fact learned in one would be invisible in
   * the other three. It is in `~/.claude`, so it carries the id by the same rule the theme files
   * and the statusline do: two hangars on one machine sharing a memory directory would each be
   * reading the other's notes about a different repo.
   *
   * **This hangar's four live clones still name `dvb-gn-memory`**, which predates the rule and is
   * where the fleet's actual memory is. Nothing renames it here: moving live memory is a migration
   * that needs the tracked `.claude/settings.json` and four per-clone files moved with it, plus a
   * session restart each -- and only `defaultSettings` (a hangar with no sibling to copy from)
   * reads this path today, so nothing is split by leaving it.
   */
  readonly memory: string;
};

export type Hangar = {
  readonly root: string;
  readonly id: string;
  readonly config: HangarConfig;
  /** Which discovery mechanism answered: the flag, the upward walk, or `HANGAR_ROOT`. */
  readonly source: 'flag' | 'walk' | 'env';
  readonly paths: HangarPaths;
  /**
   * True when `hangar.config.yaml` exists but would not parse, so `config` holds schema
   * defaults rather than anything the developer wrote.
   *
   * ONE flag in one place, and that is the point of it. This used to be four independent
   * `catch` blocks -- `currentHangarId`, `terminalColourSettings`, `terminal` and `editorConfig`
   * each caught the unparseable case and continued on its own subtree's defaults. Falling back
   * is still right (refusing to paint a terminal over a typo in an unrelated line is worse),
   * but four silent fallbacks meant nothing could tell a wired reader from a swallowed error,
   * and while a hangar's config equals the defaults the two are output-identical.
   *
   * Only the commands that exist to REPORT an invalid config are resolved this way --
   * `doctor`, `config show`, `config validate`. Everything else refuses, because acting on
   * defaults while looking like a configured run is the failure the marker file exists to
   * prevent.
   */
  readonly configFellBack: boolean;
  /** The parse failure, when `configFellBack` -- so a reporting command can print it. */
  readonly configError?: string;
};

/**
 * Every hangar-derived path, frozen.
 *
 * `claudeDir` is passed in rather than imported so this stays a pure function of its arguments:
 * F2 split out the half that needs no hangar, and this is the half that needs no `homedir()`
 * either. Two hangars can therefore be rendered side by side in one process.
 */
export const pathsFor = (
  root: string,
  id: string,
  secretsFile: string,
  claudeDir: string,
): HangarPaths => {
  const tmp = join(root, 'tmp');
  return Object.freeze({
    root,
    configFile: join(root, 'hangar.config.yaml'),
    bin: join(root, 'bin', 'hangar'),
    plans: join(root, 'plans'),
    tmp,
    jiraTickets: join(tmp, 'jira-tickets'),
    envShared: join(root, secretsFile),
    cloneColoursScript: join(root, 'clone-colours.sh'),
    terminalHookScript: join(root, 'clone-terminal.sh'),
    colourAssignmentsFile: join(root, '.hangar', 'colour-assignments.json'),
    legacyColourAssignmentsFile: join(root, 'colour-assignments.json'),
    statuslineScript: join(claudeDir, `${id}-clone-statusline.sh`),
    memory: join(claudeDir, `${id}-memory`),
  });
};
