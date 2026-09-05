import { join } from 'node:path';

import { run } from '../exec.ts';
import { home } from '../user-paths.ts';
import type { PlatformDriver } from './types.ts';

/**
 * macOS. The one platform this fleet actually runs on, and so the one whose paths are verified.
 *
 * Homebrew is a hard requirement here and only here -- `hangar_use_gnu` in `.envrc.hangar`
 * prepends the GNU userland off Homebrew and no-ops on every other platform -- which is why
 * every hint is a formula name.
 */
export const darwinPlatform = (): PlatformDriver => {
  const machineConfigDir = join(home, 'Library', 'Application Support');
  return {
    id: 'darwin',
    label: 'macOS',
    capabilities: { openExternally: true, openApplicationByName: true, vscodeWindowState: true },
    machineConfigDir,
    vscodeWindowState: (stateDir) =>
      join(machineConfigDir, stateDir, 'User', 'globalStorage', 'storage.json'),
    openExternally: (target, app) =>
      run('open', app === undefined ? [target] : ['-a', app, target]).ok,
    installHint: (pkg) => `brew install ${pkg}`,
  };
};
