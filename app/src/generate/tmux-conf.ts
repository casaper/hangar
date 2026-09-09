import type { Hangar } from '../hangar.ts';
import { STATUS_BAR_BG, STATUS_BAR_DIM, STATUS_BAR_FG, STATUS_LEFT_LENGTH } from '../palette.ts';
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

/**
 * A global session option: renderable into the conf, and writable onto a live server.
 *
 * Shared with `generate/claude-tmux-conf.ts`, which renders the same shape for the other server.
 */
export type BarOption = { readonly name: string; readonly value: string };

/** The two clickable regions, and the `hangar-` prefix that keeps them ours. See `barOptions`. */
const TICKET_RANGE = 'hangar-ticket';
const PR_RANGE = 'hangar-pr';

/**
 * How often tmux re-runs the three `#()` jobs below.
 *
 * tmux's own default is 15. Ten is chosen against what the line REPORTS rather than against
 * cost: a branch changes under a developer who is watching, and half a minute of a bar naming
 * the branch they just left is the kind of wrong that gets believed. Three `sh` forks per
 * attached client per interval, each one shell plus git at 0.02-0.04s measured -- which is also
 * why the refresh calls a generated script and never `hangar` itself, at 0.24-0.28s.
 */
const STATUS_INTERVAL = 10;

/**
 * The status bar and the branch line, as data.
 *
 * **Every entry is a global SESSION or WINDOW option, deliberately**, and that is what makes the
 * live-apply pass in `TmuxServer.restyle` possible: `-f` is read once when the server starts, so
 * an option that lived only in this file would reach nobody who is working right now -- and
 * `doctor --fix` refuses `kill-server`, because that ends every live agent in the fleet. A SERVER
 * option in here would be a setting `colours sync` could write into the conf and never onto a
 * running server, with nothing to say which had happened.
 *
 * One table, two consumers, and it has to stay one: a list of globals written out in `restyle`
 * beside the formats written out here would be two half-copies of the same thing, which is the
 * drift this repo keeps finding. The symptom is a bar that is right on a fresh server and a
 * version behind on the one somebody is working in.
 *
 * `status-left` is NOT here. It is the clone's own hue badge, written per SESSION by
 * `paintSession`, and a global would have whichever clone was opened last colour every bar.
 *
 * ## What the three `#()` jobs are, and why the clone comes from the session tag
 *
 * `#{@hangar_clone}` is expanded into the command TEXT, not read by the script from a pane's
 * working directory. Two reasons, and the second is a correctness bug rather than a preference:
 *
 * - Identity is the session, which is this module's oldest rule. A pane that has been `cd`d out
 *   of the clone is still that clone's pane, and `#{pane_current_path}` would have it report
 *   nothing -- or, standing in a sibling clone, report the sibling's branch.
 * - **A tmux job is keyed on the EXPANDED command**, so two sessions whose formats expand to the
 *   same shell command share one job and one answer. Measured on 3.7c: with the clone name in
 *   the text, `clone_01` and `clone_02` rendered their own branches at the same moment on one
 *   server. Without something session-specific in there, every bar in the fleet would show
 *   whichever clone's job ran first.
 */
export const barOptions = (hangar: Hangar): readonly BarOption[] => {
  const script = hangar.paths.tmuxStatusScript;
  // Double quotes around the format, never single: the whole value is single-quoted on the way
  // into the conf, and tmux processes no escapes inside single quotes -- so one `'` in here would
  // end the option's value and leave the rest of the line as garbage tmux does not complain
  // about. Verified expanding inside `#()` either way.
  const job = (field: string): string => `#(${script} ${field} "#{@hangar_clone}")`;
  return [
    { name: 'status', value: 'on' },
    { name: 'status-position', value: 'top' },
    { name: 'status-style', value: `bg=${STATUS_BAR_BG},fg=${STATUS_BAR_FG}` },
    { name: 'status-right-style', value: `fg=${STATUS_BAR_DIM}` },
    { name: 'window-status-style', value: `fg=${STATUS_BAR_DIM}` },
    { name: 'window-status-current-style', value: `fg=${STATUS_BAR_FG},bold` },
    { name: 'status-left-length', value: String(STATUS_LEFT_LENGTH) },
    { name: 'status-interval', value: String(STATUS_INTERVAL) },
    /*
     * The ticket and the pull request, each in its own clickable range, then the prefix
     * indicator and the clock.
     *
     * The ranges are what makes them clickable AT ALL: tmux 3.7c has no hyperlink style, and a
     * literal OSC 8 sequence in a status format is drawn as visible garbage with the ESC
     * stripped (measured, and `capture-pane -H` finds no hyperlink) -- so `range=user` plus a
     * mouse binding is the mechanism rather than a fallback. They are also status-line-only:
     * `#[range=…]` in `pane-border-format` is accepted and silently does nothing, which is why
     * the two short clickable facts are up here and the long branch is on the border.
     *
     * Each job prints its own surrounding space, or nothing at all -- so a clone with no ticket
     * key gets a shorter bar rather than a gap, and an empty range is unclickable because there
     * is nothing of it to click.
     */
    {
      name: 'status-right',
      value:
        `#[range=user|${TICKET_RANGE}]${job('ticket')}#[norange]` +
        `#[range=user|${PR_RANGE}]${job('pr')}#[norange]` +
        `#{?client_prefix,^B ,}%H:%M`,
    },
    /*
     * A MAXIMUM like `status-left-length`, not a width, so headroom is free. The widest right
     * side this can render is a twelve-character key and a five-digit pull request:
     * ` ABCDEF-12345  PR#12345 ^B 12:34` -- 32 columns, which is also why tmux's own default of
     * 40 is not simply left alone: it is close enough that a longer key shape would truncate
     * with nothing to say so.
     */
    { name: 'status-right-length', value: '48' },
    { name: 'window-status-format', value: ' #I #W ' },
    { name: 'window-status-current-format', value: ' #I #W ' },
    /*
     * The branch, on the pane border at the BOTTOM of the window.
     *
     * Not a second status line: `status-position` is one option for the whole status block, so
     * `status 2` puts both lines at the top and a header-plus-footer is unreachable. The pane
     * border is the only bottom line tmux has, and it renders with a single pane -- measured.
     *
     * `#{?pane_active,…,}` because a split window draws one border line per pane, and the extra
     * copies would each carry the same branch. Nothing is drawn for the others, so they keep a
     * plain border. No comma may appear inside either arm: `#{?…}` splits on the first one, so a
     * two-part style like `bg=x,fg=y` would cut the format in half.
     *
     * The style is explicit rather than inherited. The shell hook paints `pane-border-style`
     * with the clone's hue at full strength, and that hue is chosen to read on the status bar's
     * background rather than on the terminal's -- so inheriting it would put an unmeasured pair
     * on screen.
     */
    { name: 'pane-border-status', value: 'bottom' },
    {
      name: 'pane-border-format',
      value: `#{?pane_active,#[fg=${STATUS_BAR_FG}]${job('branch')}#[default],}`,
    },
  ];
};

