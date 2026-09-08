import type { Hangar } from '../hangar.ts';
import { STATUS_BAR_BG, STATUS_BAR_DIM, STATUS_BAR_FG } from '../palette.ts';
import { type Artifact, artifactHeader } from './index.ts';

/**
 * `clone-tmux.conf` -- the config this hangar's OWN tmux server starts under.
 *
 * Every window `hangar open` creates is a tmux window on a private socket, `tmux -L hangar-<id>`
 * (see `src/tmux.ts`). A private socket is what makes this file safe to be opinionated in: no
 * session of the developer's own lives on that server, so prefix keys, status-line format and
 * server-scope options are this hangar's to set. Two hangars are two sockets and two of these.
 *
 * ## Why a file and not a run of `set` commands
 *
 * Two of the four settings Claude Code documents are SERVER options (`extended-keys`,
 * `terminal-features`), and a server option is the one thing a tool may not write onto a server
 * it does not own. Hangar owns this one, so it can -- and `-f` is the way that cannot be missed:
 * every route into the server goes through `tmuxArgv`, which carries `-f` on the one subcommand
 * that may start it.
 *
 * The file also buys `hangar colours sync --check`, `-n` and the written/unchanged/would-change
 * reporting for free, because it is an `Artifact` like the two shell helpers beside it.
 *
 * ## A missing `-f` file is SILENTLY IGNORED, which is why `open` checks
 *
 * Measured against tmux 3.7c: `tmux -L probe -f /nonexistent new-session -d -s x` exits 0,
 * prints nothing, and creates the session -- unconfigured. So nothing downstream can notice a
 * conf that was never generated; `hangar open` verifies the file exists before it starts a
 * server, and `hangar doctor` compares it with this builder byte for byte.
 *
 * ## It is read ONCE, when the server starts
 *
 * Editing this file -- or regenerating it -- reaches no running server. That is a property of
 * tmux and not of this code, so `doctor` reads the live server's options back and says when they
 * disagree with the table below rather than leaving the developer to wonder.
 *
 * ## Nothing per-clone belongs in here -- but the BAR's own colours do
 *
 * No clone hue appears in this file. The hue is a SESSION option set when `open` creates a
 * clone's session, and the window options are the generated shell hook's; a hue here would be
 * per-clone data in a file the whole hangar shares, so whichever clone was opened last would
 * colour every other clone's bar. `test/tmux-conf.test.ts` asserts that none of them is here.
 *
 * The bar's own background and text are a different thing and belong here, because they are
 * hangar-level and because nothing else can set them. Without a `status-style` tmux uses its
 * built-in `bg=green,fg=black` -- and that is not a neutral default but a saturated one, so
 * every clone hue was being drawn as text on green. Measured across the palette: 1.00:1 to
 * 2.64:1, failing even the 3.0 that large text wants, with the `green` clone at exactly 1.00 --
 * the same colour twice, and invisible. `src/palette.ts` owns those three neutrals, because
 * `barText` is derived by measuring AGAINST the background and two files holding different
 * ideas of it would be wrong with nothing to report it.
 */

/** How to read one setting back off a live server, and how to compare what comes out. */
export type TmuxSetting = {
  /** The flags `set-option` gets in the conf. */
  readonly set: string;
  /** The flags `show-options` gets when `doctor` reads it back. */
  readonly show: string;
  readonly name: string;
  readonly value: string;
  /**
   * `contains` for a setting written with `-a` (append): the live value is a SUPERSET of what
   * was appended, so an equality check would go red on a correctly configured server.
   */
  readonly match: 'exact' | 'contains';
  readonly why: string;
};

/**
 * The four settings Claude Code documents for running inside tmux.
 *
 * One table, two consumers -- rendered into the conf here, and read back off the live server by
 * `doctor`. Two copies of a four-entry table that must agree is the drift this repo keeps
 * finding, and the symptom would be a `doctor` that passes on a server missing a setting.
 *
 * `allow-passthrough` is a PANE option and `-g` is still right: tmux infers the scope from the
 * option name, and `-g` on a pane option sets the global WINDOW option every pane inherits.
 * That is what Claude Code's own documentation says to write.
 */
export const TMUX_SETTINGS: readonly TmuxSetting[] = [
  {
    set: '-s',
    show: '-sv',
    name: 'extended-keys',
    value: 'on',
    match: 'exact',
    why: 'Shift+Enter inserts a newline in Claude Code instead of submitting',
  },
  {
    set: '-as',
    show: '-sv',
    name: 'terminal-features',
    value: 'xterm*:extkeys',
    match: 'contains',
    why: 'advertises extended keys to the terminal outside -- the other half of Shift+Enter',
  },
  {
    set: '-g',
    show: '-gv',
    name: 'allow-passthrough',
    value: 'on',
    match: 'exact',
    why: "lets Claude Code's notifications through tmux to the terminal outside",
  },
  {
    set: '-g',
    show: '-gv',
    name: 'mouse',
    value: 'on',
    match: 'exact',
    why: "mouse-wheel scrolling in Claude Code's fullscreen rendering",
  },
];

