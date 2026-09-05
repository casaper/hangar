import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import pc from 'picocolors';

import {
  claudeLocalMdContent,
  effectivePlansDirectory,
  hasAnyJiraHook,
  hasJiraHook,
  hasPlansHook,
  hasTmpHook,
  withJiraHook,
  withPlansHook,
  withTmpHook,
  claudeLocalMdPath,
  envLocalContent,
  envLocalPath,
  envrcDotenvLine,
  envrcPrivateContent,
  envrcPrivatePath,
  excludeBlock,
  EXCLUDE_LINES,
  fleetBinPathLine,
  excludePath,
  missingExcludeLines,
  cloneSymlinks,
  readEnvLocalPorts,
  readSettings,
  type SettingsJson,
  settingsContentFor,
  settingsPath,
  healthCheckAllows,
  hangarRootAllow,
  secretsDeny,
  workspacePaths,
  workspaceContent,
  workspacePath,
  wantsWorkspaceFiles,
} from '../clone-config.ts';
import { configJsonSchemaText } from '../config/json-schema.ts';
import {
  CONFIG_FILENAME,
  containingHangars,
  jsonSchemaFileName,
  loadConfigFile,
} from '../config/load.ts';
import {
  colourAssignmentFor,
  colourAssignments,
  colourAssignmentsLabel,
  colourAssignmentsSource,
  migrateColourAssignments,
} from '../colour-assignments.ts';
import { usesBitbucket } from '../bitbucket.ts';
import { editors, type EditorDriver } from '../editor/index.ts';
import { CliError } from '../exec.ts';
import { discoverClones, requireClone, type Clone } from '../fleet.ts';
import { applyArtifact } from '../generate/index.ts';
import { themeArtifact, themeName, themePath } from '../generate/theme-json.ts';
import {
  defaultBranchFromGit,
  FLEET_GIT_CONFIG,
  isGitRepo,
  remotes,
  setFleetGitConfig,
  wrongFleetGitConfig,
} from '../git.ts';

import { home, themesDir, tildify } from '../user-paths.ts';
import { planDirsIn } from '../plans.ts';
import {
  expectedSecretVariables,
  hangarOwnSecretVariables,
  secretVariableProblem,
  secretVariableStatuses,
} from '../secrets.ts';
import {
  isLinkedIntoStore,
  storeEntries,
  strayPidFilesInStore,
  tmpIsOwnDirectory,
} from '../tmp.ts';
import { paletteEntry } from '../palette.ts';
import { portSummary } from '../ports.ts';
import { platform } from '../platform/index.ts';
import { claudeSessionDiagnostic } from '../procs.ts';
import { syncPauseUnsupported, terminal, type TerminalCapabilities } from '../terminal/index.ts';
import {
  hangarClaudeLocalMdContent,
  hangarClaudeLocalMdPath,
  hangarSettingsContent,
  hangarSettingsPath,
} from '../hangar-files.ts';
import { inspectEnvironment, installHint } from '../environment.ts';
import { installChecks } from '../install.ts';
import { secretsFileContent } from './setup.ts';
import { cloneLabel, fail, heading, note, ok, warn } from '../ui.ts';
import type { Hangar } from '../hangar.ts';

/**
 * `hangar doctor` -- the regression net for everything `add-clone` sets up.
 *
 * Every check here corresponds to one artifact that lives OUTSIDE git and therefore cannot
 * be restored by a pull: the per-clone ports, the identity file and the `.git/info/exclude`
 * line that hides it, the shared-secrets hook, the playwright symlink, the theme, and the
 * sibling remotes. A re-clone silently loses all of them.
 *
 * `--fix` rewrites only what is fully derivable from the clone index. It never touches git
 * remotes (a network/name decision) or `tmp/` (it holds live PID files -- `hangar tmp merge`
 * is what shares the cache in it). The fleet's git CONFIG it does set: `checkout.defaultRemote`
 * has one correct value here and is a consequence of those remotes existing.
 */
export type DoctorOptions = { all?: boolean | undefined; fix?: boolean | undefined };

type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** Present when `--fix` can repair this check. */
  readonly repair?: (() => void) | undefined;
  /**
   * Not a pass and not a failure: there is no way to tell from here.
   *
   * `ok` stays true, so it never counts as a problem, but it is rendered dim rather than green
   * -- a row that reads like a verified pass while verifying nothing is worse than saying so.
   * The install steps are the only source of these today: a Maven or Go install leaves nothing
   * inside the clone to look at.
   */
  readonly unverified?: boolean | undefined;
};

const symlinkTarget = (path: string): string | undefined => {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Where a symlink POINTS, which is not the same question as what is at the other end.
 *
 * `realpathSync` first, because it is the only one that resolves a symlinked path COMPONENT --
 * a hangar reached through `/tmp` -> `/private/tmp`, or a clone under a symlinked home. But it
 * throws on a DANGLING link, and that is the normal state of the one link this fleet declares:
 * `repo.symlinks[]` points at the shared secrets file, which does not exist until somebody
 * creates it. So a correct link to an absent file used to answer `undefined` and be reported as
 * the wrong link entirely -- "expected a symlink resolving to <root>/.env.shared, found
 * ../../../.env.shared", of a link that lands exactly there.
 *
 * Worse than the wrong message: the repair below then refused (`exists and is not the expected
 * symlink`), and refusing THROWS, which ended the whole `doctor --all --fix` run at the first
 * clone. Deleting the link and re-running recreated the identical one and reported it broken
 * again -- a closed loop nothing in the output explained, on the last command the README's
 * setup walkthrough tells a new hangar to run.
 *
 * The lexical fallback answers the same question without touching the target, so a link is
 * judged on where it points rather than on whether the file it points at has been filled in yet.
 */
const resolveLink = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    // Not a link at all -> undefined, exactly as before. A dangling one -> where it points.
    const target = symlinkTarget(path);
    return target === undefined ? undefined : resolve(dirname(path), target);
  }
};

const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
};

/**
 * Reconcile one hook with the clone's settings, reading the file again first.
 *
 * All three hook checks are built from ONE `readSettings` at the top of `checksFor`, and
 * `--fix` runs every repair in that same pass -- so a repair rendering that captured object
 * would drop the hook a previous repair had just written. A clone missing two of them is the
 * normal case for a fresh clone, which is exactly when it would go unnoticed.
 *
 * "Reconcile" rather than "add" because `withJiraHook` REMOVES on a hangar that declares no
 * tracker; the plans and tmp hooks are unconditional and so are still pure adds through here.
 */
const reconcileHook =
  (hangar: Hangar, clone: Clone, apply: (settings: SettingsJson) => SettingsJson): (() => void) =>
  () => {
    const current = readSettings(clone);
    if (current === undefined) return;
    writeFile(settingsPath(clone), `${JSON.stringify(apply(current), null, 2)}\n`);
  };

/** `statusLine.command` out of a mode settings file, or undefined if it has none. */
const readModeStatusLine = (path: string): string | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      statusLine?: { command?: unknown };
    };
    const command = parsed.statusLine?.command;
    return typeof command === 'string' ? command : undefined;
  } catch {
    return undefined;
  }
};

