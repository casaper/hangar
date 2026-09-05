import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { run } from '../exec.ts';
import type { Clone } from '../fleet.ts';
import { platform } from '../platform/index.ts';
import { JETBRAINS_PRODUCTS, type JetbrainsProduct } from './kinds.ts';
import type { EditorArtifact, EditorDriver, LaunchResult } from './types.ts';

/**
 * JetBrains IDEs -- IntelliJ IDEA, WebStorm, PyCharm and the rest of the family.
 *
 * Much smaller than the VS Code driver, and the reason is the IDE rather than the effort:
 *
 * - **The project is the DIRECTORY.** There is no workspace file, so launching is
 *   `<launcher> <clone path>` and nothing has to be generated for it. JetBrains also keys an
 *   open project on that directory, so pointing it at a clone it already has open focuses that
 *   window itself -- which is why `focusExisting` is false here and true for VS Code. False
 *   means "the editor handles it", not "expect duplicate windows".
 * - **`$PROJECT_DIR$` already solves the per-clone path problem.** JetBrains writes
 *   project-relative paths through that macro, so `.idea` files are clone-portable as they
 *   stand. There is no counterpart to the text transform VS Code needs, so `rootKeys` is empty
 *   on every artifact below -- which makes `templatize`/`render` an identity transform and lets
 *   the same sync engine serve both editors with no branch in it.
 *
 * ## `.idea/` is never generated, only synced
 *
 * The IDE writes that directory itself and rewrites it constantly; a hand-built `modules.xml` or
 * `.iml` is fragile in a way that is invisible until the IDE quietly reindexes the wrong roots.
 * So Hangar creates nothing here -- open the clone in the IDE once and it appears -- and
 * `jetbrains sync` only keeps the shareable files in step afterwards.
 *
 * ## Not verified against a live IDE
 *
 * Written from JetBrains' documented launcher contract and its documented list of shareable
 * project files. No JetBrains product is installed on the machine this was built on, so the
 * shape is right and first contact may want a nudge. `hangar doctor` prints which launcher was
 * found, which is the first thing to look at.
 */

/**
 * The `.idea` files worth keeping identical across the fleet.
 *
 * This is JetBrains' own documented split, not a guess: everything under `.idea/` is shareable
 * EXCEPT `workspace.xml` (window layout, per-user session state), `usage.statistics.xml`,
 * `tasks.xml`, `dictionaries/` and `shelf/`. Listing what to share rather than what to skip is
 * deliberate -- the skip list grows with every IDE version, and a file wrongly shared is
 * per-user state pushed into a colleague's clone, while a file wrongly skipped is merely not
 * shared yet.
 *
 * `tracked: false` is the DECLARED floor and says nothing final: `.idea/` is gitignored in this
 * fleet's repo, but plenty of projects track it, and `isTracked` asks git per copy so those are
 * protected without this table knowing. See its comment for why the flag can only add.
 */
const ideaFile = (name: string): EditorArtifact => ({
  id: `.idea/${name}`,
  tracked: false,
  copies: (clone: Clone) => [join(clone.path, '.idea', name)],
  // Empty: `$PROJECT_DIR$` means there is nothing clone-specific to rewrite.
  rootKeys: {},
  indexLabel: false,
});

export const JETBRAINS_ARTIFACTS: readonly EditorArtifact[] = [
  ideaFile('codeStyles/codeStyleConfig.xml'),
  ideaFile('codeStyles/Project.xml'),
  ideaFile('inspectionProfiles/Project_Default.xml'),
  ideaFile('jsLinters/eslint.xml'),
  ideaFile('prettier.xml'),
  ideaFile('jsLibraryMappings.xml'),
  ideaFile('misc.xml'),
  ideaFile('modules.xml'),
  ideaFile('vcs.xml'),
];

/** The launcher to run: an explicit path from the config, else the product's name on PATH. */
const resolveLauncher = (
  product: JetbrainsProduct,
  override: string | undefined,
): string | undefined => {
  if (override !== undefined && override !== '') {
    return existsSync(override) || onPath(override) ? override : undefined;
  }
  const { launcher } = JETBRAINS_PRODUCTS[product];
  return onPath(launcher) ? launcher : undefined;
};

const onPath = (bin: string): boolean => run('sh', ['-c', `command -v ${bin} >/dev/null 2>&1`]).ok;

/**
 * Open the clone directory.
 *
 * `reused` is always false, and that is honest rather than a gap: JetBrains decides for itself
 * whether this is a new window or a focus of the existing one, and it does not say which. Since
 * the outcome is right either way, there is nothing to report -- unlike VS Code, where getting
 * it wrong means a duplicate window and so has to be worked out in advance.
 */
const launchJetbrains = (
  product: JetbrainsProduct,
  override: string | undefined,
  clone: Clone,
): LaunchResult | undefined => {
  const launcher = resolveLauncher(product, override);
  const { label, app } = JETBRAINS_PRODUCTS[product];

  if (launcher !== undefined) {
    const res = run(launcher, [clone.path]);
    if (res.ok) return { target: clone.path, reused: false };
    return {
      target: clone.path,
      reused: false,
      note: `${label} refused the project: ${res.stderr.trim() || `\`${launcher}\` exited ${String(res.code)}`}`,
    };
  }

  // Toolbox may not have installed a shell script, and then the application BUNDLE is the only
  // handle left. That is a capability, not a platform: `openApplicationByName` is true on macOS
  // and false on Linux, where a desktop entry is addressed by a reverse-DNS id nobody types and
  // there is no lookup from `WebStorm` to it. A platform without it has nothing to fall back to,
  // and the caller's own message names the launcher that was not found.
  const os = platform();
  if (os.capabilities.openApplicationByName && os.openExternally(clone.path, app)) {
    return {
      target: clone.path,
      reused: false,
      note: `via the ${app} application bundle (no launcher on PATH)`,
    };
  }
  return undefined;
};

export const jetbrainsDriver = (
  product: JetbrainsProduct,
  launcherOverride?: string,
): EditorDriver => ({
  kind: 'jetbrains',
  label: JETBRAINS_PRODUCTS[product].label,
  capabilities: {
    launch: true,
    // The IDE dedupes by project directory itself -- see the header.
    focusExisting: false,
    syncArtifacts: true,
    // `$PROJECT_DIR$` -- nothing clone-specific to rewrite.
    rewritesRootPaths: false,
  },
  /*
   * Exactly the two routes `launchJetbrains` has, in the same order and behind the same guard.
   *
   * It used to answer the second one with `existsSync('/Applications/<name>.app')` while `launch`
   * answered it with `open -a <name>`, and `open.ts` checks this before calling that -- so the
   * bundle fallback was unreachable through `hangar open` in its own motivating case. Toolbox
   * installs under `~/Applications`, which is exactly where that path does not look, and the
   * colleague got "IntelliJ IDEA is not available" for an IDE that was installed and would have
   * opened. Asking the platform keeps the two answers the same by construction.
   */
  isAvailable: () => {
    if (resolveLauncher(product, launcherOverride) !== undefined) return true;
    const os = platform();
    return (
      os.capabilities.openApplicationByName && os.applicationExists(JETBRAINS_PRODUCTS[product].app)
    );
  },
  unavailableHint: () =>
    `no \`${JETBRAINS_PRODUCTS[product].launcher}\` on PATH — in JetBrains Toolbox, enable "Generate shell scripts", or set editor.jetbrains.launcher in hangar.config.yaml.`,
  launch: (clone) => launchJetbrains(product, launcherOverride, clone),
  artifacts: JETBRAINS_ARTIFACTS,
});
