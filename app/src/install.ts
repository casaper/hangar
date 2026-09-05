import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { INSTALL_MARKERS, installCommandFor, type InstallStep } from './config/schema.ts';
import { run } from './exec.ts';
import type { Clone } from './fleet.ts';
import { home, tildify } from './user-paths.ts';
import { note, ok, step as printStep, warn } from './ui.ts';

/**
 * `repo.install[]`, planned and run.
 *
 * What used to be here was `npmCi()` inside `add-clone`: `npm ci` in `angular/`, under the Node
 * version `angular/.nvmrc` pinned. Both halves were this one repo's shape. A SQL repo has no
 * `package.json`, so it got a failing step it never declared, and a Maven repo could not have
 * been described at all.
 *
 * Two rules govern everything below, and they are the reason this is a module rather than a
 * function:
 *
 * - **Planning is pure and separate from running.** `plannedSteps` reads the config and the
 *   clone and touches the filesystem only to answer "does this directory exist"; nothing here
 *   spawns until `runInstall` is called. That is what lets `add-clone -n`, `hangar install -n`
 *   and `doctor` all print the same step list without any of them running a package manager.
 * - **`doctor` checks the DECLARATION and never executes it.** `npm ci` deletes `node_modules`
 *   outright, so a `doctor` that "replayed the step list" would wipe four live clones' installs
 *   while their dev servers were running. `installChecks` asks whether the directory exists,
 *   whether a marker is present when the manager leaves one, and nothing else.
 */

export type PlannedStep = {
  readonly step: InstallStep;
  /** Absolute directory the command runs in. */
  readonly cwd: string;
  /** Clone-relative form of the same, for printing. */
  readonly relDir: string;
  readonly command: readonly string[];
  /** The Node version the step pins, when it names a version file that exists. */
  readonly nodeVersion: string | undefined;
  /** Set when `dir` names a directory this checkout does not have. */
  readonly missingDir: boolean;
};

/** `dir`, defaulting to `repo.appDir`, defaulting to the clone root. */
const dirOf = (clone: Clone, step: InstallStep): string =>
  step.dir ?? (clone.hangar.config.repo.appDir === '' ? '.' : clone.hangar.config.repo.appDir);

/**
 * The Node version a step pins, read from the file it names.
 *
 * Only when `nodeVersionFile` is set: a step that does not name one is not a Node step, and
 * resolving a version for it would put every Ruby and Maven install behind an fnm lookup. The
 * old code read `<appDir>/.nvmrc` unconditionally, which is why it was Node-shaped.
 */
const nodeVersionOf = (cwd: string, step: InstallStep): string | undefined => {
  if (step.nodeVersionFile === undefined) return undefined;
  const path = join(cwd, step.nodeVersionFile);
  if (!existsSync(path)) return undefined;
  const pinned = readFileSync(path, 'utf8').trim();
  return pinned === '' ? undefined : pinned;
};

export const plannedSteps = (clone: Clone): PlannedStep[] =>
  clone.hangar.config.repo.install.map((step) => {
    const relDir = dirOf(clone, step);
    const cwd = join(clone.path, relDir);
    return {
      step,
      cwd,
      relDir,
      command: installCommandFor(step),
      nodeVersion: nodeVersionOf(cwd, step),
      missingDir: !existsSync(cwd),
    };
  });

/**
 * One step as a line of text. A PURE builder, so every variant can be printed side by side.
 *
 * The `why` is on the line rather than in a footnote because this is the only place a reader
 * learns whether the step is load-bearing. The schema requires it for that reason.
 */
export const plannedStepLine = (planned: PlannedStep): string => {
  const bits = [`${planned.relDir}: ${planned.command.join(' ')}`];
  if (planned.nodeVersion !== undefined) bits.push(`(node ${planned.nodeVersion})`);
  if (planned.step.optional) bits.push('(optional)');
  return `${bits.join(' ')} — ${planned.step.why}`;
};

/**
 * What `add-clone --help` and `hangar install -n` print: the whole plan, or that there is none.
 *
 * `install: []` is legal and is the likely answer for a repo with no dependencies to fetch, so
 * it gets a sentence rather than silence -- printing nothing reads as a command that failed.
 */
export const installPlanLines = (clone: Clone): string[] => {
  const planned = plannedSteps(clone);
  if (planned.length === 0) {
    return ['no install steps declared (repo.install is empty) — nothing to fetch'];
  }
  return planned.map(plannedStepLine);
};

export type InstallOptions = { dryRun?: boolean | undefined };

/**
 * Run every declared step, in order.
 *
 * A missing directory is a warning and a skip, never a throw: `dir` may legitimately not exist
 * on the branch a fresh clone landed on. A failing step aborts the run unless it declares
 * `optional: true`, in which case it is reported and the next one starts -- the difference
 * being whether the clone is usable without it.
 */
export const runInstall = (clone: Clone, opts: InstallOptions = {}): void => {
  const planned = plannedSteps(clone);
  if (planned.length === 0) {
    note('No install steps declared (`repo.install` is empty) — nothing to fetch.');
    return;
  }

  for (const item of planned) {
    if (item.missingDir) {
      warn(`${item.relDir}/ does not exist in this checkout — step skipped`);
      continue;
    }

    const [cmd, ...args] = item.command;
    if (cmd === undefined) continue;

    if (opts.dryRun === true) {
      printStep(`would run ${plannedStepLine(item)}`);
      continue;
    }

    printStep(plannedStepLine(item));
    const res = runStep(item, cmd, args);
    if (res.ok) {
      ok(`${item.command.join(' ')} in ${tildify(item.cwd)}`);
      continue;
    }
    const failure = `${item.command.join(' ')} failed (exit ${String(res.code)}) in ${tildify(item.cwd)}`;
    if (item.step.optional) {
      warn(`${failure} — declared optional, continuing`);
      continue;
    }
    warn(`${failure} — run it by hand, or \`hangar install ${clone.name}\``);
    return;
  }
};