const checksFor = (hangar: Hangar, clone: Clone, siblings: readonly Clone[]): Check[] => {
  const checks: Check[] = [];

  checks.push({
    name: 'git repo',
    ok: isGitRepo(clone.path),
    detail: isGitRepo(clone.path) ? clone.path : 'not a git repository',
  });

  // --- ports -------------------------------------------------------------------------
  const actual = readEnvLocalPorts(clone);
  const portProblems = clone.ports.flatMap((entry) => {
    const key = entry.role.envKey;
    const found = actual[key];
    if (found === undefined) return [`${key} missing`];
    return found === entry.port
      ? []
      : [`${key}=${String(found)}, formula says ${String(entry.port)}`];
  });
  checks.push({
    name: '.env.local ports',
    ok: portProblems.length === 0,
    detail: portProblems.length === 0 ? portSummary(clone.ports) : portProblems.join('; '),
    repair: () => {
      writeFile(envLocalPath(clone), envLocalContent(clone));
    },
  });

  // --- shared secrets ----------------------------------------------------------------
  const envrc = existsSync(envrcPrivatePath(clone))
    ? readFileSync(envrcPrivatePath(clone), 'utf8')
    : '';
  /*
   * Two PREDICATES rather than a byte-compare, and the exception is deliberate: this file is
   * hand-editable in a way the other generated ones are not -- a developer may legitimately add
   * a `PATH_add` or a `use flake` line of their own, and a byte-compare would call that drift and
   * `--fix` would delete it. What must be true is that it loads the secrets and puts the hangar's
   * `bin/` on PATH; everything else is theirs.
   *
   * The load is checked against the CONFIGURED secrets path, not the literal `.env.shared`. That
   * literal made this check permanently red in any hangar whose `secrets.file` is named anything
   * else -- and red for a file that was in fact correct, which is worse than no check. It is
   * matched as the exact line the generator writes, which is also what rules out the relative
   * form the old `!envrc.includes('"../.env.shared"')` clause was there to catch: a relative
   * target resolves against a subdirectory, where `dotenv_if_exists` finds nothing and says
   * nothing.
   */
  const wantDotenv = envrcDotenvLine(hangar);
  const loadsShared = envrc.split('\n').some((l) => l.trim() === wantDotenv);
  // The clone never inherits the hangar root's PATH_add -- direnv loads the nearest .envrc
  // only -- so without this line `hangar` is not callable from inside the clone.
  const hasFleetBin = envrc.split('\n').some((l) => l.trim() === fleetBinPathLine(hangar));
  checks.push({
    name: '.envrc.private',
    ok: loadsShared && hasFleetBin,
    detail:
      loadsShared && hasFleetBin
        ? `loads ${tildify(hangar.paths.envShared)}, puts the fleet bin/ on PATH`
        : [
            loadsShared
              ? undefined
              : `missing, or does not load ${tildify(hangar.paths.envShared)} by absolute path`,
            hasFleetBin ? undefined : 'does not put the fleet bin/ on PATH (no hangar here)',
          ]
            .filter((x) => x !== undefined)
            .join('; '),
    repair: () => {
      writeFile(envrcPrivatePath(clone), envrcPrivateContent(hangar));
    },
  });

  /*
   * One check per configured symlink, from `repo.symlinks[]`.
   *
   * The link may be written relative or absolute -- what matters is where it LANDS, so compare
   * resolved paths rather than raw targets. Each entry's `why` is what the failure prints: this
   * fleet's one link exists because the tracked `tests/.env` sets USER_READWRITE_PASSWORD empty
   * and direnv loads it after `.envrc.private`, and nothing in the filesystem says so.
   */
  for (const link of cloneSymlinks(clone)) {
    const dirMissing = !existsSync(dirname(link.path));
    if (dirMissing && link.skipIfDirMissing) continue;
    const target = symlinkTarget(link.path);
    const resolves = target !== undefined && resolveLink(link.path) === link.target;
    checks.push({
      name: link.relPath,
      ok: resolves,
      detail: resolves
        ? `symlink -> ${tildify(link.target)}`
        : `expected a symlink resolving to ${tildify(link.target)}, found ${target ?? 'no symlink'} — ${link.why}`,
      repair: dirMissing
        ? undefined
        : () => {
            if (existsSync(link.path) || target !== undefined) {
              throw new CliError(
                `${tildify(link.path)} exists and is not the expected symlink`,
                'Inspect and remove it by hand, then re-run `hangar doctor --fix`.',
              );
            }
            symlinkSync(relative(dirname(link.path), link.target), link.path);
          },
    });
  }

  /*
   * --- install steps ------------------------------------------------------------------
   *
   * DECLARATION ONLY. Nothing here spawns a package manager, and the reason is worth stating
   * where someone might be tempted to "make doctor actually check it": `npm ci` deletes
   * `node_modules` outright, so a doctor that ran the step list would wipe every clone's
   * install -- with their dev servers running -- every time somebody asked whether the fleet
   * was healthy. Running an install is `hangar install <clone>`, which a human types.
   */
  for (const item of installChecks(clone)) {
    checks.push({
      name: item.name,
      ok: item.ok,
      detail: item.detail,
      unverified: item.unverifiable,
    });
  }

  // --- identity ----------------------------------------------------------------------
  // Content, not just existence. This file is generated, says so, and tells its reader not to
  // hand-edit it -- so an exact comparison is the right test rather than an over-strict one.
  // Existence alone was the check for a while, and three clones spent that while telling their
  // sessions the fleet had three clones, and the fourth one four. A generated file whose
  // content rots unnoticed is precisely what this command exists to catch.
  const identityPath = claudeLocalMdPath(clone);
  const wantIdentity = claudeLocalMdContent(clone);
  const identity = existsSync(identityPath) ? readFileSync(identityPath, 'utf8') : undefined;
  checks.push({
    name: 'CLAUDE.local.md',
    ok: identity === wantIdentity,
    detail:
      identity === undefined
        ? 'missing — the session will not know which clone it is in'
        : identity === wantIdentity
          ? `${identity.split('\n').length - 1} lines, as generated`
          : 'differs from what the generator produces — stale, or hand-edited; --fix rewrites it',
    repair: () => {
      writeFile(identityPath, wantIdentity);
    },
  });

  const exclude = existsSync(excludePath(clone)) ? readFileSync(excludePath(clone), 'utf8') : '';
  const missingExcludes = missingExcludeLines(exclude);
  const excluded = missingExcludes.length === 0;
  checks.push({
    name: '.git/info/exclude',
    ok: excluded,
    detail: excluded
      ? `hides ${EXCLUDE_LINES.join(', ')}`
      : `missing ${missingExcludes.join(', ')} — untracked noise that eventually gets committed`,
    repair: () => {
      writeFile(excludePath(clone), exclude + excludeBlock(hangar));
    },
  });

  // --- Claude Code settings ----------------------------------------------------------
  const settings = readSettings(clone);
  const wantTheme = `custom:${themeName(clone)}`;

  /*
   * Does the theme this clone NAMES actually resolve, and does its statusline command exist?
   *
   * The check below this one compares `theme` against the name the generator would produce,
   * which correctly goes red after a rename. Neither of them used to assert that the target is
   * on disk -- and that is the failure Claude Code SWALLOWS: an unresolvable theme silently
   * falls back to the default, so the whole fleet goes identically coloured, which is the exact
   * thing the colours exist to prevent, and it surfaces at the next session start rather than
   * now. Same for a `statusLine.command` pointing at a path that is not there: the status line
   * just stops.
   *
   * Read off the settings file rather than from the generator, so a hand-edited value is caught
   * too. There is no repair: the file naming a missing artifact is a different problem from the
   * artifact being absent, and `colours sync` is what writes artifacts.
   */
  const namedTheme = typeof settings?.theme === 'string' ? settings.theme : undefined;
  const namedThemeFile =
    namedTheme?.startsWith('custom:') === true
      ? join(themesDir, `${namedTheme.slice('custom:'.length)}.json`)
      : undefined;
  const statusCommand = (settings?.['statusLine'] as { command?: unknown } | undefined)?.command;
  const statusPath = typeof statusCommand === 'string' ? statusCommand.split(' ')[0] : undefined;
  const unresolved = [
    namedThemeFile !== undefined && !existsSync(namedThemeFile)
      ? `theme ${namedTheme ?? ''} → ${tildify(namedThemeFile)}`
      : undefined,
    statusPath !== undefined && !existsSync(statusPath)
      ? `statusLine → ${tildify(statusPath)}`
      : undefined,
  ].filter((x) => x !== undefined);
  checks.push({
    name: 'settings targets',
    ok: unresolved.length === 0,
    detail:
      unresolved.length === 0
        ? 'the theme and statusline it names are both on disk'
        : `${unresolved.join('; ')} — Claude Code fails both SILENTLY; run \`hangar colours sync\``,
  });
  /*
   * The DERIVED half of the settings file, all of it -- not just the two keys that used to be
   * checked here.
   *
   * `theme` and the health-check allows were held; `statusLine`, `autoMemoryDirectory`, the
   * hangar-root read allow and the shared-secrets deny were not, and the check above only asks
   * whether the statusline PATH exists. That combination is green for a fleet whose clones name
   * a previous hangar id: after `<id>-clone-…` replaced `dvb-clone-…` here, four clones went on
   * pointing at `~/.claude/dvb-clone-statusline.sh` (still on disk, so the existence check
   * passed) and `~/.claude/dvb-gn-memory`, which quietly split the fleet's ONE shared memory
   * directory in two while this command reported no problems at all.
   *
   * The deny is the one with teeth. It is an absolute path at the secrets file, and it sits
   * beside an allow for `Read(<hangar root>/**)` -- so a hangar whose root or `secrets.file`
   * moved leaves every clone denying a path that is not there any more and allowing a read of
   * the one that is. There is no reason for that to be discovered later than the rename.
   *
   * All of it repairs through the existing hook below: `settingsContentFor` now reapplies the
   * derived half over the file's own personal half, so widening the builder widened `--fix`.
   */
  const wantAllows = healthCheckAllows(clone);
  const themeOk = settings?.theme === wantTheme;
  const allow = settings?.permissions?.allow ?? [];
  const missingAllows = wantAllows.filter((want) => !allow.includes(want));
  const allowOk = missingAllows.length === 0;
  const wantStatus = clone.hangar.paths.statuslineScript;
  const rawStatus = (settings?.['statusLine'] as { command?: unknown } | undefined)?.command;
  const haveStatus = typeof rawStatus === 'string' ? rawStatus : undefined;
  const statusOk = haveStatus === wantStatus;
  const wantMemory = clone.hangar.paths.memory;
  const rawMemory = settings?.['autoMemoryDirectory'];
  const haveMemory = typeof rawMemory === 'string' ? rawMemory : undefined;
  const memoryOk = haveMemory === wantMemory;
  const wantRootAllow = hangarRootAllow(clone.hangar);
  const rootAllowOk = allow.includes(wantRootAllow);
  const wantDeny = secretsDeny(clone.hangar);
  const denyOk = (settings?.permissions?.deny ?? []).includes(wantDeny);
  checks.push({
    name: 'settings.local.json',
    ok:
      settings !== undefined && themeOk && allowOk && statusOk && memoryOk && rootAllowOk && denyOk,
    detail:
      settings === undefined
        ? 'missing or unparseable'
        : [
            themeOk ? undefined : `theme is ${String(settings.theme)}, expected ${wantTheme}`,
            allowOk
              ? undefined
              : `health check missing or aimed elsewhere: ${missingAllows.join('; ')}`,
            statusOk
              ? undefined
              : `statusLine is ${haveStatus === undefined ? 'unset' : tildify(haveStatus)}, expected ${tildify(wantStatus)}`,
            memoryOk
              ? undefined
              : `autoMemoryDirectory is ${haveMemory === undefined ? 'unset' : tildify(haveMemory)}, expected ${tildify(wantMemory)} — this clone's memory is not the fleet's`,
            rootAllowOk ? undefined : `no read allow for the hangar root (${wantRootAllow})`,
            denyOk
              ? undefined
              : `the shared secrets are not denied (${wantDeny}) — and ${wantRootAllow} would reach them`,
          ]
            .filter((x) => x !== undefined)
            .join('; ') || `${wantTheme}, ${String(wantAllows.length)} health check(s)`,
    repair:
      settings === undefined
        ? undefined
        : () => {
            writeFile(settingsPath(clone), settingsContentFor(clone, settings));
          },
  });

  // Where this clone's plans land. `plansDirectory` MUST resolve inside the clone: Claude Code
  // resolves it against the project root and rejects anything that escapes, symlinks followed,
  // then falls back to ~/.claude/plans with only a debug-level log. So the value stays
  // `.claude/plans` (from the repo's own tracked settings) and the SessionEnd hook below is
  // what gets the finished plans into the shared archive.
  const plans = effectivePlansDirectory(clone);
  checks.push({
    name: 'plansDirectory',
    ok: plans.resolved !== undefined,
    detail:
      plans.value === undefined
        ? 'unset — plans land in ~/.claude/plans, shared with every other project on this machine'
        : plans.resolved === undefined
          ? `${plans.value} resolves outside the clone — Claude Code REJECTS that and silently uses ~/.claude/plans instead`
          : `${plans.value}${readSettings(clone)?.plansDirectory === undefined ? ' (from the repo settings)' : ''}`,
    repair:
      plans.resolved === undefined && settings !== undefined
        ? () => {
            writeFile(
              settingsPath(clone),
              `${JSON.stringify({ ...settings, plansDirectory: PLANS_DIRECTORY }, null, 2)}\n`,
            );
          }
        : undefined,
  });

  const hookOk = hasPlansHook(hangar, settings);
  checks.push({
    name: 'plans SessionEnd hook',
    ok: hookOk,
    detail: hookOk
      ? "collects this clone's finished plans into the shared archive"
      : 'missing — a finished plan stays in this clone until `hangar plans collect` is run by hand',
    repair:
      settings === undefined
        ? undefined
        : reconcileHook(hangar, clone, (s) => withPlansHook(hangar, s)),
  });

  /*
   * The tracker hook is the one check whose CORRECT answer depends on the config, so the row
   * asks the opposite question on a hangar that declares no tracker: not "is it wired" but "is
   * it gone". Both directions repair through the same `withJiraHook`, which reconciles.
   *
   * The two predicates are not interchangeable here. Enabled, the question is whether to
   * rewrite, so exact equality is right -- a drifted command should be rewritten. Disabled, the
   * question is whether to remove, and `withJiraHook` removes by `invokesOurCli`; asking exact
   * equality would report "correctly absent" about a stale hook the repair then deletes.
   */
  const trackerOff = hangar.config.tracker.kind === 'none';
  const jiraOk = trackerOff ? !hasAnyJiraHook(hangar, settings) : hasJiraHook(hangar, settings);
  checks.push({
    name: 'jira record hook',
    ok: jiraOk,
    detail: trackerOff
      ? jiraOk
        ? 'correctly absent — this hangar declares no tracker'
        : 'wired, but this hangar declares `tracker.kind: none` — it serves nothing and starts a process on every Bash call'
      : jiraOk
        ? 'a ticket fetched in the last hour is served from the shared record store, not re-fetched'
        : 'missing — every `jira-ticket-sync` run re-fetches the ticket and its whole neighbourhood',
    repair:
      settings === undefined
        ? undefined
        : reconcileHook(hangar, clone, (s) => withJiraHook(hangar, s)),
  });

  const tmpHookOk = hasTmpHook(hangar, settings);
  checks.push({
    name: 'tmp SessionEnd hook',
    ok: tmpHookOk,
    // Not "Jira cache entries": this hook shares every `tmp/` entry, and naming only the
    // tracker's promised a hangar with no tracker something it would never get.
    detail: tmpHookOk
      ? "folds this clone's new `tmp/` entries into the shared store at session end"
      : 'missing — anything first written here reaches the siblings only when `hangar tmp merge` is run by hand',
    repair:
      settings === undefined
        ? undefined
        : reconcileHook(hangar, clone, (s) => withTmpHook(hangar, s)),
  });

  const strayPlanDirs = planDirsIn(clone).filter(
    (dir) => dir !== join(clone.path, '.claude', 'plans'),
  );
  if (strayPlanDirs.length > 0) {
    checks.push({
      name: 'stray plan dirs',
      ok: false,
      detail: `${strayPlanDirs.map((d) => relative(clone.path, d)).join(', ')} — a session started in a subdirectory resolved the project root there; \`hangar plans collect\` picks these up too`,
    });
  }

  const theme = themeArtifact(clone);
  const themeCurrent = existsSync(theme.path) ? readFileSync(theme.path, 'utf8') : undefined;
  checks.push({
    name: 'theme json',
    ok: themeCurrent === theme.content,
    detail:
      themeCurrent === undefined
        ? `missing ${tildify(themePath(clone))}`
        : themeCurrent === theme.content
          ? tildify(themePath(clone))
          : 'differs from the generated theme',
    repair: () => {
      applyArtifact(theme, false);
    },
  });

  // --- fleet wiring ------------------------------------------------------------------
  const mine = remotes(clone.path);
  const missingOut = siblings
    .filter((s) => s.index !== clone.index && !mine.has(s.name))
    .map((s) => s.name);
  const missingIn = siblings
    .filter((s) => s.index !== clone.index && !remotes(s.path).has(clone.name))
    .map((s) => s.name);
  checks.push({
    name: 'sibling remotes',
    ok: missingOut.length === 0 && missingIn.length === 0,
    detail:
      missingOut.length === 0 && missingIn.length === 0
        ? `${siblings.length - 1} sibling(s), both directions`
        : [
            missingOut.length > 0 ? `not a remote here: ${missingOut.join(', ')}` : undefined,
            missingIn.length > 0
              ? `this clone missing as a remote in: ${missingIn.join(', ')}`
              : undefined,
          ]
            .filter((x) => x !== undefined)
            .join('; '),
  });

  // The config those remotes make necessary. It lives in `.git/config`, so a re-clone loses
  // it exactly like the rest of this list -- and its absence shows up as `git checkout
  // <branch>` refusing an unambiguous-looking branch name, which reads like a git problem
  // rather than a missing fleet setting.
  const wrongConfig = wrongFleetGitConfig(clone.path);
  checks.push({
    name: 'git config',
    ok: wrongConfig.length === 0,
    detail:
      wrongConfig.length === 0
        ? FLEET_GIT_CONFIG.map(([key, value]) => `${key}=${value}`).join(', ')
        : wrongConfig.map(({ key, want, is }) => `${key} is ${is}, want ${want}`).join('; '),
    repair: () => {
      setFleetGitConfig(clone.path);
    },
  });

  // The clone's OWN directory is the thing to check. Its PID files live there, so a `tmp` that
  // is a symlink means they are the fleet's -- one clone's dev server blocking the others and a
  // `pids.mjs --kill` reaching a sibling. How much of the store it links is NOT a check: a
  // ticket fetched here reaches the others at the next `tmp merge`, which is inherent to
  // linking per entry, and a check that is red in normal operation is a check nobody reads.
  const ownTmp = tmpIsOwnDirectory(clone);
  const linked = storeEntries(hangar).filter((name) => isLinkedIntoStore(clone, name)).length;
  checks.push({
    name: 'tmp/ is its own',
    ok: ownTmp,
    detail: ownTmp
      ? `a real directory; ${String(linked)} of ${String(storeEntries(hangar).length)} shared entries linked into it`
      : `a symlink to ${tildify(hangar.paths.tmp)} — its PID files are the whole fleet's; run \`hangar tmp merge\``,
  });

  /*
   * Both copies: VS Code only offers a `*.code-workspace` from the directory you opened, and
   * this repo is opened at its root and at `angular/`. `workspaceContent` is the fallback for
   * a clone that has neither -- `hangar ide vscode sync` is what keeps existing ones in step.
   *
   * **No row at all when no configured editor reads one**, rather than a green "not applicable":
   * the `editor` row below already says what Hangar does per configured editor, and this check
   * was unconditional -- so a hangar declaring `kinds: ['jetbrains']` was told a VS Code file was
   * missing, and `--fix` created it. That is worse than a stale row, because the repair is what
   * put the file there.
   *
   * A workspace file left behind by a hangar that USED to list VS Code is deliberately left
   * alone and unreported. The tracker hook went the other way -- `doctor` removes a stale one --
   * and the difference is the cost: a stale hook starts a process on every Bash tool call, while
   * a stale workspace file is an inert gitignored file that nothing reads.
   */
  if (wantsWorkspaceFiles(hangar)) {
    const wsPaths = workspacePaths(clone);
    const wsMissing = wsPaths.filter((p) => !existsSync(p));
    checks.push({
      name: 'code-workspace',
      ok: wsMissing.length === 0,
      detail:
        wsMissing.length === 0
          ? `${workspacePath(clone).split('/').pop() ?? ''} (${workspacePaths(clone)
              .map((path) => relative(clone.path, dirname(path)) || 'root')
              .join(' and ')})`
          : `missing: ${wsMissing.map((p) => relative(clone.path, p)).join(', ')}`,
      repair: () => {
        const template = wsPaths.find((p) => existsSync(p));
        const content =
          template === undefined ? workspaceContent(clone) : readFileSync(template, 'utf8');
        for (const path of wsMissing) writeFile(path, content);
      },
    });
  }

  // Two clones one colour, however it happened: the palette wrapped (more clones than hues) or
  // someone forced an assignment onto a hue a sibling already had. Either way the hue has
  // stopped being an identity, which is the only thing it is for.
  const sameHue = siblings.filter(
    (other) => other.index !== clone.index && other.colour.name === clone.colour.name,
  );
  if (sameHue.length > 0) {
    checks.push({
      name: 'colour',
      ok: false,
      detail: clone.colour.reused
        ? `the palette has wrapped — ${clone.colour.name} is also ${sameHue.map((c) => c.name).join(', ')}. Add a hue to src/palette.ts.`
        : `${clone.colour.name} is also ${sameHue.map((c) => c.name).join(', ')} — recolour one with \`hangar colours change\``,
    });
  }

  // An assignment naming a hue that is not in the palette: `colourFor` falls back to the
  // formula, so the file looks edited and changes nothing. A hand-edit typo, always.
  const assigned = colourAssignmentFor(hangar, clone.index);
  if (assigned !== undefined && paletteEntry(assigned) === undefined) {
    checks.push({
      name: 'colour assignment',
      ok: false,
      detail: `${colourAssignmentsLabel(hangar)} assigns "${assigned}" to index ${String(clone.index)}, which is not a palette colour — it is being ignored, ${clone.colour.name} comes from the index formula`,
    });
  }

  return checks;
};

