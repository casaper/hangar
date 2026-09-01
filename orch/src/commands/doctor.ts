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
import { dirname, join, relative } from 'node:path';

import pc from 'picocolors';

import {
  claudeLocalMdContent,
  claudeLocalMdPath,
  envLocalContent,
  envLocalPath,
  envrcPrivateContent,
  envrcPrivatePath,
  EXCLUDE_BLOCK,
  FLEET_BIN_PATH_LINE,
  EXCLUDE_LINE,
  excludePath,
  playwrightEnvLocalPath,
  readEnvLocalPorts,
  readSettings,
  settingsContentFor,
  settingsPath,
  storybookHealthCheckAllow,
  workspaceContent,
  workspacePath,
} from '../clone-config.ts';
import { CliError } from '../exec.ts';
import { discoverClones, findClone, type Clone } from '../fleet.ts';
import { applyArtifact } from '../generate/index.ts';
import { themeArtifact, themeName, themePath } from '../generate/theme-json.ts';
import { isGitRepo, remotes } from '../git.ts';
import { envShared, tildify } from '../paths.ts';
import { PORT_ROLES, PORT_ROLE_ORDER } from '../ports.ts';
import { cloneLabel, fail, heading, note, ok, warn } from '../ui.ts';

/**
 * `orch-util doctor` -- the regression net for everything `add-clone` sets up.
 *
 * Every check here corresponds to one artifact that lives OUTSIDE git and therefore cannot
 * be restored by a pull: the per-clone ports, the identity file and the `.git/info/exclude`
 * line that hides it, the shared-secrets hook, the playwright symlink, the theme, and the
 * sibling remotes. A re-clone silently loses all of them.
 *
 * `--fix` rewrites only what is fully derivable from the clone index. It never touches git
 * remotes (a network/name decision) or `tmp/` (it holds live PID files).
 */
export type DoctorOptions = { all?: boolean | undefined; fix?: boolean | undefined };

type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** Present when `--fix` can repair this check. */
  readonly repair?: (() => void) | undefined;
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

