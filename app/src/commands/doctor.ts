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
import { basename, dirname, join, relative } from 'node:path';

import pc from 'picocolors';

import {
  claudeLocalMdContent,
  effectivePlansDirectory,
  hasJiraHook,
  hasPlansHook,
  hasTmpHook,
  withJiraHook,
  withPlansHook,
  withTmpHook,
  claudeLocalMdPath,
  envLocalContent,
  envLocalPath,
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
  workspacePaths,
  workspaceContent,
  workspacePath,
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
} from '../colour-assignments.ts';
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
  isLinkedIntoStore,
  storeEntries,
  strayPidFilesInStore,
  tmpIsOwnDirectory,
} from '../tmp.ts';
import { paletteEntry } from '../palette.ts';
import { portSummary } from '../ports.ts';
import { terminal, type TerminalCapabilities } from '../terminal/index.ts';
import { installChecks } from '../install.ts';
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

/** Where a symlink actually lands, or undefined if it is not a link or is dangling. */
const resolveLink = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

const symlinkTarget = (path: string): string | undefined => {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
};

const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
};

/**
 * Add one hook to the clone's settings, reading the file again first.
 *
 * All three hook checks are built from ONE `readSettings` at the top of `checksFor`, and
 * `--fix` runs every repair in that same pass -- so a repair rendering that captured object
 * would drop the hook a previous repair had just written. A clone missing two of them is the
 * normal case for a fresh clone, which is exactly when it would go unnoticed.
 */