/** Relative on purpose -- see the plansDirectory check. */
const PLANS_DIRECTORY = '.claude/plans';

/**
 * The capability names as `doctor` prints them: short, and in the order they matter.
 *
 * `paint` is last because it is the odd one out -- it is true only for the driver that CANNOT be
 * coloured from the shell, so it reads as a capability while really marking a limitation.
 */
const CAPABILITY_LABELS = [
  ['openTabs', 'tabs'],
  ['inspect', 'list'],
  ['tag', 'tag'],
  ['writeToTty', 'type'],
  ['select', 'select'],
  ['paintOnCreate', 'paint'],
] as const satisfies readonly (readonly [keyof TerminalCapabilities, string])[];

/** The rc files a login or interactive shell reads, in the order a developer would edit them. */
const SHELL_RC_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'] as const;

/**
 * The two home-relative forms a shell rc writes, resolved to an absolute path.
 *
 * One function, because the positive and the stale halves of `reportShellHook` both need it and
 * two copies written separately is how they came to disagree in the first place.
 */
const expandHome = (token: string): string => token.replace(/^\$HOME/, home).replace(/^~/, home);

/**
 * The platform row: what this operating system can do for Hangar, and what it refuses BY NAME.
 *
 * Printed on every OS, including the one it was written on. A row that only appeared when
 * something was wrong would be a row nobody had ever seen working, which is how this CLI ended
 * up shipping three macOS-only paths in the first place -- none of them failed loudly anywhere,
 * because nowhere else ever ran them.
 *
 * The session line is the important half and is a DIAGNOSTIC, not a pass: it says how many rows
 * `ps` returned and how many the Claude Code matcher accepted. Zero matched on a machine with
 * `claude` running is the Linux failure this fleet cannot test for -- see
 * `claudeSessionDiagnostic` -- and it is indistinguishable from an idle machine unless the row
 * prints both numbers.
 */
