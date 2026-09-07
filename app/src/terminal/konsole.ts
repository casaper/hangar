import { run } from '../exec.ts';
import { devPath, type EmulatorDriver, type WindowSpec } from './types.ts';

/**
 * Konsole (KDE) -- a tab or a window from the command line, a raise over D-Bus.
 *
 * `konsole --new-tab` and `konsole --new-window` are all the opening needs, and neither requires
 * anything beyond the binary. Raising does: Konsole publishes one service per process
 * (`org.kde.konsole-<pid>`) with an object per session (`/Sessions/N`), and finding the session
 * on a given tty means asking each one -- which needs `qdbus`, normally shipped as `qt6-tools` or
 * `qttools5-dev-tools`. So this driver settles `raiseByTty` at construction from whether a
 * `qdbus` binary exists, rather than claiming an ability that fails later.
 *
 * ## Not verified against a live Konsole
 *
 * Written from Konsole's documented command line and D-Bus interface. macOS is the platform this
 * fleet runs on, so what is unexercised here is which window comes up -- everything INSIDE it is
 * tmux, which is the same program on both platforms and is exercised. `hangar doctor` prints the
 * detected emulator, which is the first thing to look at if it misbehaves.
 */

const QDBUS_CANDIDATES = ['qdbus6', 'qdbus-qt6', 'qdbus', 'qdbus-qt5'] as const;

const findQdbus = (): string | undefined =>
  QDBUS_CANDIDATES.find((bin) => run('sh', ['-c', `command -v ${bin} >/dev/null 2>&1`]).ok);

export const konsoleDriver = (): EmulatorDriver => {
  const qdbus = findQdbus();

  /**
   * `-e sh -c '<line> || exec $SHELL'` rather than `-e <line>`.
   *
   * `||` rather than `;`: the tmux client runs for as long as the developer is attached, so the
   * trailing shell is reached only when tmux refuses to start -- and a window that closes
   * instantly is the one outcome that tells the developer nothing about why.
   */
  const open = (spec: WindowSpec): boolean =>
    run('konsole', [
      spec.placement === 'tab' ? '--new-tab' : '--new-window',
      '-e',
      'sh',
      '-c',
      `${spec.command} || exec $SHELL`,
    ]).ok;

  const services = (): string[] => {
    if (qdbus === undefined) return [];
    const res = run(qdbus, []);
    return res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('org.kde.konsole'));
  };

  const call = (service: string, object: string, method: string, ...args: string[]): string =>
    qdbus === undefined ? '' : run(qdbus, [service, object, method, ...args]).stdout.trim();

  /** The session whose tty matches, brought to the front of its own window. */
  const raiseByTty = (tty: string): boolean => {
    if (qdbus === undefined) return false;
    const want = devPath(tty);
    for (const service of services()) {
      const sessions = call(service, '/Sessions', 'org.freedesktop.DBus.Introspectable.Introspect');
      for (const match of sessions.matchAll(/name="(\d+)"/g)) {
        const object = `/Sessions/${match[1] ?? ''}`;
        if (call(service, object, 'tty') !== want) continue;
        // `setCurrentSession` takes the session's own number, which is the object's last segment.
        call(service, '/Windows/1', 'setCurrentSession', match[1] ?? '');
        return true;
      }
    }
    return false;
  };

  return {
    kind: 'konsole',
    label: 'Konsole',
    capabilities: { openTab: true, openWindow: true, raiseByTty: qdbus !== undefined },
    isAvailable: () => run('sh', ['-c', 'command -v konsole >/dev/null 2>&1']).ok,
    unavailableHint: () => 'konsole is not on PATH — install it, or set `terminal.kind`.',
    open,
    lastNote: () =>
      qdbus === undefined
        ? 'no qdbus, so Konsole cannot bring an already-open clone forward — install qt6-tools'
        : undefined,
    raiseByTty,
  };
};