/**
 * The directory holding the `node` an installed version manager resolves for `version`.
 *
 * fnm first, because it is a binary and so answers in one spawn. nvm is a SHELL FUNCTION, not
 * an executable -- `command -v nvm` never finds it, which is the same trap `.envrc.hangar`
 * documents beside `hangar_use_node` -- so it has to be sourced in a subshell before it can be
 * asked anything. `nvm which` prints the node executable's path, or fails if that version is
 * not installed; unlike `fnm install`, nothing here INSTALLS a Node version, because an install
 * step is not the place to spend four minutes downloading a toolchain nobody asked for.
 *
 * `undefined` means no version manager could answer, which is not an error -- see `runStep`.
 *
 * **The nvm half has not been exercised against a live nvm**, for the same reason the Konsole and
 * GNOME Terminal drivers say so: this machine has fnm, so the nvm branch is only ever reached
 * where nvm is what is installed. What IS verified here is that it fails silently and cleanly
 * when nvm is absent -- exit 1, no output on either stream -- so an fnm-only machine pays
 * nothing for it and the fnm answer is returned before the probe is reached at all.
 */
const nodeBinDirFor = (version: string): string | undefined => {
  if (run('fnm', ['--version']).ok) {
    const fnmNode = run('fnm', [
      'exec',
      `--using=${version}`,
      '--',
      'node',
      '-e',
      'process.stdout.write(process.execPath)',
    ]);
    if (fnmNode.ok && fnmNode.stdout.trim() !== '') return dirname(fnmNode.stdout.trim());
  }
  const nvmDir = process.env['NVM_DIR'] ?? join(home, '.nvm');
  const nvmNode = run('sh', [
    '-c',
    `. "${nvmDir}/nvm.sh" >/dev/null 2>&1 && nvm which "${version}" 2>/dev/null`,
  ]);
  const path = nvmNode.stdout.trim();
  return nvmNode.ok && path !== '' ? dirname(path) : undefined;
};

/**
 * Spawn one step, under the Node version it pinned when a version manager can supply one.
 *
 * Shell state does not survive between spawns, so the version is applied per command rather
 * than by sourcing anything -- and only when the step asked for it. Rather than fnm's `exec`
 * subcommand, this PREPENDS the resolved bin directory to `PATH`, which is the one form both
 * managers can express: nvm has no `exec` at all.
 *
 * Without either manager the command still runs, on whatever Node is there, because a missing
 * version manager is a worse reason to refuse an install than a version mismatch is. But it now
 * says so. That fallback used to be silent AND fnm-only, while the README promised "either fnm
 * or nvm" and `setup`'s environment row printed `found (of fnm / nvm)` for an nvm-only machine
 * -- so an nvm user's first `add-clone` ran `npm ci` under whatever Node direnv had put first
 * on PATH, which at a hangar root is the HANGAR's Node and not the app's. Nothing said a word,
 * and the two versions agreeing was luck rather than design.
 */
const runStep = (
  item: PlannedStep,
  cmd: string,
  args: readonly string[],
): { ok: boolean; code: number } => {
  const version = item.nodeVersion;
  if (version === undefined) {
    const plain = run(cmd, args, { cwd: item.cwd, inherit: true });
    return { ok: plain.ok, code: plain.code };
  }

  const binDir = nodeBinDirFor(version);
  if (binDir === undefined) {
    warn(`no fnm or nvm could resolve Node ${version} — running on whatever \`node\` is on PATH`);
    note("Install fnm or nvm, or `hangar install` cannot honour this step's nodeVersionFile.");
    const plain = run(cmd, args, { cwd: item.cwd, inherit: true });
    return { ok: plain.ok, code: plain.code };
  }

  const res = run(cmd, args, {
    cwd: item.cwd,
    inherit: true,
    env: { ...process.env, PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
  });
  return { ok: res.ok, code: res.code };
};

export type InstallCheck = {
  readonly name: string;
  readonly ok: boolean;
  /** True when there is no way to tell -- reported as such, never as a failure. */
  readonly unverifiable: boolean;
  readonly detail: string;
};

/**
 * Declaration-only checks, one per step. NOTHING here spawns a package manager.
 *
 * Each step is asked three questions the filesystem can answer: does its directory exist, and
 * if the manager leaves a marker inside the clone, is that marker there. A manager whose
 * result lives outside the checkout (maven, go, cargo, pip, poetry, gradle, deno, bundler)
 * has no answer available, so it says so -- see `INSTALL_MARKERS`.
 */
export const installChecks = (clone: Clone): InstallCheck[] =>
  plannedSteps(clone).map((item) => {
    const name = `install ${item.relDir}`;
    if (item.missingDir) {
      return {
        name,
        ok: item.step.optional,
        unverifiable: false,
        detail: `${item.relDir}/ does not exist in this checkout`,
      };
    }
    const marker = item.step.manager === undefined ? undefined : INSTALL_MARKERS[item.step.manager];
    if (marker === undefined) {
      return {
        name,
        ok: true,
        unverifiable: true,
        detail: `${item.command.join(' ')} declared; nothing inside the clone proves it ran`,
      };
    }
    const present = existsSync(join(item.cwd, marker));
    return {
      name,
      ok: present,
      unverifiable: false,
      detail: present
        ? `${item.relDir}/${marker} present`
        : `no ${item.relDir}/${marker} — run \`hangar install ${clone.name}\``,
    };
  });