/**
 * `bind-key -T root MouseDown1Status …` -- one binding, as argv, for the conf and for `restyle`.
 *
 * A key binding is not an option, so it is the one part of the bar the live-apply pass has to
 * issue as a command rather than write as a value. It is listed beside the table for that reason
 * instead of hiding in it.
 *
 * **The fall-through is the whole shape of it.** tmux's own default for this key is
 * `switch-client -t =` -- click a tab, go to that window -- and a bare rebinding would take that
 * away from every window in the fleet to add a link. So the condition tests for OUR ranges by
 * their `hangar-` prefix and the else branch is tmux's default, restated. `#{m:…}` is a glob
 * match and `#{s/hangar-//:…}` strips the prefix, so the range name IS the argument and there is
 * no table mapping one to the other.
 *
 * It calls `hangar` and not the generated script, which is the one place in this feature that
 * can afford to: a click is a human action once in a while, so a quarter of a second of Node
 * startup is free, and the URLs come from `issueUrl`/`prSearchUrl` in TypeScript rather than
 * being re-derived in shell. `bin/hangar` by ABSOLUTE path -- tmux's `run-shell` inherits the
 * server's environment, which is whatever shell started it and need not have direnv's PATH.
 */
export const statusClickBinding = (hangar: Hangar): readonly string[] => [
  'bind-key',
  '-T',
  'root',
  'MouseDown1Status',
  'if-shell',
  '-F',
  '#{m:hangar-*,#{mouse_status_range}}',
  `run-shell -b "${hangar.paths.bin} browse #{s/hangar-//:mouse_status_range} #{@hangar_clone}"`,
  'switch-client -t =',
];

/**
 * One `bind-key` argv as a line of conf, quoting each word the way `set` values are quoted.
 *
 * The binding is argv rather than a string because `restyle` hands it straight to tmux, where
 * quoting would be part of the argument. Rendering is therefore the derived form, not the
 * source -- the other direction would need the conf line parsed back apart.
 */
const renderBinding = (argv: readonly string[]): string => argv.map(quoteTmuxValue).join(' ');

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
      '# ---- the status line, and the branch line under it --------------------------------',
      '# The bar names its own background, and carries no hue. Both halves matter -- see the',
      '# header: without a `status-style` tmux draws every clone hue on its own saturated',
      '# green, and a hue in here would paint every clone with whichever was opened last.',
      '#',
      '# So the neutrals are the FLOOR, and a clone lands on top of them: `hangar open` gives',
      "# the session a `status-left` badge in the clone's hue with an ink chosen for it, and the",
      '# shell hook gives the current window the same treatment. Both fall back to exactly these',
      '# values, which is what `set -uw` on the way out restores.',
      '#',
      '# Every line below is a global session or window option, which is what lets',
      '# `hangar colours sync` write the same table onto a server that is already running --',
      '# this file reaches only servers that start after it is written.',
      ...barOptions(hangar).map((o) => `set -g ${o.name} ${quoteTmuxValue(o.value)}`),
      '',
      '# A click on the ticket or the pull request opens it; a click anywhere else on the bar',
      '# still switches to that window, which is what tmux binds this key to by default.',
      renderBinding(statusClickBinding(hangar)),
      '',
      '# The clone name in the TERMINAL WINDOW title, which is how a developer with one tab per',
      '# clone tells them apart at the level the emulator draws. A window name is the role alone,',
      '# so this and the hue badge are the two places the clone is named.',
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
