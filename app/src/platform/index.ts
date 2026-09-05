import { darwinPlatform } from './darwin.ts';
import { linuxPlatform } from './linux.ts';
import type { PlatformDriver } from './types.ts';

/**
 * The platform registry -- the fifth seam, registered exactly like the other four.
 *
 * Resolved from `process.platform` and NOT overridable by config, which is the one way this seam
 * differs from `editor.kinds` and `terminal.kind`. Those name a preference; this names a fact,
 * and a config key that let someone declare `darwin` on a Linux box would only produce paths
 * under a `~/Library` that is not there.
 */
const unsupportedPlatform = (id: string): PlatformDriver => ({
  id: 'unsupported',
  label: `${id} (unsupported)`,
  capabilities: { openExternally: false, openApplicationByName: false, vscodeWindowState: false },
  // Not a guess at where this platform keeps configuration -- the XDG default is simply the
  // least-wrong place to point a message at, and both capabilities that would USE it are false.
  machineConfigDir: '',
  vscodeWindowState: () => undefined,
  openExternally: () => false,
  applicationExists: () => false,
  installHint: (pkg) => `install ${pkg} however this platform installs software`,
});

/**
 * The driver for the machine this process is on.
 *
 * Not cached: `process.platform` cannot change under a running process, so a cache would buy
 * nothing, and a module-level constant is the import-time-evaluation trap this CLI has already
 * paid for once.
 */
export const platform = (): PlatformDriver => {
  if (process.platform === 'darwin') return darwinPlatform();
  if (process.platform === 'linux') return linuxPlatform();
  return unsupportedPlatform(process.platform);
};

export type { PlatformDriver, PlatformCapabilities, PlatformId } from './types.ts';