const checksFor = (clone: Clone, siblings: readonly Clone[]): Check[] => {
  const checks: Check[] = [];

  checks.push({
    name: 'git repo',
    ok: isGitRepo(clone.path),
    detail: isGitRepo(clone.path) ? clone.path : 'not a git repository',
  });

  // --- ports -------------------------------------------------------------------------
  const actual = readEnvLocalPorts(clone);
  const portProblems = PORT_ROLE_ORDER.flatMap((role) => {
    const key = PORT_ROLES[role].envKey;
    const found = actual[key];
    if (found === undefined) return [`${key} missing`];
    return found === clone.ports[role]
      ? []
      : [`${key}=${found}, formula says ${clone.ports[role]}`];
  });
  checks.push({
    name: '.env.local ports',
    ok: portProblems.length === 0,
    detail:
      portProblems.length === 0
        ? `${clone.ports.ng} / ${clone.ports.storybook} / ${clone.ports.playwrightReport}`
        : portProblems.join('; '),
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
  // only -- so without this line `orch-util` is not callable from inside the clone.
  const hasFleetBin = envrc.split('\n').some((l) => l.trim() === FLEET_BIN_PATH_LINE());
  checks.push({
    name: '.envrc.private',
    ok: loadsShared && hasFleetBin,
    detail:
      loadsShared && hasFleetBin
        ? `loads ${tildify(envShared)}, puts the fleet bin/ on PATH`
        : [
            loadsShared ? undefined : 'missing, or does not load .env.shared by absolute path',
            hasFleetBin ? undefined : 'does not put the fleet bin/ on PATH (no orch-util here)',
          ]
            .filter((x) => x !== undefined)
            .join('; '),
    repair: () => {
      writeFile(envrcPrivatePath(clone), envrcPrivateContent());
    },
  });

  // The link may be written relative or absolute -- what matters is where it lands, so
  // compare resolved paths rather than the raw target.
  const pwPath = playwrightEnvLocalPath(clone);
  const pwTarget = symlinkTarget(pwPath);
  const pwResolves = pwTarget !== undefined && resolveLink(pwPath) === envShared;
  checks.push({
    name: 'playwright .env.local',
    ok: pwResolves,
    detail: pwResolves
      ? `symlink -> ${tildify(envShared)}`
      : `expected a symlink resolving to ${tildify(envShared)}, found ${pwTarget ?? 'no symlink'} — the tracked .env sets USER_READWRITE_PASSWORD empty and would win without it`,
    repair: existsSync(dirname(pwPath))
      ? () => {
          if (existsSync(pwPath) || pwTarget !== undefined) {
            throw new CliError(
              `${tildify(pwPath)} exists and is not the expected symlink`,
              'Inspect and remove it by hand, then re-run `orch-util doctor --fix`.',
            );
          }
          symlinkSync(relative(dirname(pwPath), envShared), pwPath);
        }
      : undefined,
  });

  // --- identity ----------------------------------------------------------------------
  const identityExists = existsSync(claudeLocalMdPath(clone));
  checks.push({
    name: 'CLAUDE.local.md',
    ok: identityExists,
    detail: identityExists ? 'present' : 'missing — the session will not know which clone it is in',
    repair: () => {
      writeFile(claudeLocalMdPath(clone), claudeLocalMdContent(clone, siblings));
    },
  });

  const exclude = existsSync(excludePath(clone)) ? readFileSync(excludePath(clone), 'utf8') : '';
  const excluded = exclude.split('\n').some((l) => l.trim() === EXCLUDE_LINE);
  checks.push({
    name: '.git/info/exclude',
    ok: excluded,
    detail: excluded
      ? `hides ${EXCLUDE_LINE}`
      : `missing ${EXCLUDE_LINE} — CLAUDE.local.md will show as untracked and eventually get committed`,
    repair: () => {
      writeFile(excludePath(clone), exclude + EXCLUDE_BLOCK);
    },
  });

  // --- Claude Code settings ----------------------------------------------------------
  const settings = readSettings(clone);
  const wantTheme = `custom:${themeName(clone)}`;
  const wantAllow = storybookHealthCheckAllow(clone);
  const themeOk = settings?.theme === wantTheme;
  const allowOk = settings?.permissions?.allow?.includes(wantAllow) === true;
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
              : `Storybook health check does not target port ${clone.ports.storybook}`,
          ]
            .filter((x) => x !== undefined)
            .join('; ') || `${wantTheme}, health check on ${clone.ports.storybook}`,
    repair:
      settings === undefined
        ? undefined
        : () => {
            writeFile(settingsPath(clone), settingsContentFor(clone, settings));
          },
  });

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

  const tmpPath = join(clone.path, 'tmp');
  const tmpIsLink = symlinkTarget(tmpPath) !== undefined;
  checks.push({
    name: 'tmp/ is per-clone',
    ok: !tmpIsLink,
    detail: tmpIsLink
      ? 'tmp/ is a SYMLINK — it holds dev-server PID files and must never be shared; only tmp/<KEY> is linked'
      : 'real directory',
  });

  const wsExists = existsSync(workspacePath(clone));
  checks.push({
    name: 'code-workspace',
    ok: wsExists,
    detail: wsExists ? (workspacePath(clone).split('/').pop() ?? '') : 'missing',
    repair: () => {
      writeFile(workspacePath(clone), workspaceContent(clone));
    },
  });

  if (clone.colour.reused) {
    checks.push({
      name: 'colour',
      ok: false,
      detail: `the palette has wrapped — ${clone.colour.name} is already used by an earlier clone. Add a hue to src/palette.ts.`,
    });
  }

  return checks;
};

export const doctor = (ref: string | undefined, opts: DoctorOptions): void => {
  const all = discoverClones();
  const targets = opts.all === true || ref === undefined ? all : [requireClone(ref)];
  let problems = 0;

  for (const clone of targets) {
    heading(cloneLabel(clone.name, clone.colour));
    for (const check of checksFor(clone, all)) {
      if (check.ok) {
        ok(`${check.name.padEnd(22)} ${pc.dim(check.detail)}`);
        continue;
      }
      problems += 1;
      if (opts.fix === true && check.repair) {
        check.repair();
        warn(`${check.name.padEnd(22)} ${check.detail}`);
        note('repaired');
      } else if (check.repair) {
        fail(`${check.name.padEnd(22)} ${check.detail}`);
        note('fixable with `orch-util doctor --fix`');
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

const requireClone = (ref: string): Clone => {
  const clone = findClone(ref);
  if (!clone) {
    throw new CliError(
      `no such clone: ${ref}`,
      `Known clones: ${
        discoverClones()
          .map((c) => c.name)
          .join(', ') || '(none)'
      }`,
    );
  }
  return clone;
};
