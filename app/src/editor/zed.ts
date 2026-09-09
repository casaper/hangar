import { join } from 'node:path';

import { run } from '../exec.ts';
import type { Clone } from '../fleet.ts';
import type { EditorArtifact, EditorDriver, LaunchResult } from './types.ts';

/**
 * Zed.
 *
 * The simplest driver here, and like JetBrains that is Zed's doing rather than a shortcut:
 *
 * - **The project is the directory**, so launching is `zed <clone path>` and there is no
 *   workspace file to generate or to choose between.
 * - **It keys a window on that path**, so a second invocation focuses the window that is already
 *   open. Hence `focusExisting: false` -- the editor handles it, and Hangar reimplementing it
 *   would be reimplementing it worse.
 * - **`.zed/settings.json` holds no absolute paths into the checkout.** Zed resolves tool paths
 *   from the project root itself, so there is nothing to rewrite per clone: `rootKeys` is empty,
 *   which makes the sync engine's transform an identity and lets the same code path serve it.
 *
 * `zed` blocks by default when it is the foreground process, so `--add`… no: the launcher returns
 * immediately once the app has the path. Nothing here waits on it.
 *
 * Not verified against a live Zed -- it is not installed on the machine this was built on.
 */
const zedFile = (name: string): EditorArtifact => ({
  id: `.zed/${name}`,
  tracked: false,
  copies: (clone: Clone) => [join(clone.path, '.zed', name)],
  rootKeys: {},
  indexLabel: false,
  cloneValues: false,
});

/**
 * `.zed/debug.json` is deliberately absent: it holds debug targets, which are as
 * branch-specific as VS Code's `launch.json` and so are git's to move, not this command's.
 */
export const ZED_ARTIFACTS: readonly EditorArtifact[] = [
  zedFile('settings.json'),
  zedFile('tasks.json'),
];

const launchZed = (clone: Clone): LaunchResult | undefined => {
  const res = run('zed', [clone.path]);
  if (res.ok) return { target: clone.path, reused: false };
  return {
    target: clone.path,
    reused: false,
    note: `Zed refused the project: ${res.stderr.trim() || `\`zed\` exited ${String(res.code)}`}`,
  };
};

export const zedDriver = (): EditorDriver => ({
  kind: 'zed',
  label: 'Zed',
  capabilities: {
    launch: true,
    focusExisting: false,
    syncArtifacts: true,
    rewritesRootPaths: false,
  },
  isAvailable: () => run('sh', ['-c', 'command -v zed >/dev/null 2>&1']).ok,
  unavailableHint: () =>
    'the `zed` command is not on PATH — in Zed, run “zed: install cli” from the command palette.',
  launch: launchZed,
  artifacts: ZED_ARTIFACTS,
});
