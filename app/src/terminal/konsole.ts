import { run } from '../exec.ts';
import {
  cdLine,
  orUndefined,
  type OpenResult,
  type TerminalDriver,
  type TerminalTab,
  type TerminalTabSpec,
  type TerminalWindow,
} from './types.ts';

/**
 * Konsole (KDE) -- driven over D-Bus, which makes it the most capable of the Linux drivers.
 *
 * Konsole publishes one service per process, `org.kde.konsole-<pid>`, with an object per window
 * (`/Windows/N`, interface `org.kde.konsole.Window`) and per session (`/Sessions/N`, interface
 * `org.kde.konsole.Session`). That gives us everything except user variables:
 *
 * | need           | how                                                          |
 * | -------------- | ------------------------------------------------------------ |
 * | list windows   | `sessionList` on each `/Windows/N`                           |
 * | new tab        | `newSession` on a specific window, then `runCommand`          |
 * | tag            | `setTitle(0, …)` / `title(0)` -- the session NAME, see below   |
 * | directory      | `currentWorkingDirectory`                                     |
 * | type into a tab| `sendText`                                                    |
 * | select         | `setCurrentSession`                                           |
 *
 * ## Capabilities depend on `qdbus` being installed
 *
 * Without it Konsole can still open tabs -- `konsole --new-tab` does that from the command line
 * -- but nothing else: no listing, no tagging, no `SYNC PAUSE`. So this driver settles its own
 * capabilities at construction from whether a `qdbus` binary is present, rather than claiming
 * abilities that will fail one at a time later. On a KDE box `qdbus` normally comes with
 * `qt6-tools` / `qttools5-dev-tools`; `hangar doctor` reports which mode is in force.
 *
 * ## The session name is the tag
 *
 * Like Terminal.app, Konsole has no user variables, so the tag lives in a title: the session
 * NAME (`setTitle(0, …)`), which is machine-readable over D-Bus and is not what the tab bar
 * shows. The visible tab label is set separately with `setTabTitleFormat`, purely so the
 * developer can read the clone off the tab; that call's failure is ignored, because a cosmetic
 * label is not worth failing an `open` over.
 *
 * ## Not verified on hardware
 *
 * This driver is written from Konsole's documented D-Bus interface. macOS is the platform Hangar
 * runs on today, so the Linux drivers have not been exercised against a live Konsole -- the shape
 * is right, the exact reply parsing may need a nudge on first contact. `hangar doctor` prints the
 * detected driver and its capabilities, which is the first thing to look at if it misbehaves.
 */
const TAG_SEP = ' · ';
const QDBUS_CANDIDATES = ['qdbus6', 'qdbus-qt6', 'qdbus', 'qdbus-qt5'] as const;

const findQdbus = (): string | undefined =>
  QDBUS_CANDIDATES.find((bin) => run('sh', ['-c', `command -v ${bin} >/dev/null 2>&1`]).ok);

const tagFor = (hangarId: string, tab: TerminalTabSpec): string =>
  ['hangar', hangarId, tab.clone, tab.role].join(TAG_SEP);

const parseTag = (
  hangarId: string,
  name: string | undefined,
): { clone: string | undefined; role: string | undefined } => {
  const parts = (name ?? '').split(TAG_SEP);
  if (parts.length !== 4 || parts[0] !== 'hangar' || parts[1] !== hangarId) {
    return { clone: undefined, role: undefined };
  }
  return { clone: orUndefined(parts[2]), role: orUndefined(parts[3]) };
};

/** One window, as this driver has to address it: a service plus an object path. */
type KonsoleWindow = { readonly service: string; readonly object: string };

const konsoleServices = (qdbus: string): string[] =>
  run(qdbus, [])
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('org.kde.konsole'));

const call = (
  qdbus: string,
  service: string,
  object: string,
  method: string,
  ...args: string[]
): string | undefined => {
  const res = run(qdbus, [service, object, method, ...args]);
  return res.ok ? res.stdout.trim() : undefined;
};

