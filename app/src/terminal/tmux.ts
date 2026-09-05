import { run } from '../exec.ts';
import {
  orUndefined,
  type OpenResult,
  type TerminalDriver,
  type TerminalTab,
  type TerminalTabSpec,
  type TerminalWindow,
} from './types.ts';

/**
 * tmux -- the only route on Linux that carries the WHOLE capability set, `writeToTty` included.
 *
 * That is the reason it exists here rather than as a convenience. GNOME Terminal cannot be typed
 * into at all (no VTE API; `TIOCSTI` off by default since Linux 6.2) and Konsole needs `qdbus`
 * installed to do anything beyond opening a tab. So on a Linux box without KDE, tmux is what
 * makes the `SYNC PAUSE` protocol possible -- and that protocol is the only thing standing
 * between a rebase and an agent editing the tree it is rebasing.
 *
 * ## The mapping, which is the only thing worth getting right
 *
 * | Hangar           | tmux           | why                                                    |
 * | ---------------- | -------------- | ------------------------------------------------------ |
 * | `TerminalWindow` | a **session**  | a session is what a developer looks at and attaches to |
 * | `TerminalTab`    | a **window**   | tmux windows are the tab bar                           |
 * | the tag          | window options | `@hangar_*`, tmux's own user-option namespace          |
 *
 * `TerminalWindow.id` is a number because iTerm2's really is one; tmux session ids are `$0`,
 * `$1`, so the digits after the `$` are it -- a real id and not a scan-local counter like
 * Konsole's, which means it stays valid across calls within a run.
 *
 * ## Tags are WINDOW options, not pane options
 *
 * `@hangar_id`, `@hangar_clone` and `@hangar_role` are set with `set -w`. A pane inherits its
 * window's options in a format lookup, so `list-panes -a -F '#{@hangar_clone}'` reads them either
 * way -- but a tab the developer SPLITS keeps its tag on every pane only if the option lives on
 * the window. Pane options would leave the new pane untagged, and an untagged pane sitting in a
 * clone is exactly what makes `open` stop and ask whether some other window is already there.
 *
 * These are the real analogue of iTerm2's per-session user variables, which is why tmux reaches
 * the full capability set where Terminal.app and Konsole have to smuggle the tag into a title.
 *
 * ## What is verified
 *
 * All five capabilities were exercised against tmux 3.7c on macOS while this was written: windows
 * created with `-P -F`, tagged, read back through `list-panes -a`, and a real `SYNC PAUSE` line
 * delivered into one pane and confirmed ABSENT from the other with `capture-pane`. tmux is the
 * same program on Linux, so unlike the Konsole and GNOME Terminal drivers beside it, this one is
 * not shipped on documentation alone.
 *
 * The one part that cannot be exercised from outside tmux is `switch-client`, which reports
 * `no current client` and is treated as a no-op -- the windows are still created, they are just
 * not brought forward.
 */

const TAG_PREFIX = '@hangar_';

/**
 * ASCII unit separator between `-F` fields.
 *
 * Not `|` or a space: two of the fields are a `pane_current_path` and a free-text
 * `terminal.tabs[].role`, and either may legally contain both. `\u001f` (ASCII unit separator) is what the
 * encoding reserves for exactly this, and it cannot appear in a path.
 */
const FIELD_SEP = '\u001f';

/** The fields `list-panes` is asked for, in order. Kept together so the parse cannot drift. */
const PANE_FORMAT = [
  '#{session_id}',
  '#{window_id}',
  '#{pane_id}',
  '#{pane_tty}',
  `#{${TAG_PREFIX}id}`,
  `#{${TAG_PREFIX}clone}`,
  `#{${TAG_PREFIX}role}`,
  '#{pane_current_path}',
].join(FIELD_SEP);

type Pane = {
  readonly session: string;
  readonly window: string;
  readonly pane: string;
  readonly tty: string;
  readonly hangarId: string | undefined;
  readonly clone: string | undefined;
  readonly role: string | undefined;
  readonly path: string | undefined;
};

const tmux = (args: readonly string[]): { readonly ok: boolean; readonly out: string } => {
  const res = run('tmux', args);
  return { ok: res.ok, out: res.stdout.trim() };
};

/** `$3` -> 3. A session is the only tmux id Hangar has to hand back as a number. */
const sessionNumber = (sessionId: string): number =>
  Number.parseInt(sessionId.replace('$', ''), 10);

