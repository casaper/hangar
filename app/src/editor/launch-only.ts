import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { run } from '../exec.ts';
import type { Clone } from '../fleet.ts';
import { fleetRoot } from '../paths.ts';
import type { EditorDriver, LaunchResult } from './types.ts';

/**
 * Xcode and Eclipse: launched, never synced.
 *
 * Both were chosen knowing that, and the reason is the same in each case turned inside out --
 * their project files are the wrong shape for a fleet, in opposite ways:
 *
 * - **Xcode's `.xcodeproj` / `.xcworkspace` are DIRECTORIES of generated state** -- build
 *   settings interleaved with file references, user state, index metadata. Copying one between
 *   clones does not share a setting, it imports another checkout's index; there is nothing here
 *   that a text transform could make clone-neutral.
 * - **Eclipse's `.project` and `.classpath` are normally TRACKED**, so the sync engine would
 *   refuse them anyway -- and correctly, since they are branch content. Its per-user state lives
 *   in the `-data` workspace directory, which is outside the clone entirely.
 *
 * So both declare `syncArtifacts: false` with an empty list, and `<kind> sync` is not offered for
 * them. What they do give is the one thing worth automating: `hangar open` putting the clone in
 * front of you along with everything else.
 *
 * Neither is verified: Eclipse is not installed on the machine this was built on, and while
 * Xcode is, launching it on an Angular checkout was not something worth doing to find out.
 */

/** `xed` opens a directory in Xcode, and Xcode focuses a project it already has open. */
const launchXcode = (clone: Clone): LaunchResult | undefined => {
  const res = run('xed', [clone.path]);
  if (res.ok) return { target: clone.path, reused: false };
  return {
    target: clone.path,
    reused: false,
    note: `xed refused it: ${res.stderr.trim() || `exited ${String(res.code)}`}`,
  };
};

export const xcodeDriver = (): EditorDriver => ({
  kind: 'xcode',
  label: 'Xcode',
  capabilities: {
    launch: true,
    focusExisting: false,
    syncArtifacts: false,
    rewritesRootPaths: false,
  },
  isAvailable: () => run('sh', ['-c', 'command -v xed >/dev/null 2>&1']).ok,
  unavailableHint: () =>
    '`xed` is not on PATH — it ships with Xcode; `xcode-select --install` provides it.',
  launch: launchXcode,
  artifacts: [],
});

/**
 * Eclipse needs a `-data` workspace directory per clone, and it must not be inside the clone.
 *
 * Eclipse writes continuously into that directory -- indexes, per-user preferences, editor state
 * -- so putting it in the checkout would make every clone permanently dirty and eventually
 * commit it. It goes in the hangar's own gitignored `.hangar/eclipse/<clone>` instead: outside
 * every clone, one per clone (a shared one would have Eclipse fight itself over which project
 * tree is which), and swept away with the rest of `.hangar/`.
 */
export const eclipseWorkspaceDir = (clone: Clone): string =>
  join(fleetRoot, '.hangar', 'eclipse', clone.name);

const launchEclipse = (binary: string, clone: Clone): LaunchResult | undefined => {
  const data = eclipseWorkspaceDir(clone);
  const res = run(binary, ['-data', data, clone.path]);
  if (res.ok) return { target: clone.path, reused: false, note: `workspace: ${data}` };
  return {
    target: clone.path,
    reused: false,
    note: `${binary} refused it: ${res.stderr.trim() || `exited ${String(res.code)}`}`,
  };
};

export const eclipseDriver = (launcherOverride?: string): EditorDriver => {
  const binary =
    launcherOverride !== undefined && launcherOverride !== '' ? launcherOverride : 'eclipse';
  const present = (): boolean =>
    run('sh', ['-c', `command -v ${binary} >/dev/null 2>&1`]).ok ||
    (process.platform === 'darwin' && existsSync('/Applications/Eclipse.app'));

  return {
    kind: 'eclipse',
    label: 'Eclipse',
    capabilities: {
      launch: true,
      focusExisting: false,
      syncArtifacts: false,
      rewritesRootPaths: false,
    },
    isAvailable: present,
    unavailableHint: () =>
      `\`${binary}\` is not on PATH — Eclipse ships no launcher script, so set editor.eclipse.launcher in hangar.config.yaml to the one inside the app bundle.`,
    launch: (clone) => launchEclipse(binary, clone),
    artifacts: [],
  };
};
