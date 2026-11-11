import type { HangarConfig } from './config/schema.ts';
import { shellQuote } from './tmux.ts';

/**
 * `C-b C-n`: what one press of a runner row does, decided from the facts. PURE.
 *
 * The config says what a row is (`runner` in `config/schema.ts`); this says what pressing it does
 * NOW, given which windows are open and whether they are busy. Every answer is a value, so the
 * whole table can be printed side by side in a test with no tmux server.
 */

export type RunnerEntry = HangarConfig['runner'][number];

/** A row that toggles a dev server, as opposed to one that runs a line. */
export const isServerRow = (entry: RunnerEntry): entry is Extract<RunnerEntry, { role: string }> =>
  'role' in entry;

/**
 * The `@hangar_role` a command row's windows carry: `run:<name>`.
 *
 * A tag rather than a window name, because tmux renumbers windows and a person may rename one --
 * the same reason every role window is found by `@hangar_role`. The prefix keeps a runner window
 * from ever being mistaken for one of the clone's configured roles.
 */
export const runnerRole = (name: string): string => `run:${name}`;

/** One pane of a window the row owns: the role window for a server, `run:<name>` otherwise. */
export type RunnerPane = {
  readonly paneId: string;
  readonly windowId: string;
  /** Its foreground process is a shell -- nothing is running in it. */
  readonly idle: boolean;
};

/** The first row of a file pick: no file arguments, which every script takes to mean all. */
export const ALL_ROW = '(all)';

/**
 * The line a command row types: its command, one `arg` per picked file, and `&& exit` when the
 * window should close on success. PURE.
 *
 * Each argument is quoted for the shell it is typed into, because a picked path is data. `&& exit`
 * rather than a check afterwards: the shell exits only when the line succeeded, and tmux closes a
 * window whose last pane exits -- so a failure leaves the window and its output where they were.
 */
export const runnerLine = (
  entry: Extract<RunnerEntry, { command: string }>,
  files: readonly string[],
): string => {
  const args = files.map((file) => shellQuote(entry.pick?.arg.replaceAll('{file}', file) ?? file));
  const line = [entry.command, ...args].join(' ');
  return entry.closeOnSuccess ? `${line} && exit` : line;
};

export type RunnerAction =
  | { readonly do: 'start-server'; readonly role: string }
  /** C-c in the pane, then close the window once the shell is back. */
  | { readonly do: 'stop-server'; readonly paneId: string; readonly windowId: string }
  /** The role window is there but idle: close it, so `servers start` can open its own. */
  | { readonly do: 'replace-idle-window'; readonly windowId: string; readonly role: string }
  | { readonly do: 'new-window'; readonly line: string }
  | { readonly do: 'type-in'; readonly paneId: string; readonly line: string }
  | { readonly do: 'refuse'; readonly why: string };

/**
 * What a press of `entry` does. PURE.
 *
 * A server row asks two things, because either alone is wrong. **A busy role window means
 * running**, even with no port yet: a dev server compiling for a minute has not bound, and a
 * port-only check would start a second one. **A port held with no window means running too**,
 * but somewhere the key cannot stop it cleanly -- a server started by hand in another tab -- so
 * that is a refusal naming the command that can.
 *
 * A command row never stops anything: `test` pressed while a test run is going is ignored, and
 * says so, rather than killing the run the developer is waiting for.
 */
export const runnerAction = (
  entry: RunnerEntry,
  panes: readonly RunnerPane[],
  servingPort: number | undefined,
  files: readonly string[],
): RunnerAction => {
  if (isServerRow(entry)) {
    const busy = panes.find((p) => !p.idle);
    if (busy !== undefined) {
      return { do: 'stop-server', paneId: busy.paneId, windowId: busy.windowId };
    }
    if (servingPort !== undefined) {
      return {
        do: 'refuse',
        why: `${entry.role} is serving on ${String(servingPort)} outside its window -- \`hangar servers kill\` stops it`,
      };
    }
    const idle = panes[0];
    return idle === undefined
      ? { do: 'start-server', role: entry.role }
      : { do: 'replace-idle-window', windowId: idle.windowId, role: entry.role };
  }
  if (panes.some((p) => !p.idle)) {
    return { do: 'refuse', why: `${entry.name} is still running -- its window has the output` };
  }
  const line = runnerLine(entry, files);
  const reusable = entry.window === 'reuse' ? panes[0] : undefined;
  return reusable === undefined
    ? { do: 'new-window', line }
    : { do: 'type-in', paneId: reusable.paneId, line };
};