const reportPlatform = (): void => {
  const os = platform();
  const caps = [
    os.capabilities.openExternally ? 'open externally' : undefined,
    os.capabilities.openApplicationByName ? 'name an application' : undefined,
    os.capabilities.vscodeWindowState ? 'VS Code window state' : undefined,
  ].filter((c) => c !== undefined);
  ok(
    `${'platform'.padEnd(22)} ${pc.dim(`${os.label} — ${caps.length === 0 ? 'no desktop integration' : caps.join(', ')}`)}`,
  );
  if (!os.capabilities.vscodeWindowState) {
    note(
      'Hangar does not know where a VS Code-family editor keeps its window state here, so ' +
        '`hangar open` cannot tell that a clone’s workspace is ALREADY open and may open a ' +
        'second window on it.',
    );
  }
  if (!os.capabilities.openApplicationByName) {
    note(
      'An application cannot be addressed by display name here, so a JetBrains install with no ' +
        'launcher on PATH has nothing to fall back to. Generate the shell scripts from Toolbox.',
    );
  }

  const seen = claudeSessionDiagnostic();
  const label = 'claude sessions'.padEnd(22);
  if (!seen.psOk) {
    warn(`${label} \`ps\` failed, so no live session can be detected`);
    note(
      '`hangar sync --all` cannot skip a busy clone and cannot deliver `SYNC PAUSE`; it will ' +
        'ask before touching each clone instead.',
    );
    return;
  }
  ok(
    `${label} ${pc.dim(`${String(seen.matched)} found (${String(seen.withCwd)} located) in ${String(seen.rows)} processes`)}`,
  );
  if (seen.matched === 0 && seen.nearMisses.length > 0) {
    // The one line that answers the open Linux question. `argv[0]` is `claude` on macOS; if
    // procps reports something else, that something else is standing right here.
    warn(
      `no process has \`claude\` as argv[0], but ${String(seen.nearMisses.length)} command name(s) ` +
        `mention it: ${seen.nearMisses.join(', ')}`,
    );
    note(
      'If a Claude Code session IS running, this is the detector missing it — every busy-clone ' +
        'skip and the whole `SYNC PAUSE` protocol are off. Report the command names above.',
    );
  }
  if (seen.matched > seen.withCwd) {
    note(
      `${String(seen.matched - seen.withCwd)} session(s) have no working directory — \`lsof\` ` +
        'could not read them, so they belong to no clone as far as `sync` is concerned.',
    );
  }
};