const shortTty = (tty: string): string => tty.replace(/^\/dev\//, '');

const readPanes = (): Pane[] => {
  const res = tmux(['list-panes', '-a', '-F', PANE_FORMAT]);
  if (!res.ok || res.out === '') return [];
  const panes: Pane[] = [];
  for (const line of res.out.split('\n')) {
    const parts = line.split(FIELD_SEP);
    if (parts.length !== 8) continue;
    const [session, window, pane, tty, hangarId, clone, role, path] = parts;
    if (session === undefined || window === undefined || pane === undefined || tty === undefined) {
      continue;
    }
    panes.push({
      session,
      window,
      pane,
      tty,
      hangarId: orUndefined(hangarId),
      clone: orUndefined(clone),
      role: orUndefined(role),
      path: orUndefined(path),
    });
  }
  return panes;
};

export const tmuxDriver = (hangarId: string): TerminalDriver => {
  /**
   * A tab's tag only counts when the hangar id matches.
   *
   * Two hangars can share one tmux server -- several hangars on one machine is this tool's whole
   * premise -- and a window tagged for the OTHER one must read as foreign rather than as ours.
   * That is what makes `open` stop and ask instead of pushing a clone's tabs into another
   * hangar's session.
   */
  const mine = (pane: Pane): boolean => pane.hangarId === hangarId;

  const readWindows = (): TerminalWindow[] => {
    const bySession = new Map<string, TerminalTab[]>();
    // One entry per tmux WINDOW, not per pane: a split window is still one tab in Hangar's
    // model, and listing it twice would let `pickFleetWindow` count it twice.
    const seenWindows = new Set<string>();
    for (const pane of readPanes()) {
      const tabs = bySession.get(pane.session) ?? [];
      if (!seenWindows.has(pane.window)) {
        seenWindows.add(pane.window);
        tabs.push({
          clone: mine(pane) ? pane.clone : undefined,
          role: mine(pane) ? pane.role : undefined,
          path: pane.path,
        });
      }
      bySession.set(pane.session, tabs);
    }
    return [...bySession].map(([session, tabs]) => ({ id: sessionNumber(session), tabs }));
  };

  const sessionIdFor = (windowId: number): string | undefined => {
    const want = `$${String(windowId)}`;
    return readPanes().some((pane) => pane.session === want) ? want : undefined;
  };

  /** Tag a tmux window as this hangar's, and give it a readable name. */
  const tagWindow = (window: string, tab: TerminalTabSpec): void => {
    tmux(['set', '-w', '-t', window, `${TAG_PREFIX}id`, hangarId]);
    tmux(['set', '-w', '-t', window, `${TAG_PREFIX}clone`, tab.clone]);
    tmux(['set', '-w', '-t', window, `${TAG_PREFIX}role`, tab.role]);
    // Cosmetic, and its failure is ignored for the same reason Konsole's tab label is: a window
    // name is not worth failing an `open` over.
    tmux(['rename-window', '-t', window, `${tab.clone} ${tab.role}`]);
  };

  /**
   * Run the tab's command in a window that already exists.
   *
   * `send-keys` rather than `new-window -- <command>`: a window whose command is its process
   * exits the moment that process does, so a `claude` tab would vanish on `/exit` instead of
   * leaving the shell the developer expects.
   */
  const runCommand = (window: string, tab: TerminalTabSpec): void => {
    if (tab.command === undefined) return;
    tmux(['send-keys', '-t', window, '-l', '--', tab.command]);
    tmux(['send-keys', '-t', window, 'Enter']);
  };

  /** Create one tmux window in `session`, tag it, and run the tab's command in it. */
  const addWindow = (session: string, tab: TerminalTabSpec): boolean => {
    // `-c` sets the START directory, so no `cd` is needed -- unlike every other driver here,
    // which has to send `cdLine(tab)` because their new tabs open wherever the emulator likes.
    const created = tmux(['new-window', '-t', session, '-c', tab.cwd, '-P', '-F', '#{window_id}']);
    if (!created.ok || created.out === '') return false;
    tagWindow(created.out, tab);
    runCommand(created.out, tab);
    return true;
  };

  const openTabs = (
    tabs: readonly TerminalTabSpec[],
    existing: TerminalWindow | undefined,
  ): OpenResult | undefined => {
    const first = tabs[0];
    if (first === undefined) return undefined;

    const target = existing === undefined ? undefined : sessionIdFor(existing.id);
    if (target !== undefined) {
      for (const tab of tabs) if (!addWindow(target, tab)) return undefined;
      return { windowId: existing?.id ?? 0, createdWindow: false };
    }

    /*
     * No fleet session yet, so make one -- DETACHED, then switch the current client to it.
     *
     * Detached is the only kind a subprocess can create: tmux attaches CLIENTS, and `hangar` is
     * not one. `switch-client` is what makes it visible, and it works precisely when `hangar` was
     * run from inside tmux, which is when this driver gets chosen in the first place. Outside
     * tmux it reports `no current client` and is ignored -- the windows exist, they are simply
     * not brought forward, and `tmux attach -t hangar-<id>` finishes the job.
     *
     * The session starts on the FIRST tab's directory and that window becomes the first tab,
     * rather than being left beside it: `new-session` always creates one window, and a spare
     * untagged one sitting in a clone is exactly the foreign window `open` is built to be
     * suspicious of.
     */
    const created = tmux([
      'new-session',
      '-d',
      '-s',
      `hangar-${hangarId}`,
      '-c',
      first.cwd,
      '-P',
      '-F',
      `#{session_id}${FIELD_SEP}#{window_id}`,
    ]);
    if (!created.ok || created.out === '') return undefined;
    const [session, window] = created.out.split(FIELD_SEP);
    if (session === undefined || window === undefined) return undefined;

    tagWindow(window, first);
    runCommand(window, first);
    for (const tab of tabs.slice(1)) if (!addWindow(session, tab)) return undefined;
    tmux(['switch-client', '-t', session]);
    return { windowId: sessionNumber(session), createdWindow: true };
  };

  const select = (windowId: number, clone: string): boolean => {
    const want = `$${String(windowId)}`;
    let fallback: string | undefined;
    for (const pane of readPanes()) {
      if (pane.session !== want || !mine(pane) || pane.clone !== clone) continue;
      /*
       * Prefer the agent's tab and DEGRADE rather than fail without one -- the same rule Konsole
       * follows. `claude` is the schema's default role name and not a guarantee:
       * `terminal.tabs[].role` is free text and a hangar may call it anything, so this stays a
       * preference with a fallback, never a match the selection depends on.
       */
      if (pane.role === 'claude') {
        tmux(['select-window', '-t', pane.window]);
        tmux(['switch-client', '-t', want]);
        return true;
      }
      fallback ??= pane.window;
    }
    if (fallback === undefined) return false;
    tmux(['select-window', '-t', fallback]);
    tmux(['switch-client', '-t', want]);
    return true;
  };

  /**
   * `send-keys` into the pane on `tty` -- the capability this driver exists for.
   *
   * `-l` sends the text literally, so a word like `Enter` inside a message stays a word instead
   * of becoming a keypress, and `--` guards a message that begins with a dash. The newline is a
   * separate `Enter` because `-l` really is literal: without it the line would sit unsent on the
   * agent's input, which for a `SYNC PAUSE` is the worst of the three outcomes -- delivered, and
   * not read.
   *
   * Matched on the PANE's tty rather than the window's: a split window has one tty per pane, and
   * the session Hangar is looking for is on exactly one of them.
   */
  const writeToTty = (tty: string, text: string): boolean => {
    const want = shortTty(tty);
    const pane = readPanes().find((p) => shortTty(p.tty) === want);
    if (pane === undefined) return false;
    if (!tmux(['send-keys', '-t', pane.pane, '-l', '--', text]).ok) return false;
    return tmux(['send-keys', '-t', pane.pane, 'Enter']).ok;
  };

  return {
    kind: 'tmux',
    label: 'tmux',
    capabilities: {
      openTabs: true,
      inspect: true,
      tag: true,
      writeToTty: true,
      select: true,
      // The shell hook paints the OUTER terminal on every `cd`, which is the one the developer is
      // actually looking at. A per-pane colour would be tmux's own business and is not what
      // `paintOnCreate` means -- that flag is for a driver whose emulator cannot be coloured from
      // the shell at all, which today is Terminal.app alone.
      paintOnCreate: false,
    },
    /*
     * Installed, AND with a client actually attached. The second half is the whole check.
     *
     * A running server is not enough: a leftover DETACHED session -- started for something else
     * and abandoned -- makes tmux answer "available", and this driver is probed first on both
     * platforms. `hangar open` from somewhere the environment cannot identify (VS Code's
     * integrated terminal, a hook, a `claude -p` child) would then create a session nobody is
     * looking at, `switch-client` would fail with `no current client`, and `open` would report
     * success while the developer saw nothing. That is exactly the failure this check exists to
     * prevent, arriving through the one condition an earlier version of it did not test.
     *
     * `list-clients` exits 0 with EMPTY output when nothing is attached, so the exit code is not
     * the answer -- the output is. Verified both ways here.
     *
     * Tightening this cannot break the case tmux exists for: running inside tmux sets `$TMUX`,
     * which `resolveTerminal` answers from the environment (`source: 'env'`) without ever
     * consulting `isAvailable`.
     */
    isAvailable: () => {
      if (!run('sh', ['-c', 'command -v tmux >/dev/null 2>&1']).ok) return false;
      const clients = tmux(['list-clients']);
      return clients.ok && clients.out !== '';
    },
    unavailableHint: () =>
      'tmux is not on PATH, or no tmux client is attached to a session. Start one (`tmux`) and ' +
      'run this from inside it, or set `terminal.kind` in hangar.config.yaml.',
    windows: readWindows,
    openTabs,
    select,
    writeToTty,
  };
};