/**
 * Single-quote a value that needs it, and leave a bare word bare.
 *
 * Load-bearing rather than cosmetic: an unquoted `#` starts a tmux comment, so a status format
 * or a hex colour written bare would silently truncate the line it is on.
 */
export const quoteTmuxValue = (value: string): string =>
  /^[A-Za-z0-9_.:-]+$/.test(value) ? value : `'${value}'`;

/**
 * `set -s extended-keys on   # why`, aligned so the reasons form a column.
 *
 * Exported because there are two servers, not one: `generate/claude-tmux-conf.ts` renders the
 * same block for the hangar-root session server. Both run Claude Code, so both need all four --
 * and the alternative is a second copy of a table this file spends a paragraph explaining why
 * there must only be one of.
 */
export const claudeCodeSettingLines = (): string[] => {
  const lhs = TMUX_SETTINGS.map(
    (s) => `set ${s.set.padEnd(3)} ${s.name} ${quoteTmuxValue(s.value)}`,
  );
  const width = Math.max(...lhs.map((l) => l.length));
  return TMUX_SETTINGS.map((s, i) => `${(lhs[i] ?? '').padEnd(width)}   # ${s.why}`);
};

export const tmuxConfArtifact = (hangar: Hangar): Artifact => {
  const socket = `hangar-${hangar.id}`;
  return {
    path: hangar.paths.tmuxConf,
    mode: 0o644,
    what: `tmux config for this hangar's own server (tmux -L ${socket})`,
    content: `${[
      artifactHeader(hangar, `tmux config for this hangar's own server: tmux -L ${socket}`, [
        'Read ONCE, when that server starts -- regenerating it reaches nothing already',
        'running, and `hangar doctor` reads the live options back and says so.',
      ]),
      '',
      '# ---- Claude Code inside tmux ------------------------------------------------------',
      '# The reason this hangar runs its own server: two of these are SERVER options, and a',
      '# server option must never be written onto a server somebody else owns.',
      ...claudeCodeSettingLines(),
      '',
      '# ---- whose sessions these are -----------------------------------------------------',
      '# A global session option, so every session on this socket inherits it and there is',
      '# exactly one writer. `open` sets @hangar_clone per session; a session carrying this id',
      '# and no @hangar_clone was made by hand on this socket rather than by hangar.',
      `set -g @hangar_id ${hangar.id}`,
      '',
      '# ---- windows are numbered like the clones -----------------------------------------',
      'set -g  base-index 1',
      'set -gw pane-base-index 1',
      'set -g  renumber-windows on',
      '',
      '# ---- the status line --------------------------------------------------------------',
      '# The bar names its own background, and carries no hue. Both halves matter -- see the',
      '# header: without these four lines tmux draws every clone hue on its own saturated',
      '# green, and a hue in here would paint every clone with whichever was opened last.',
      '#',
      '# So the neutrals are the FLOOR, and a clone lands on top of them: `hangar open` gives',
      "# the session a `status-left` badge in the clone's hue with an ink chosen for it, and the",
      '# shell hook gives the current window the same treatment. Both fall back to exactly these',
      '# values, which is what `set -uw` on the way out restores.',
      `set -g status-style 'bg=${STATUS_BAR_BG},fg=${STATUS_BAR_FG}'`,
      `set -g status-right-style 'fg=${STATUS_BAR_DIM}'`,
      `set -g window-status-style 'fg=${STATUS_BAR_DIM}'`,
      `set -g window-status-current-style 'fg=${STATUS_BAR_FG},bold'`,
      'set -g status-position top',
      // A MAXIMUM, not a width, so headroom costs nothing -- and 40 no longer obviously clears
      // the badge. `status-left` is now `#[fg=…,bg=…,bold] <clone> #[default] `: 39 characters
      // of style markup around the name, where the old unbackgrounded form was 28. Whether tmux
      // measures the expanded string or only what it draws decides whether 40 truncated a
      // ten-character clone name, and nothing readable off the server answers that -- the option
      // holds the format, not the render. So this is set past either reading rather than settled,
      // which leaves room for a clone name of 22 characters on top of the markup.
      'set -g status-left-length 64',
      "set -g status-right '#{?client_prefix,^B ,}%H:%M'",
      "set -g window-status-format ' #I #W '",
      "set -g window-status-current-format ' #I #W '",
      '',
      '# The clone name in the TERMINAL WINDOW title, which is how a developer with one tab per',
      '# clone tells them apart at the level the emulator draws.',
      'set -g set-titles on',
      "set -g set-titles-string '#{@hangar_clone} - #{window_name}'",
      '',
      '# ---- the rest ---------------------------------------------------------------------',
      "set -g default-terminal 'tmux-256color'",
      'set -g escape-time 10',
      'set -g history-limit 50000',
      'set -g focus-events on',
    ].join('\n')}\n`,
  };
};