const addHook =
  (hangar: Hangar, clone: Clone, add: (settings: SettingsJson) => SettingsJson): (() => void) =>
  () => {
    const current = readSettings(clone);
    if (current === undefined) return;
    writeFile(settingsPath(clone), `${JSON.stringify(add(current), null, 2)}\n`);
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
  const loadsShared = envrc.includes('.env.shared') && !envrc.includes('"../.env.shared"');
  // The clone never inherits the fleet root's PATH_add -- direnv loads the nearest .envrc
  // only -- so without this line `hangar` is not callable from inside the clone.
  const hasFleetBin = envrc.split('\n').some((l) => l.trim() === fleetBinPathLine(hangar));
  checks.push({
    name: '.envrc.private',
    ok: loadsShared && hasFleetBin,
    detail:
      loadsShared && hasFleetBin
        ? `loads ${tildify(hangar.paths.envShared)}, puts the fleet bin/ on PATH`
        : [
            loadsShared ? undefined : 'missing, or does not load .env.shared by absolute path',
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
  const wantAllows = healthCheckAllows(clone);
  const themeOk = settings?.theme === wantTheme;
  const allow = settings?.permissions?.allow ?? [];
  const missingAllows = wantAllows.filter((want) => !allow.includes(want));
  const allowOk = missingAllows.length === 0;
  checks.push({
    name: 'settings.local.json',
    ok: settings !== undefined && themeOk && allowOk,
    detail:
      settings === undefined
        ? 'missing or unparseable'
        : [
            themeOk ? undefined : `theme is ${String(settings.theme)}, expected ${wantTheme}`,
            allowOk
              ? undefined
              : `health check missing or aimed elsewhere: ${missingAllows.join('; ')}`,
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
      settings === undefined ? undefined : addHook(hangar, clone, (s) => withPlansHook(hangar, s)),
  });

  const jiraOk = hasJiraHook(hangar, settings);
  checks.push({
    name: 'jira record hook',
    ok: jiraOk,
    detail: jiraOk
      ? 'a ticket fetched in the last hour is served from the shared record store, not re-fetched'
      : 'missing — every `jira-ticket-sync` run re-fetches the ticket and its whole neighbourhood',
    repair:
      settings === undefined ? undefined : addHook(hangar, clone, (s) => withJiraHook(hangar, s)),
  });

  const tmpHookOk = hasTmpHook(hangar, settings);
  checks.push({
    name: 'tmp SessionEnd hook',
    ok: tmpHookOk,
    detail: tmpHookOk
      ? "folds this clone's new Jira cache entries into the shared record store at session end"
      : 'missing — a ticket first fetched here reaches the siblings only when `hangar tmp merge` is run by hand',
    repair:
      settings === undefined ? undefined : addHook(hangar, clone, (s) => withTmpHook(hangar, s)),
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

  // Both copies: VS Code only offers a `*.code-workspace` from the directory you opened, and
  // this repo is opened at its root and at `angular/`. `workspaceContent` is the fallback for
  // a clone that has neither -- `hangar ide vscode sync` is what keeps existing ones in step.
  const wsPaths = workspacePaths(clone);
  const wsMissing = wsPaths.filter((p) => !existsSync(p));
  checks.push({
    name: 'code-workspace',
    ok: wsMissing.length === 0,
    detail:
      wsMissing.length === 0
        ? `${workspacePath(clone).split('/').pop() ?? ''} (root and angular/)`
        : `missing: ${wsMissing.map((p) => relative(clone.path, p)).join(', ')}`,
    repair: () => {
      const template = wsPaths.find((p) => existsSync(p));
      const content =
        template === undefined ? workspaceContent(clone) : readFileSync(template, 'utf8');
      for (const path of wsMissing) writeFile(path, content);
    },
  });

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
 * Is the terminal colour hook sourced from a shell rc, and does any rc name a file that is gone?
 *
 * The second half is the important one, and it is why this check exists at all. The idiomatic way
 * to source an optional file is `[[ -r <path> ]] && source <path>`, which means a RENAMED or
 * DELETED artifact does not produce an error -- the colours simply stop happening, with nothing
 * anywhere to say why. So every path under this hangar's root that an rc mentions is checked for
 * existence, which catches that case generically rather than by knowing any particular old name.
 */
const reportShellHook = (hangar: Hangar): void => {
  const hookName = basename(hangar.paths.terminalHookScript);
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
    if (content.includes(hookName)) sourcing.push(rc);
    // Any path-shaped token; the `startsWith(hangar.root)` filter below is what makes it this
    // hangar's business. It used to match the literal `dvb_gn`, which made the comment above --
    // that this catches a stale path "generically rather than by knowing any particular old
    // name" -- false for every hangar but one.
    for (const match of content.matchAll(/[^\s"'`]*\/[^\s"'`)]*/g)) {
      const named = match[0].replace(/^\$HOME/, home).replace(/^~/, home);
      if (!named.startsWith(hangar.root)) continue;
      if (named === hangar.root || existsSync(named)) continue;
      stale.add(`${rc} → ${tildify(named)}`);
    }
  }

  if (stale.size > 0) {
    warn(`a shell rc sources a file that no longer exists: ${[...stale].join(', ')}`);
    note('Guarded with `[[ -r … ]]`, so this fails SILENTLY — the colours just stop.');
  }
  if (sourcing.length === 0) {
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
const reportEditor = (editor: EditorDriver): void => {
  if (!editor.isAvailable()) {
    warn(`${editor.label} cannot be launched`);
    note(editor.unavailableHint());
    return;
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
const reportDefaultBranch = (recorded: string | undefined, clones: readonly Clone[]): void => {
  if (recorded === undefined) {
    warn('`forge.defaultBranch` is not recorded yet');
    note('The next command that needs it detects it from git and writes the line itself.');
    return;
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
    return;
  }

  const agree = clones.filter((clone) => defaultBranchFromGit(clone.path) === recorded).length;
  ok(
    `${'default branch'.padEnd(22)} ${pc.dim(
      agree === 0
        ? `${recorded} — from the config; no clone has an origin/HEAD to compare with`
        : `${recorded} — origin/HEAD agrees in ${String(agree)} clone(s)`,
    )}`,
  );
};

export const doctor = (hangar: Hangar, ref: string | undefined, opts: DoctorOptions): void => {
  const all = discoverClones(hangar);
  if (!existsSync(hangar.paths.plans)) {
    warn(`the shared plan archive ${tildify(hangar.paths.plans)} does not exist yet`);
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
    warn(
      `${colourAssignmentsLabel(hangar)} assigns a colour to ${orphans
        .map((index) => `index ${String(index)}`)
        .join(', ')}, which no clone has`,
    );
    note('Harmless now; `hangar add-clone` reuses free indices, so it would inherit the hue.');
  }
  /*
   * The config and its schema, checked here for the same reason every other generated
   * artifact is: `hangar.schema.json` is rendered from the zod schema, so an installed tool
   * newer than the file on disk means the editor is validating against yesterday's rules --
   * and unlike a stale theme, nothing about that is visible while you type.
   */
  const configPath = join(hangar.root, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    warn(`no ${CONFIG_FILENAME} in ${tildify(hangar.root)}`);
    note('`hangar setup` writes one, deriving what it can from the clones that already exist.');
  } else {
    const schemaPath = join(hangar.root, jsonSchemaFileName);
    const rendered = configJsonSchemaText();
    if (!existsSync(schemaPath)) {
      warn(`${tildify(schemaPath)} is missing, so editors cannot validate the config`);
      note('`hangar config schema` writes it.');
    } else if (readFileSync(schemaPath, 'utf8') !== rendered) {
      warn(`${tildify(schemaPath)} is out of date`);
      note('`hangar config schema` regenerates it from src/config/schema.ts.');
    }
    try {
      reportDefaultBranch(loadConfigFile(configPath).forge.defaultBranch, all);
    } catch (error) {
      warn(`${tildify(configPath)} does not validate`);
      note(error instanceof CliError ? (error.hint ?? error.message) : String(error));
    }
  }

  const nested = containingHangars(hangar.root);
  if (nested.length > 0) {
    // Nearest-wins makes this WORK, but it is never intentional: every path below the inner
    // root has two defensible answers to "which hangar am I in".
    warn(`this hangar is nested inside ${nested.map((r) => tildify(r)).join(', ')}`);
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
  const { driver, source } = terminal(hangar);
  const can = CAPABILITY_LABELS.filter(([key]) => driver.capabilities[key]).map(
    ([, label]) => label,
  );
  if (driver.kind === 'none') {
    warn(`no terminal automation: ${driver.label}`);
    note(driver.unavailableHint());
  } else {
    ok(`${'terminal'.padEnd(22)} ${pc.dim(`${driver.label} (${source}) — ${can.join(', ')}`)}`);
    if (!driver.capabilities.writeToTty) {
      note(`${driver.label} cannot be typed into, so \`hangar sync\` cannot pause a live session.`);
    }
  }
  reportShellHook(hangar);

  /*
   * The editors, and whether each one can actually be launched.
   *
   * Reported rather than repaired, like the terminal: which IDE is installed is a fact about the
   * machine. Worth a row because the failure is quiet in both directions -- a `code` command that
   * was never installed into PATH, and a JetBrains Toolbox that generated no shell scripts, both
   * mean `hangar open` silently opens no editor at all.
   */
  const editorChoice = editors(hangar);
  for (const bad of editorChoice.broken) {
    warn(`the ${bad.kind} editor driver would not build: ${bad.reason}`);
    note('`hangar open` skips it and still opens the others.');
  }
  for (const editor of editorChoice.drivers) {
    try {
      reportEditor(editor);
    } catch (err) {
      // Same isolation as `open`: an optional editor's probe must not end the health report that
      // the DEFAULT editor's row is in.
      warn(
        `${editor.label} could not be checked: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const strays = strayPidFilesInStore(hangar);
  if (strays.length > 0) {
    warn(`PID files in ${tildify(hangar.paths.tmp)}: ${strays.join(', ')}`);
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
        check.repair();
        warn(`${check.name.padEnd(22)} ${check.detail}`);
        note('repaired');
      } else if (check.repair) {
        fail(`${check.name.padEnd(22)} ${check.detail}`);
        note('fixable with `hangar doctor --fix`');
      } else {
        fail(`${check.name.padEnd(22)} ${check.detail}`);
      }
    }
  }

  console.log('');
  if (problems === 0) note(`No problems in ${targets.length} clone(s).`);
  else if (opts.fix === true) {
    note(`${problems} problem(s) seen; the fixable ones were repaired. Re-run to confirm.`);
    note('A repaired .env.local needs `direnv allow` in that clone; a theme needs a restart.');
  } else note(`${problems} problem(s). Re-run with --fix to repair the derivable ones.`);
};
