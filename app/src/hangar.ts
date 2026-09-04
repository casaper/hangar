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
  /** Fleet-wide secrets, outside every clone so no clone can commit them. */
  readonly envShared: string;
  readonly cloneColoursScript: string;
  readonly terminalHookScript: string;
  readonly colourAssignmentsFile: string;
  /**
   * One statusline script for every clone; it derives the hue from its stdin payload.
   *
   * Still named `dvb-clone-statusline.sh`, which is a hangar-specific name in a user-scoped
   * directory and therefore wrong -- two hangars collide on it. F6 renames it, and it cannot be
   * done here: every clone's `settings.local.json` points `statusLine.command` at the old name,
   * Claude Code fails an unresolvable statusline silently, and the repair has to write the new
   * name beside the old one before anything is rewritten to use it.
   */
  readonly statuslineScript: string;
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
export const pathsFor = (root: string, claudeDir: string): HangarPaths => {
  const tmp = join(root, 'tmp');
  return Object.freeze({
    root,
    configFile: join(root, 'hangar.config.yaml'),
    bin: join(root, 'bin', 'hangar'),
    plans: join(root, 'plans'),
    tmp,
    jiraTickets: join(tmp, 'jira-tickets'),
    envShared: join(root, '.env.shared'),
    cloneColoursScript: join(root, 'clone-colours.sh'),
    terminalHookScript: join(root, 'clone-terminal.sh'),
    colourAssignmentsFile: join(root, 'colour-assignments.json'),
    statuslineScript: join(claudeDir, 'dvb-clone-statusline.sh'),
  });
};
