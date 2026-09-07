import { run } from '../exec.ts';
import type { Clone } from '../fleet.ts';
import { VIM_GUI_BINARIES, VIM_TERMINAL_BINARIES } from './kinds.ts';
import type { EditorDriver, LaunchResult } from './types.ts';

/**
 * vim -- the one editor that may not be a window at all.
 *
 * Two completely different things are called "open this clone in vim", and which one applies is
 * decided by what is installed:
 *
 * - **A GUI vim** (MacVim's `mvim`, or `gvim`) is an application like any other here.
 *   `--remote-silent` hands the path to the instance that is already running and starts one when
 *   there is none, so it self-dedupes and needs nothing worked out in advance.
 * - **Terminal vim** (`nvim`, `vim`) has no window to send a path to. Launching it as a
 *   subprocess would attach it to the tty `hangar` itself is running on and hold the command
 *   hostage -- for `open --all`, on the first clone. The honest translation is one more window in
 *   the clone's tmux session, running vim in the clone, which is why this driver reports
 *   `inTerminalTab` and lets `open` add it alongside the configured roles. It lands beside them
 *   in the same session -- which a window opened from here could not manage, since this driver
 *   knows nothing about the clone's session.
 *
 * ## Nothing is synced
 *
 * `syncArtifacts` is false, and that is a decision rather than an omission. vim's project-local
 * config is opt-in and inconsistent -- `.exrc` needs `set exrc`, which is off by default and a
 * documented security footgun; `.nvim.lua` needs `vim.o.exrc`; plenty of setups use neither and
 * keep everything in `~/.vimrc`. Declaring a list would mean copying files between clones that
 * the developer never asked to share, and a wrong guess here writes into a clone root.
 */
const firstOnPath = (candidates: readonly string[]): string | undefined =>
  candidates.find((bin) => run('sh', ['-c', `command -v ${bin} >/dev/null 2>&1`]).ok);

const guiVim = (override: string | undefined): string | undefined =>
  override !== undefined && override !== ''
    ? (firstOnPath([override]) ?? undefined)
    : firstOnPath(VIM_GUI_BINARIES);

const terminalVim = (override: string | undefined): string | undefined =>
  override !== undefined && override !== ''
    ? (firstOnPath([override]) ?? undefined)
    : firstOnPath(VIM_TERMINAL_BINARIES);

/**
 * `--remote-silent` rather than plain `<path>`: it edits in the running server when there is one
 * and opens normally when there is not, with no error message either way. A directory argument
 * gives vim's own directory browser, which is as close to "open the project" as vim has.
 */
const launchGuiVim = (binary: string, clone: Clone): LaunchResult | undefined => {
  const res = run(binary, ['--remote-silent', clone.path]);
  if (res.ok) return { target: clone.path, reused: false };
  return {
    target: clone.path,
    reused: false,
    note: `${binary} refused it: ${res.stderr.trim() || `exited ${String(res.code)}`}`,
  };
};

export const vimDriver = (commandOverride?: string): EditorDriver => {
  const gui = guiVim(commandOverride);
  const term = gui === undefined ? terminalVim(commandOverride) : undefined;

  return {
    kind: 'vim',
    label: gui !== undefined ? `vim (${gui})` : `vim (${term ?? 'not found'}, in a tmux window)`,
    capabilities: {
      launch: gui !== undefined,
      focusExisting: false,
      syncArtifacts: false,
      rewritesRootPaths: false,
      // Only when there is no GUI vim: a GUI window is the better answer when it exists.
      inTerminalTab: gui === undefined && term !== undefined,
    },
    isAvailable: () => gui !== undefined || term !== undefined,
    unavailableHint: () =>
      `none of ${[...VIM_GUI_BINARIES, ...VIM_TERMINAL_BINARIES].join(', ')} is on PATH — install one, or set editor.vim.command in hangar.config.yaml.`,
    launch: (clone) => (gui === undefined ? undefined : launchGuiVim(gui, clone)),
    /** The command `open` runs in the extra tmux window. Only read when `inTerminalTab`. */
    terminalCommand: term === undefined ? undefined : `${term} .`,
    artifacts: [],
  };
};
