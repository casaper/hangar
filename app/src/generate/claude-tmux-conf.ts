import type { Hangar } from '../hangar.ts';
import { MODE_COLOURS, STATUS_BAR_BG, STATUS_BAR_DIM, STATUS_BAR_FG } from '../palette.ts';
import { claudeSocketName } from '../tmux.ts';
import { type Artifact, artifactHeader } from './index.ts';
import { claudeCodeSettingLines, quoteTmuxValue } from './tmux-conf.ts';

/**
 * `.hangar/claude-tmux.conf` -- the config the hangar-ROOT session server starts under.
 *
 * `hangar claude` puts both root modes in one tmux session, with a plain shell beside them:
 * operator in window 1, developer in window 2, the shell in window 3. That is a second server on
 * its own socket (`claudeSocketName`), and `src/tmux.ts` says why -- every session on the clone
 * socket is expected to name a clone.
 *
 * ## Why this one is not written by `colours sync`
 *
 * `clone-tmux.conf` is, and `doctor` byte-compares it, because nothing else would notice it
 * going stale. This file is rewritten by `hangar claude` immediately before it starts the
 * server, and `hangar claude` is the only thing that reads it -- so stale is not a state it can
 * reach, there is nothing for `doctor` to check, and it needs no `.gitignore` entry because
 * `.hangar/` already has one.
 *
 * ## The bar options are a TABLE, because two consumers write them
 *
 * `-f` is read once, when the server starts. Everything in `BAR_OPTIONS` is a global SESSION
 * option rather than a server option, so the command also writes the same list onto a server
 * that is already running -- the same split `clone-tmux.conf` and `TmuxServer.restyle` live on,
 * and the reason `kill-server` is not needed to change how the bar looks. One table, two
 * consumers; two copies of it would drift and the symptom would be a bar that looks right on a
 * fresh server and wrong on yesterday's.
 *
 * ## The header is one line, and the width budget is the reason it is shaped this way
 *
 * tmux reserves `status-left-length` and `status-right-length` first and gives the window list
 * whatever remains. So `status-left` is empty with a length of 0: the whole width goes to the
 * tabs, which is where the text saying what each session is FOR lives. Measured on tmux 3.7c
 * with the formats below, reading `#{E:status-format[0]}` back off a live server and counting the
 * list alone -- the truncation markers are not part of it, the separators between entries are:
 *
 *   operator current    ` ops · run the fleet  dev  shell `    35 columns
 *   developer current   ` ops  dev · change the CLI  shell `   36 columns
 *   shell current       ` ops  dev  shell `                    19 columns
 *
 * and the list is given `columns - 3`, so the worst case fits exactly at a 39-column terminal.
 * `status` is `on` (one line) and not `2`; tmux truncates a status line rather than wrapping it,
 * so the requirement that it never becomes two lines is a property of that one setting.
 *
 * The per-window `window-status-current-format` carrying the mode's hue is set at RUNTIME, not
 * here: it differs per window, and this file is read once for the whole server. The neutral
 * defaults below are what a server attached to by hand falls back to -- and what the shell tab
 * uses on purpose, since it is not a mode and has no hue of its own.
 */

/** A global session option: renderable into the conf, and writable onto a live server. */
export type BarOption = { readonly name: string; readonly value: string };

/**
 * The status bar, as data.
 *
 * Every entry is a global SESSION option -- checked deliberately, because that is what makes the
 * live-apply pass possible. A server option in here would be a setting `hangar claude` could
 * write into the conf and never onto a running server, with nothing to say which had happened.
 */
export const BAR_OPTIONS: readonly BarOption[] = [
  { name: 'status', value: 'on' },
  { name: 'status-position', value: 'top' },
  { name: 'status-style', value: `bg=${STATUS_BAR_BG},fg=${STATUS_BAR_FG}` },
  // Empty, with a length of 0, so the tab list gets the entire width. See the header.
  { name: 'status-left', value: '' },
  { name: 'status-left-length', value: '0' },
  // Zero-width until C-b is pressed, and 3 is what the widest tab row leaves room for at 39
  // columns. The prefix indicator is the one thing worth spending the right-hand side on.
  { name: 'status-right', value: '#{?client_prefix,^B ,}' },
  { name: 'status-right-length', value: '3' },
  { name: 'window-status-style', value: `fg=${STATUS_BAR_DIM}` },
  { name: 'window-status-format', value: ' #W ' },
  // Overridden per window at runtime with that mode's hue; this is the fallback.
  { name: 'window-status-current-format', value: ` #[fg=${STATUS_BAR_FG},bold]#W#[default] ` },
];

/**
 * One window's own `window-status-current-format`, with its mode's hue baked in.
 *
 * Baked rather than read from a `@hangar_hue` user option inside the `#[…]` style spec: setting
 * a per-window format with the value already in it is what `clone-terminal.sh` does, and it is
 * known to work. The purpose text stays a user option (`@hangar_purpose`), which expands inside
 * a format perfectly well -- verified on tmux 3.7c.
 */
export const modeWindowFormat = (mode: 'ops' | 'dev'): string => {
  const { main, ink } = MODE_COLOURS[mode];
  return `#[bg=${main},fg=${ink},bold] #W · #{@hangar_purpose} #[default]`;
};

export const claudeTmuxConfArtifact = (hangar: Hangar): Artifact => {
  const socket = claudeSocketName(hangar.id);
  return {
    path: hangar.paths.claudeTmuxConf,
    mode: 0o644,
    what: `tmux config for this hangar's root-session server (tmux -L ${socket})`,
    content: `${[
      artifactHeader(
        hangar,
        `tmux config for the hangar-root session server: tmux -L ${socket}`,
        [
          'Rewritten every run, immediately before the server starts -- so editing it by',
          'hand lasts exactly until the next one.',
        ],
        'hangar claude',
      ),
      '',
      '# ---- Claude Code inside tmux ------------------------------------------------------',
      '# The same four settings the clone server gets, and for the same reason: two of the three',
      '# windows here run Claude Code. Two of the settings are SERVER options, which is why this',
      "# is a server of its own rather than a session on somebody else's.",
      ...claudeCodeSettingLines(),
      '',
      '# ---- whose sessions these are -----------------------------------------------------',
      `set -g @hangar_id ${hangar.id}`,
      '',
      '# ---- the three windows ------------------------------------------------------------',
      '# `renumber-windows off` is the one that matters: operator is window 1, developer is 2 and',
      '# the shell is 3, and closing one must not renumber the others. With it on, exiting',
      '# operator would move developer to index 1 and the next run would recreate operator at 2',
      '# -- the tabs would swap places for no reason the developer could see. The shell is the',
      '# window this happens to most, since `exit` there is reflex.',
      'set -g  base-index 1',
      'set -gw pane-base-index 1',
      'set -g  renumber-windows off',
      '',
      '# ---- the status line --------------------------------------------------------------',
      '# One line, and the whole width goes to the tabs. `hangar claude` writes this same list',
      '# onto a server that is already running, since every one of them is a session option.',
      ...BAR_OPTIONS.map((o) => `set -g ${o.name} ${quoteTmuxValue(o.value)}`),
      '',
      '# Which hangar, in the TERMINAL WINDOW title -- the bar has no width to spare for it.',
      'set -g set-titles on',
      `set -g set-titles-string '${hangar.id} - #{window_name}'`,
      '',
      '# ---- the rest ---------------------------------------------------------------------',
      "set -g default-terminal 'tmux-256color'",
      'set -g escape-time 10',
      'set -g history-limit 50000',
      'set -g focus-events on',
    ].join('\n')}\n`,
  };
};