const numbers = (out: string | undefined): number[] =>
  (out ?? '')
    .split(/\s+/)
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));

/** tty per pid, for mapping a Claude session's tty onto the Konsole session running it. */
const ttyByPid = (pids: readonly number[]): Map<number, string> => {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const res = run('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')]);
  if (!res.ok) return out;
  for (const line of res.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    out.set(Number.parseInt(match[1], 10), match[2].replace(/^\/dev\//, ''));
  }
  return out;
};

export const konsoleDriver = (hangarId: string): TerminalDriver => {
  const qdbus = findQdbus();

  /**
   * Window ids handed out to the caller, and what they mean.
   *
   * `TerminalWindow.id` is a plain number because iTerm2's really is one; Konsole needs a
   * (service, object) pair, so `windows()` numbers what it found and remembers the mapping for
   * the `openTabs`/`select` call that follows in the same run. Nothing persists between runs,
   * which is correct -- a window id from a previous invocation may since have closed.
   */
  const scan = new Map<number, KonsoleWindow>();

  const readWindows = (): TerminalWindow[] => {
    if (qdbus === undefined) return [];
    scan.clear();
    const out: TerminalWindow[] = [];
    let nextId = 1;
    for (const service of konsoleServices(qdbus)) {
      const objects = (call(qdbus, service, '/', '') ?? run(qdbus, [service]).stdout)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\/Windows\/\d+$/.test(l));
      for (const object of objects) {
        const sessions = numbers(call(qdbus, service, object, 'sessionList'));
        const tabs: TerminalTab[] = sessions.map((session) => {
          const path = `/Sessions/${String(session)}`;
          const tag = parseTag(hangarId, call(qdbus, service, path, 'title', '0'));
          return {
            clone: tag.clone,
            role: tag.role,
            path: orUndefined(call(qdbus, service, path, 'currentWorkingDirectory')),
          };
        });
        const id = nextId++;
        scan.set(id, { service, object });
        out.push({ id, tabs });
      }
    }
    return out;
  };

  /** `newSession` on a named window, then dress and run. Returns false if the window refused. */
  const addSession = (win: KonsoleWindow, tab: TerminalTabSpec): boolean => {
    if (qdbus === undefined) return false;
    const created = call(qdbus, win.service, win.object, 'newSession');
    const session = Number.parseInt(created ?? '', 10);
    if (!Number.isFinite(session)) return false;
    const object = `/Sessions/${String(session)}`;
    call(qdbus, win.service, object, 'setTitle', '0', tagFor(hangarId, tab));
    // Cosmetic only -- the tab-bar label. Ignored if this Konsole spells the method differently.
    call(qdbus, win.service, object, 'setTabTitleFormat', '0', `${tab.clone} ${tab.role}`);
    call(qdbus, win.service, object, 'runCommand', cdLine(tab));
    return true;
  };

  /**
   * Without D-Bus this is all that is left: `--new-tab` joins Konsole's most recently used
   * window, so the tabs land together but WHICH window cannot be chosen and nothing can be
   * tagged. `open` is told as much by `capabilities.inspect` being false.
   */
  const openViaCli = (tabs: readonly TerminalTabSpec[]): OpenResult | undefined => {
    let opened = 0;
    for (const tab of tabs) {
      const res = run('konsole', [
        '--new-tab',
        '--workdir',
        tab.cwd,
        ...(tab.command === undefined ? [] : ['-e', 'sh', '-c', `${tab.command}; exec $SHELL`]),
      ]);
      if (res.ok) opened += 1;
    }
    return opened === 0 ? undefined : { windowId: 0, createdWindow: false };
  };

  const openTabs = (
    tabs: readonly TerminalTabSpec[],
    existing: TerminalWindow | undefined,
  ): OpenResult | undefined => {
    if (qdbus === undefined) return openViaCli(tabs);
    const target = existing === undefined ? undefined : scan.get(existing.id);
    if (target === undefined) {
      // No window to append to: start one, then put the remaining tabs in it.
      const first = tabs[0];
      if (first === undefined) return undefined;
      const res = run('konsole', ['--workdir', first.cwd]);
      if (!res.ok) return undefined;
      const created = readWindows();
      const win = created.length === 0 ? undefined : scan.get(created[created.length - 1]?.id ?? 0);
      if (win === undefined) return undefined;
      for (const tab of tabs) if (!addSession(win, tab)) return undefined;
      return { windowId: created[created.length - 1]?.id ?? 0, createdWindow: true };
    }
    for (const tab of tabs) if (!addSession(target, tab)) return undefined;
    return { windowId: existing?.id ?? 0, createdWindow: false };
  };

  const select = (windowId: number, clone: string): boolean => {
    if (qdbus === undefined) return false;
    const win = scan.get(windowId);
    if (win === undefined) return false;
    const sessions = numbers(call(qdbus, win.service, win.object, 'sessionList'));
    let fallback: number | undefined;
    for (const session of sessions) {
      const tag = parseTag(
        hangarId,
        call(qdbus, win.service, `/Sessions/${String(session)}`, 'title', '0'),
      );
      if (tag.clone !== clone) continue;
      /*
       * Prefer the agent's tab, and DEGRADE rather than fail when there is none.
       *
       * `claude` is the schema's default role name, not a guarantee: `terminal.tabs[].role` is
       * free text and a hangar may call it anything. So this is a preference with a fallback to
       * the clone's first tab, never a match the selection depends on -- the only literal role
       * name anywhere, and it is worth keeping that way.
       */
      if (tag.role === 'claude') {
        call(qdbus, win.service, win.object, 'setCurrentSession', String(session));
        return true;
      }
      fallback ??= session;
    }
    if (fallback === undefined) return false;
    call(qdbus, win.service, win.object, 'setCurrentSession', String(fallback));
    return true;
  };

  /**
   * `sendText` on the session whose shell is on `tty`.
   *
   * Konsole reports a session's shell pid (`processId`) but not its tty, so the two are joined
   * through the process table. `sendText` does not append a newline, hence the explicit `\n`:
   * without it the text would sit unsent on the session's command line, which for a `SYNC PAUSE`
   * is the worst of both outcomes -- delivered but not read.
   */
  const writeToTty = (tty: string, text: string): boolean => {
    if (qdbus === undefined) return false;
    const want = tty.replace(/^\/dev\//, '');
    for (const service of konsoleServices(qdbus)) {
      const objects = run(qdbus, [service])
        .stdout.split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\/Sessions\/\d+$/.test(l));
      const pids = new Map<string, number>();
      for (const object of objects) {
        const pid = Number.parseInt(call(qdbus, service, object, 'processId') ?? '', 10);
        if (Number.isFinite(pid)) pids.set(object, pid);
      }
      const ttys = ttyByPid([...pids.values()]);
      for (const [object, pid] of pids) {
        if (ttys.get(pid) !== want) continue;
        return call(qdbus, service, object, 'sendText', `${text}\n`) !== undefined;
      }
    }
    return false;
  };

  const hasDbus = qdbus !== undefined;
  return {
    kind: 'konsole',
    label: hasDbus ? 'Konsole' : 'Konsole (no qdbus — tabs only)',
    capabilities: {
      openTabs: true,
      inspect: hasDbus,
      tag: hasDbus,
      writeToTty: hasDbus,
      select: hasDbus,
      // Konsole honours the background-colour escape sequence, so the shell hook paints it.
      paintOnCreate: false,
    },
    isAvailable: () => run('sh', ['-c', 'command -v konsole >/dev/null 2>&1']).ok,
    unavailableHint: () =>
      'Konsole is not on PATH — install it, or set `terminal.kind` in hangar.config.yaml.',
    windows: readWindows,
    openTabs,
    select,
    writeToTty,
  };
};