/**
 * Is the terminal colour hook sourced from a shell rc, and does any rc name a file that is gone?
 *
 * The second half is the important one, and it is why this check exists at all. The idiomatic way
 * to source an optional file is `[[ -r <path> ]] && source <path>`, which means a RENAMED or
 * DELETED artifact does not produce an error -- the colours simply stop happening, with nothing
 * anywhere to say why. So every path under this hangar's root that an rc mentions is checked for
 * existence, which catches that case generically rather than by knowing any particular old name.
 *
 * **Both halves match on the RESOLVED PATH, and the positive one used to match on the BASENAME.**
 * `clone-terminal.sh` is written inside the hangar root, so by this CLI's naming rule it carries
 * no hangar id -- which makes that name byte-identical in every hangar on the machine. A second
 * hangar therefore reported `terminal hook sourced from .zshrc` on the strength of the FIRST
 * hangar's line, and its own colours silently did nothing. The stale-path half was already
 * scoped with `startsWith(hangar.root)`; this makes the two agree, through one normalisation
 * rather than two written separately -- an rc that sources the hook as `$HOME/code/.../` has to
 * match, and that is the exact form the note below tells people to add.
 */
const reportShellHook = (hangar: Hangar): number => {
  const hookPath = hangar.paths.terminalHookScript;
  const hookName = basename(hookPath);
  const sourcing: string[] = [];
  // A set: the idiomatic guard names the same path twice on one line (`[ -r X ] && . X`), and
  // reporting it twice would read as two separate problems.
  const stale = new Set<string>();

  for (const rc of SHELL_RC_FILES) {
    const path = join(home, rc);
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    // Any path-shaped token; the `startsWith(hangar.root)` filter is what makes it this hangar's
    // business. It used to match the literal `dvb_gn`, which made the comment above -- that this
    // catches a stale path "generically rather than by knowing any particular old name" -- false
    // for every hangar but one.
    let sourced = false;
    for (const match of content.matchAll(/[^\s"'`]*\/[^\s"'`)]*/g)) {
      const named = expandHome(match[0]);
      if (named === hookPath) sourced = true;
      if (!named.startsWith(hangar.root)) continue;
      if (named === hangar.root || existsSync(named)) continue;
      stale.add(`${rc} → ${tildify(named)}`);
    }
    if (sourced) sourcing.push(rc);
  }

  let problems = 0;
  if (stale.size > 0) {
    problems += 1;
    warn(`a shell rc sources a file that no longer exists: ${[...stale].join(', ')}`);
    note('Guarded with `[[ -r … ]]`, so this fails SILENTLY — the colours just stop.');
  }
  if (sourcing.length === 0) {
    problems += 1;
    warn(`no shell rc sources ${hookName}, so no shell colours itself per clone`);
    // `$HOME`, not `~`: a tilde inside double quotes is not expanded, so the `~/…` form
    // `tildify` produces would be a line that silently never matches.
    const quotable = hangar.paths.terminalHookScript.startsWith(home)
      ? `$HOME${hangar.paths.terminalHookScript.slice(home.length)}`
      : hangar.paths.terminalHookScript;
    note(`Add to ~/.zshrc (or ~/.bashrc):  [ -r "${quotable}" ] && . "${quotable}"`);
  } else {
    ok(`${'terminal hook'.padEnd(22)} ${pc.dim(`sourced from ${sourcing.join(', ')}`)}`);
  }
  return problems;
};

/**
 * The machine's required tooling -- one row, and it speaks up only about what is missing.
 *
 * `inspectEnvironment` had exactly ONE caller, `hangar setup`. But README's fastest way into a
 * fleet somebody has already configured is "copy the example config and stop", which never runs
 * `setup` -- so the check that README introduces with "hangar setup checks all of this for you"
 * never ran for the people it was written for. They met the missing tool later, as whatever it
 * broke: no `lsof` is indistinguishable from an idle machine, because zero live sessions is what
 * both look like.
 *
 * `doctor` is the command someone runs when something is wrong, and the machine's tooling is a
 * thing that can be wrong, so it belongs here. Unlike `setup` it never throws -- `doctor` reports
 * -- and unlike `setup` it prints ONE green line when everything is present rather than a row per
 * tool. A dozen green rows on every run is a wall people learn to scroll past, and the recommended
 * tools stay out of here entirely: `setup` is where you are choosing what to install.
 */
const reportEnvironmentRow = (hangar: Hangar): number => {
  const report = inspectEnvironment(hangar.root);
  if (report.missingRequired.length === 0) {
    const count = report.statuses.filter((s) => s.tool.kind === 'required').length + 1;
    ok(`${'tooling'.padEnd(22)} ${pc.dim(`${String(count)} required programs present`)}`);
    return 0;
  }
  warn(`missing required tooling: ${report.missingRequired.join(', ')}`);
  for (const { tool, present } of report.statuses) {
    if (present || tool.kind !== 'required') continue;
    note(`${tool.name.padEnd(18)} ${tool.why}\n  ${installHint(tool)}`);
  }
  if (report.nodeManager.found === undefined) {
    note(
      `${'fnm or nvm'.padEnd(18)} resolves the .nvmrc Node version per directory\n  brew install fnm`,
    );
  }
  if (report.homebrew.needed && !report.homebrew.present) {
    note(
      `${'homebrew'.padEnd(18)} the GNU userland and every install hint on macOS\n  https://brew.sh`,
    );
  }
  note('`hangar setup` prints the same list with the recommended tools, and refuses to continue.');
  return 1;
};

/**
 * `secrets.variables[]` against what the shared secrets file actually sets.
 *
 * A HANGAR-level row, not a per-clone one: there is one secrets file for the whole fleet, so
 * four clones would print the same lines four times.
 *
 * Reported and never repaired, because there is nothing to repair. A credential cannot be
 * derived from the clone index the way a port can, which makes this the one gap in the fleet
 * that `doctor --fix` structurally cannot close -- and so the one most worth naming out loud.
 * Declared and unset is a warning; declared `optional: true` and unset is dim, because a hangar
 * whose owner never runs the Playwright suite should not have a permanently red `doctor`: a
 * check that is red in normal operation is a check nobody reads.
 *
 * A hangar that declares nothing gets NO row at all. Silence beats "0 variables declared" for
 * the majority of hangars that never fill this in, and the empty default is legal.
 */
const reportSecretVariables = (hangar: Hangar, fix: boolean): number => {
  const expected = expectedSecretVariables(
    hangarOwnSecretVariables({
      forgeKind: usesBitbucket(hangar.config.forge) ? 'bitbucketCloud' : 'none',
      forgeTokenEnvKey: hangar.config.forge.tokenEnvKey,
      trackerKind: hangar.config.tracker.kind,
    }),
    hangar.config.secrets.variables,
  );
  if (expected.length === 0) return 0;

  const path = hangar.paths.envShared;

  /*
   * The FILE, before its contents -- and `--fix` creates it.
   *
   * `setup` was the only thing that had ever written this file, and README's fastest way into a
   * fleet somebody else has already configured is "copy the example config and stop", which never
   * runs `setup`. Running it afterwards answers "already exists and is valid" and stops, so there
   * was no route back to the one file every credential lives in. Each clone's `.envrc.private`
   * loads it with `dotenv_if_exists`, so an absent one loads NOTHING and says NOTHING -- the
   * silent-failure shape the hangar's own guidance warns about by name, reached by omission.
   *
   * Creating it is not deriving a credential, which is why this is a legal repair where filling
   * it in never will be: what gets written is the same commented-out scaffold `setup` writes,
   * every line inert. `{ mode: 0o600 }` on the create rather than a following `chmod`, because
   * between the two syscalls a world-readable file is sitting where credentials are about to go.
   */
  let problems = 0;
  let justCreated = false;
  if (!existsSync(path)) {
    if (fix) {
      writeFileSync(path, secretsFileContent(expected), { mode: 0o600, flag: 'wx' });
      justCreated = true;
      ok(`created ${tildify(path)} (mode 600) — every line commented out`);
    } else {
      problems += 1;
      warn(`the shared secrets file ${tildify(path)} does not exist`);
      note(
        '`hangar doctor --fix` creates it, commented out. Every clone loads it with ' +
          '`dotenv_if_exists`, so an absent one loads nothing and reports nothing.',
      );
    }
  }

  // A read failure is the same answer as an absent file -- `secretVariableStatuses` takes
  // `undefined` for both. The file is mode 600, so EACCES here is real rather than theoretical.
  let text: string | undefined;
  try {
    text = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch {
    text = undefined;
  }

  const statuses = secretVariableStatuses(expected, text);
  const unset = statuses.filter((s) => s.state !== 'set');
  if (unset.length === 0) {
    ok(`${'secrets'.padEnd(22)} ${pc.dim(`${String(expected.length)} expected, all set`)}`);
    return problems;
  }
  for (const s of unset) {
    const problem = secretVariableProblem(s);
    if (problem === undefined) continue;
    // The dim `optional:` rows are notes, not problems, and stay out of the count for the same
    // reason they are dim: a hangar whose owner never syncs must not be permanently non-zero.
    if (s.optional) note(pc.dim(`optional: ${problem}`));
    else {
      problems += 1;
      warn(problem);
    }
  }
  // A run that just created the file would otherwise report it created and then report every
  // variable absent, which reads as two contradictory findings rather than one expected state.
  note(
    justCreated
      ? `That scaffold is what is now unset: uncomment and fill in ${tildify(path)}.`
      : `Fill them in at ${tildify(path)}; nothing derives a credential, so \`--fix\` cannot.`,
  );
  return problems;
};

/**
 * One editor's row: whether it can be launched, and what Hangar does for it.
 *
 * The two facts worth printing are the two that differ between these editors, and both are the
 * editor's doing rather than Hangar's: who works out which window already has the clone open,
 * and whether there is a project setup to keep in step at all. Terminal vim has neither -- it is
 * a tab, not a window -- and Xcode and Eclipse are launch-only, so saying `$PROJECT_DIR$` of
 * them (as this row once did) described a mechanism they do not have.
 */
const reportEditor = (editor: EditorDriver, clones: readonly Clone[]): number => {
  if (!editor.isAvailable()) {
    warn(`${editor.label} cannot be launched`);
    note(editor.unavailableHint());
    return 1;
  }
  let problems = 0;
  /*
   * A `rootKeys` table with no file in any clone to apply it to.
   *
   * `editor.rootPathKeys` is the config half of the only per-clone TEXT transform in this CLI:
   * a handful of VS Code settings hold an absolute path into the checkout, and each clone's copy
   * has to name its own root. But the file those keys live in -- `.vscode/settings.json` -- is
   * untracked and personal, so a fresh fleet has none of it, and `ide vscode sync` answers "no
   * clone has this file, nothing to sync" and stops. The keys are then INERT: correctly
   * declared, describing a rewrite of a file that does not exist.
   *
   * That is what a colleague copying a committed example config gets. The config reads
   * configured, `ide vscode sync` reads healthy, `doctor`'s editor row is green -- and their
   * VS Code resolves stylelint, prettier and jest against nothing. Every other symptom of it
   * shows up inside the editor, where nothing connects it back to the fleet.
   *
   * Gated on the table being DECLARED, exactly as the secrets row is gated on a variable being
   * declared: a hangar with no such keys gets no row, and this one goes quiet the moment one
   * clone has the file. Nothing to repair -- the contents are the developer's, and inventing
   * them is what `defaultSettings` splits derived from personal to avoid.
   */
  // No clones is not "no clone has it": there is nothing to be inert yet, and `add-clone` writes
  // the workspace file itself. Without this guard a hangar before its first clone reported every
  // untracked artifact as inert, including the one it was about to create.
  for (const artifact of clones.length === 0 ? [] : editor.artifacts) {
    if (artifact.tracked || Object.keys(artifact.rootKeys).length === 0) continue;
    if (clones.some((clone) => artifact.copies(clone).some((path) => existsSync(path)))) continue;
    problems += 1;
    warn(
      `${artifact.id} is in no clone, so ${editor.label}'s ${String(Object.keys(artifact.rootKeys).length)} per-clone path setting(s) are inert`,
    );
    note(
      `Set them up in one clone, then \`hangar ide ${editor.kind} sync\` gives every other clone ` +
        'the same file with its own root. Nothing generates it: the contents are yours.',
    );
  }
  const how =
    editor.capabilities.inTerminalTab === true
      ? 'a terminal tab'
      : editor.capabilities.focusExisting
        ? 'focus-existing'
        : 'self-deduping';
  const setup = !editor.capabilities.syncArtifacts
    ? 'launch only'
    : editor.capabilities.rewritesRootPaths
      ? 'sync, per-clone paths'
      : 'sync';
  ok(`${'editor'.padEnd(22)} ${pc.dim(`${editor.label} — ${how}, ${setup}`)}`);
  return problems;
};

/**
 * `forge.defaultBranch` against what the clones' own `origin/HEAD` says.
 *
 * The config value is detected once and trusted afterwards -- that is the whole point of having
 * it, and the price is that a repo which RENAMES its default branch leaves the hangar
 * confidently wrong, with every command agreeing. This is the row that notices.
 *
 * Local refs only, never a network call: `doctor` has to work on a train, and a check that
 * sometimes hangs for twenty seconds is a check people stop running.
 *
 * A WARNING with no repair, deliberately. Which of the two is right is genuinely unknown here:
 * `origin/HEAD` is a local symref that git writes at clone time and then never updates, so a
 * clone predating the rename keeps the old answer for good and the config may well be the newer
 * one. Naming both and letting the developer decide is the honest report.
 */
const reportDefaultBranch = (recorded: string | undefined, clones: readonly Clone[]): number => {
  if (recorded === undefined) {
    warn('`forge.defaultBranch` is not recorded yet');
    note('The next command that needs it detects it from git and writes the line itself.');
    return 1;
  }

  const disagree = clones
    .map((clone) => ({ clone, branch: defaultBranchFromGit(clone.path) }))
    .filter((seen) => seen.branch !== undefined && seen.branch !== recorded);
  if (disagree.length > 0) {
    warn(
      `${CONFIG_FILENAME} says the default branch is ${recorded}, but ${disagree
        .map((seen) => `${seen.clone.name} says ${String(seen.branch)}`)
        .join(', ')}`,
    );
    note(
      `Edit \`forge.defaultBranch\` if the repo renamed it, or refresh a stale clone ` +
        `(\`git -C <clone> remote set-head origin --auto\`). Every command trusts the config.`,
    );
    return 1;
  }

  const agree = clones.filter((clone) => defaultBranchFromGit(clone.path) === recorded).length;
  ok(
    `${'default branch'.padEnd(22)} ${pc.dim(
      agree === 0
        ? `${recorded} — from the config; no clone has an origin/HEAD to compare with`
        : `${recorded} — origin/HEAD agrees in ${String(agree)} clone(s)`,
    )}`,
  );
  return 0;
};

export const doctor = (hangar: Hangar, ref: string | undefined, opts: DoctorOptions): void => {
  const all = discoverClones(hangar);
  /*
   * The hangar-level tally, and the line it draws.
   *
   * `problems` used to count only the per-clone checks, so a fresh hangar printed five warnings
   * about its identity file, its settings, its mode statuslines and its secrets and then said
   * `No problems in 0 clone(s).` -- a summary contradicting the report immediately above it,
   * which is worse than no summary at all.
   *
   * `problem()` counts; a bare `warn()` does not, and the difference is whether anyone can ACT
   * on it. Everything about this hangar's own state counts, including the one-time manual steps
   * (`.claude/modes/*.settings.json`) that `--fix` deliberately will not close: those go to zero
   * once somebody does them, which is exactly what a setup check should drive. What stays out is
   * the machine's CAPABILITIES -- a `ps` that will not run, a terminal that cannot be typed
   * into. Those are facts about where the fleet is running, permanent on some platforms, and
   * counting them would leave a correctly configured GNOME Terminal hangar permanently non-zero:
   * a check that is red in normal operation is a check nobody reads.
   *
   * The EXIT CODE stays 0 either way, and that is this CLI's convention rather than an
   * oversight: a `--check` flag is the gate (`config schema --check` and `colours sync --check`
   * both exit 1), and a report is a report. `doctor` has no `--check`.
   */
  let hangarProblems = 0;
  const problem = (message: string): void => {
    hangarProblems += 1;
    warn(message);
  };

  if (!existsSync(hangar.paths.plans)) {
    problem(`the shared plan archive ${tildify(hangar.paths.plans)} does not exist yet`);
    note("`hangar plans collect` creates it and gathers the clones' plans into it.");
  }
  // Assignments left behind by a clone that no longer exists. Harmless until `add-clone`
  // reuses the index -- `nextFreeIndex(hangar)` fills gaps -- and then it silently hands a brand-new
  // clone the old one's hue. `add-clone` and `remove-clone` both drop it; this catches a
  // directory removed by hand.
  const orphans = [...colourAssignments(hangar).keys()].filter(
    (index) => !all.some((clone) => clone.index === index),
  );
  if (orphans.length > 0) {
    problem(
      `${colourAssignmentsLabel(hangar)} assigns a colour to ${orphans
        .map((index) => `index ${String(index)}`)
        .join(', ')}, which no clone has`,
    );
    note('Harmless now; `hangar add-clone` reuses free indices, so it would inherit the hue.');
  }
  /*
   * The hangar root's own `.claude/settings.json`, by CONTENT, like every generated artifact.
   *
   * It was tracked with `/Users/someone` in two of its three values, so on any other machine the
   * memory directory pointed at nothing and the status line's command was not there -- and
   * Claude Code fails both SILENTLY. No error, no log; the mode badge simply never appears. That
   * is the failure this hangar could never observe, because here the paths happen to be right.
   */
  /*
   * The hangar's own `CLAUDE.local.md`, by CONTENT -- the ninth byte-compared builder.
   *
   * Same convention as the per-clone identity file, and for the same reason: it reaches every
   * clone session through the ancestor walk, so a stale one tells four sessions the wrong ports
   * or the wrong repo, and there is no other check on it. Improving the text is one edit plus
   * `doctor --fix`.
   */
  const identityFile = hangarClaudeLocalMdPath(hangar.root);
  const wantIdentity = hangarClaudeLocalMdContent(hangar);
  const haveIdentity = existsSync(identityFile) ? readFileSync(identityFile, 'utf8') : undefined;
  if (haveIdentity !== wantIdentity) {
    if (opts.fix === true) {
      writeFile(identityFile, wantIdentity);
      ok(`wrote ${tildify(identityFile)}`);
    } else {
      problem(
        haveIdentity === undefined
          ? `${tildify(identityFile)} is missing — every clone session loses this hangar's identity`
          : `${tildify(identityFile)} differs from what the generator produces`,
      );
      note('`hangar doctor --fix` writes it. It reaches every clone session at its next start.');
    }
  }

  const settingsFile = hangarSettingsPath(hangar.root);
  const wantHangarSettings = hangarSettingsContent(hangar.root, hangar.paths.memory);
  const haveHangarSettings = existsSync(settingsFile)
    ? readFileSync(settingsFile, 'utf8')
    : undefined;
  if (haveHangarSettings !== wantHangarSettings) {
    if (opts.fix === true) {
      writeFile(settingsFile, wantHangarSettings);
      ok(`wrote ${tildify(settingsFile)}`);
      note('A fleet-root session reads it at startup, so this one is still on the old values.');
    } else {
      problem(
        haveHangarSettings === undefined
          ? `${tildify(settingsFile)} is missing — no shared memory, no plan archive, no mode badge`
          : `${tildify(settingsFile)} differs from what the generator produces`,
      );
      note('`hangar doctor --fix` writes it. Claude Code fails silently on all three values.');
    }
  }

  /*
   * The two mode settings files, REPORTED and never repaired.
   *
   * Their `statusLine.command` is an absolute path into this hangar, so a fresh clone of a
   * published hangar repo carries the previous owner's -- and Claude Code fails silently on it,
   * exactly like an unresolvable theme: the mode badge simply never appears, and a session with
   * no badge is a session whose permission rules nobody can see at a glance.
   *
   * There is deliberately NO `--fix`, and this is the one check where that is a security
   * property rather than a limitation. `ops.settings.json`'s ~40 `allow`/`ask`/`deny` entries ARE
   * operator mode's boundary; operator mode is denied `Edit(./.claude/modes/**)` and allowed
   * `Bash(hangar doctor:*)`, so a repair that rewrote that file would let operator mode edit its
   * own permission list through a command it is permitted to run. `setup` does not write them
   * either, for the same reason. Editing one line in two tracked files is the manual step, and it
   * is named here.
   *
   * The cost of that decision falls on whoever clones a published hangar, and it is worth saying
   * out loud rather than leaving them to discover it: the two files are TRACKED, so the hand edit
   * shows as a permanent modification and conflicts on every `git pull` that touches them -- and
   * they are the files carrying operator mode's permission list, so those are conflicts nobody
   * should resolve carelessly. That is the price of the boundary being structural. What this row
   * can do is stop making them read prose and work out the edit: it prints the `sed` that makes
   * it, so the manual step is one paste rather than one decision.
   */
  for (const mode of ['ops', 'dev'] as const) {
    const path = join(hangar.root, '.claude', 'modes', `${mode}.settings.json`);
    if (!existsSync(path)) continue;
    const command = readModeStatusLine(path);
    const script = command?.split(' ')[0];
    if (script !== undefined && existsSync(script) && script.startsWith(hangar.root)) continue;
    problem(
      `${tildify(path)}: statusLine.command ${
        script === undefined ? 'is missing' : `→ ${tildify(script)} does not resolve in this hangar`
      }`,
    );
    const want = `${join(hangar.root, '.claude', 'modes', 'statusline.sh')} ${mode}`;
    note(`Set statusLine.command to: ${want}`);
    /*
     * A `sed` rather than a repair: `--fix` must never write this file (operator mode can run
     * `doctor` and this file is what constrains it), but nothing stops us handing over the exact
     * edit. `|` as the delimiter, because the value is a path.
     *
     * Written to a temp file and moved, NOT `sed -i`. In-place editing is the one sed flag the
     * GNU and BSD versions spell incompatibly (`-i` versus `-i ''`), and this hangar's own
     * `.envrc` puts GNU sed ahead of BSD on macOS -- so the obvious `sed -i ''` form is correct
     * in a plain terminal and silently wrong inside the hangar, where it reads the script as a
     * filename. This line is going to be pasted into a shell nobody here can see.
     */
    note(`  sed 's|"command": ".*statusline.sh.*"|"command": "${want}"|' ${path} > ${path}.tmp \\`);
    note(`    && mv ${path}.tmp ${path}`);
    note(
      "Not repairable on purpose: that file is operator mode's permission boundary. It is also " +
        'tracked, so this edit stays modified in `git status` and conflicts on a pull.',
    );
  }

  /*
   * The colour assignments, if they are still at the old tracked root-level path.
   *
   * Not a silent auto-migration: the file is operator INPUT that nothing regenerates, so the
   * move gets reported and, with `--fix`, done byte for byte -- never reserialised, because a
   * hand-edited `_` note or an assignment this version does not understand would be dropped on
   * the way. Reading it from either place is permanent, so an un-migrated hangar is correct,
   * just still conflicting on every pull.
   */
  const assignments = colourAssignmentsSource(hangar);
  if (assignments?.legacy === true) {
    if (opts.fix === true) {
      const moved = migrateColourAssignments(hangar);
      if (moved !== undefined) {
        ok(`moved ${tildify(moved.from)} -> ${tildify(moved.to)}`);
        note('`git rm --cached colour-assignments.json` finishes it: the old path was tracked.');
      }
    } else {
      problem(`${tildify(assignments.path)} is at the old root-level path`);
      note(
        '`hangar doctor --fix` moves it under .hangar/. Tracked there, it conflicts on every pull.',
      );
    }
  }

  /*
   * The config and its schema, checked here for the same reason every other generated
   * artifact is: `hangar.schema.json` is rendered from the zod schema, so an installed tool
   * newer than the file on disk means the editor is validating against yesterday's rules --
   * and unlike a stale theme, nothing about that is visible while you type.
   */
  const configPath = join(hangar.root, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    problem(`no ${CONFIG_FILENAME} in ${tildify(hangar.root)}`);
    note('`hangar setup` writes one, deriving what it can from the clones that already exist.');
  } else {
    const schemaPath = join(hangar.root, jsonSchemaFileName);
    const rendered = configJsonSchemaText();
    if (!existsSync(schemaPath)) {
      problem(`${tildify(schemaPath)} is missing, so editors cannot validate the config`);
      note('`hangar config schema` writes it.');
    } else if (readFileSync(schemaPath, 'utf8') !== rendered) {
      problem(`${tildify(schemaPath)} is out of date`);
      note('`hangar config schema` regenerates it from src/config/schema.ts.');
    }
    try {
      hangarProblems += reportDefaultBranch(loadConfigFile(configPath).forge.defaultBranch, all);
    } catch (error) {
      problem(`${tildify(configPath)} does not validate`);
      note(error instanceof CliError ? (error.hint ?? error.message) : String(error));
    }
  }

  const nested = containingHangars(hangar.root);
  if (nested.length > 0) {
    // Nearest-wins makes this WORK, but it is never intentional: every path below the inner
    // root has two defensible answers to "which hangar am I in".
    problem(`this hangar is nested inside ${nested.map((r) => tildify(r)).join(', ')}`);
    note('Move it out, or merge the two configs. `hangar setup` refuses to create a nested one.');
  }

  /*
   * The terminal, and whether the colour hook is actually reaching a shell.
   *
   * Reported rather than repaired: which emulator to drive is a fact about the machine, and the
   * one place Hangar cannot write is the developer's shell rc. Both halves are worth a row --
   * a detected driver with no `type` capability silently changes what `sync` can do, and a hook
   * nobody sources is a colour scheme that quietly does not exist.
   */
  reportPlatform();
  hangarProblems += reportEnvironmentRow(hangar);
  hangarProblems += reportSecretVariables(hangar, opts.fix === true);

  const { driver, source } = terminal(hangar);
  const can = CAPABILITY_LABELS.filter(([key]) => driver.capabilities[key]).map(
    ([, label]) => label,
  );
  if (driver.kind === 'none') {
    warn(`no terminal automation: ${driver.label}`);
    note(driver.unavailableHint());
  } else {
    ok(`${'terminal'.padEnd(22)} ${pc.dim(`${driver.label} (${source}) — ${can.join(', ')}`)}`);
  }
  if (!driver.capabilities.writeToTty) {
    // Named, not noted: see `syncPauseUnsupported`. A permanent limitation printed as a passing
    // capability record is the silent degradation this whole section exists to end.
    const refusal = syncPauseUnsupported(driver);
    warn(refusal.message);
    if (refusal.hint !== undefined) note(refusal.hint);
  }
  hangarProblems += reportShellHook(hangar);

  /*
   * The editors, and whether each one can actually be launched.
   *
   * Reported rather than repaired, like the terminal: which IDE is installed is a fact about the
   * machine. Worth a row because the failure is quiet in both directions -- a `code` command that
   * was never installed into PATH, and a JetBrains Toolbox that generated no shell scripts, both
   * mean `hangar open` silently opens no editor at all.
   */
  const editorChoice = editors(hangar);
  /*
   * Say when the rows below are the FALLBACK's editors rather than this hangar's.
   *
   * With a config that will not parse, `editor.kinds` resolves to the schema default -- so a
   * hangar configured `kinds: ['jetbrains']` printed a green `editor  VS Code — …` row naming
   * an editor its own config does not list, seven lines under the warning that says the config
   * does not validate, with nothing connecting the two. That is the exact case `editor/index.ts`
   * warns about ("VS Code opened at it and no hint as to why"), and `doctor` is where the hint
   * belongs: it is the command you run when something is wrong, and it was the one confirming
   * the wrong answer.
   */
  if (editorChoice.fellBack) {
    // `warn`, not `problem`: the fault itself -- a config that does not parse -- is already a
    // counted problem above, and counting it twice would put a number on the footer that no
    // amount of repair can bring down. What this adds is PLACE: the same fact, next to the rows
    // it makes untrustworthy.
    warn('the editor row(s) below are the DEFAULT, not this hangar’s — the config did not parse');
    note('`hangar config validate` says what is wrong; until it does, `hangar open` uses these.');
  }
  for (const bad of editorChoice.broken) {
    problem(`the ${bad.kind} editor driver would not build: ${bad.reason}`);
    note('`hangar open` skips it and still opens the others.');
  }
  for (const editor of editorChoice.drivers) {
    try {
      hangarProblems += reportEditor(editor, all);
    } catch (err) {
      // Same isolation as `open`: an optional editor's probe must not end the health report that
      // the DEFAULT editor's row is in.
      problem(
        `${editor.label} could not be checked: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const strays = strayPidFilesInStore(hangar);
  if (strays.length > 0) {
    problem(`PID files in ${tildify(hangar.paths.tmp)}: ${strays.join(', ')}`);
    note(
      'The store holds shared cache only; PID files are never moved into it. These were written ' +
        'by a clone whose whole tmp/ was the store, and they belong to no clone in particular.',
    );
  }
  const targets = opts.all === true || ref === undefined ? all : [requireClone(hangar, ref)];
  let problems = 0;

  for (const clone of targets) {
    heading(cloneLabel(clone));
    for (const check of checksFor(hangar, clone, all)) {
      if (check.ok) {
        if (check.unverified === true) note(`${check.name.padEnd(22)} ${check.detail}`);
        else ok(`${check.name.padEnd(22)} ${pc.dim(check.detail)}`);
        continue;
      }
      problems += 1;
      if (opts.fix === true && check.repair) {
        /*
         * One repair that throws must not end the fleet run.
         *
         * This was a bare call, inside two loops -- per check, per clone -- so the first repair
         * that refused took every LATER check in that clone and every later CLONE with it. The
         * symlink repair refuses by design when something unexpected is already at the path, and
         * it fired on every clone of a hangar whose secrets file did not exist yet: `--fix`
         * printed one error and stopped, with the ports, hooks, remotes and theme of three other
         * clones silently unvisited and nothing saying they had been skipped.
         *
         * A refusal is information about ONE artifact. Report it where that artifact's row would
         * have been and carry on -- `--fix` is the pass people run without reading, so the one
         * thing it must not do is quietly do less than it says.
         */
        try {
          check.repair();
          warn(`${check.name.padEnd(22)} ${check.detail}`);
          note('repaired');
        } catch (error) {
          fail(`${check.name.padEnd(22)} ${check.detail}`);
          note(
            `could not repair: ${error instanceof CliError ? (error.hint ?? error.message) : String(error)}`,
          );
        }
      } else if (check.repair) {
        fail(`${check.name.padEnd(22)} ${check.detail}`);
        note('fixable with `hangar doctor --fix`');
      } else {
        fail(`${check.name.padEnd(22)} ${check.detail}`);
      }
    }
  }

  console.log('');
  const total = hangarProblems + problems;
  // The two halves are named separately because they are fixed in different places: a clone
  // problem is almost always derivable, and a hangar one is as often a decision (a credential to
  // paste, one line in a tracked settings file) that `--fix` will never close.
  const where =
    hangarProblems === 0
      ? `in ${String(targets.length)} clone(s)`
      : problems === 0
        ? 'above the clones'
        : `${String(hangarProblems)} above the clones, ${String(problems)} in ${String(targets.length)} clone(s)`;
  if (total === 0) note(`No problems in ${String(targets.length)} clone(s).`);
  else if (opts.fix === true) {
    note(`${String(total)} problem(s) seen (${where}); the fixable ones were repaired.`);
    note('A repaired .env.local needs `direnv allow` in that clone; a theme needs a restart.');
  } else {
    note(`${String(total)} problem(s) (${where}). Re-run with --fix to repair the derivable ones.`);
  }
};
