/**
 * The hangar's keys: every `C-b <key>` a clone's tmux session binds, in one table.
 *
 * **One table, several readers.** `generate/tmux-conf.ts` renders it into `clone-tmux.conf` and
 * `TmuxServer.restyle` issues the same bindings onto a server already running; `hangar key help`
 * (`C-b C-k`) prints it. A key in only one of them is a key the help lies about, or one that works
 * on half the fleet.
 *
 * **Every key is in tmux's prefix table and takes nothing tmux binds there.** Measured with
 * `list-keys -T prefix` on 3.7c and 3.8: the Ctrl letters tmux binds are `C-b`, `C-o` and `C-z`,
 * and `a` and `P` are unbound -- tmux's `g` is a plain letter, so `C-g` is free too, and its `p`
 * is not `P`. `C-h`, `C-i`, `C-j`
 * and `C-m` are never used: a terminal sends them as the Backspace, Tab, line feed and Enter
 * bytes, so tmux cannot tell them apart. `C-?` is the same byte as Backspace, which is why help
 * is `C-k` and tmux's own `C-b ?` stays tmux's.
 *
 * Pure: no hangar, no paths. The binding needs `bin/hangar`'s absolute path, so it is built in
 * `generate/tmux-conf.ts`.
 */

/**
 * How a key runs its command.
 *
 * - `report`: in the background, with both streams discarded; the answer is one line on the bar.
 *   A command that reports by itself (every `hangar key …` action) leaves the success branch
 *   empty; one that does not names a line for it in `ok`.
 * - `popup`: in a tmux popup over the pane, for anything that asks -- a picker, or a table that
 *   stays until a key is pressed.
 */
export type KeyRun = 'report' | 'popup';

export type HangarKey = {
  /** The key after the prefix, as tmux spells it. */
  readonly key: string;
  /** What it does, for the help table. */
  readonly does: string;
  /** The `hangar` words before the clone, which is always the last argument. */
  readonly argv: readonly string[];
  readonly run: KeyRun;
  /** The bar's line on success, for a `report` command that does not report by itself. */
  readonly ok?: string;
  /** The bar's line on failure, for a `report` command that does not report by itself. */
  readonly fail?: string;
  /**
   * The VS Code extension's command for the same key, when VS Code gets it. Its chord there is
   * the tmux one, `ctrl+b` and the same second key, so a hand that knows one knows the other.
   */
  readonly vscode?: string;
};

/** Every hangar key, in the order the help table lists them. */
export const KEY_TABLE: readonly HangarKey[] = [
  {
    key: 'C-e',
    does: 'pick a file to open in VS Code, a directory to show in its Explorer, or the clone',
    argv: ['key', 'edit'],
    run: 'popup',
  },
  {
    key: 'C-f',
    does: "open the ticket's folder under tmp/ in the file manager",
    argv: ['browse', 'tmp'],
    run: 'report',
    ok: 'opened the ticket folder for #{@hangar_clone}',
    fail: 'no ticket folder for #{@hangar_clone} -- run hangar browse tmp in a shell to see why',
  },
  {
    key: 'C-t',
    does: "pick a file of the ticket's tmp/<KEY>/ to open in VS Code, or show the folder",
    argv: ['key', 'ticket'],
    run: 'popup',
    vscode: 'hangar.ticket',
  },
  {
    key: 'C-p',
    does: "open this clone's plan, or pick one when there are several",
    argv: ['key', 'plan'],
    run: 'popup',
    vscode: 'hangar.plan',
  },
  {
    key: 'C-n',
    does: 'run a script in its own window, or toggle a dev server (`runner` in the config)',
    argv: ['key', 'run'],
    run: 'popup',
    vscode: 'hangar.run',
  },
  {
    key: 'a',
    does: 'git fetch origin',
    argv: ['key', 'fetch'],
    run: 'report',
    vscode: 'hangar.fetch',
  },
  {
    key: 'C-a',
    does: 'git fetch origin and every sibling clone, each by name',
    argv: ['key', 'fetch', '--all'],
    run: 'report',
    vscode: 'hangar.fetchAll',
  },
  {
    key: 'C-g',
    does: 'commit gate: arm or disarm on the default branch, lock or release on a branch',
    argv: ['key', 'gate'],
    run: 'report',
    vscode: 'hangar.gate',
  },
  {
    key: 'P',
    does: 'command palette: every hangar key and report, fuzzy-searched',
    argv: ['key', 'palette'],
    run: 'popup',
  },
  { key: 'C-k', does: 'show this table', argv: ['key', 'help'], run: 'popup' },
];

/**
 * Keys this table has stopped binding, which `restyle` unbinds on a running server.
 *
 * A binding outlives the conf that made it: `restyle` writes bindings onto a live server and
 * nothing else ever takes one away, so a key dropped from `KEY_TABLE` would keep running its old
 * command on every server until `kill-server` -- which ends every live agent in the fleet.
 * Unbinding a key that is not bound is a no-op, measured on 3.8.
 */
export const RETIRED_KEYS: readonly string[] = ['v'];

/** `C-e` as `C-b C-e`, `a` as `C-b a`: how a person reads the chord. Pure. */
export const chordName = (key: string): string => `C-b ${key}`;

/** The help table `C-b C-k` shows, one key per line. Pure. */
export const keyHelpLines = (table: readonly HangarKey[]): string[] => {
  const width = Math.max(...table.map((k) => chordName(k.key).length));
  return [
    'hangar keys in this clone',
    '',
    ...table.map((k) => `  ${chordName(k.key).padEnd(width)}   ${k.does}`),
    '',
    "tmux's own keys stay where they are: C-b ? lists them.",
  ];
};

// ---- the palette: C-b P -----------------------------------------------------------------------

/**
 * A command the palette offers that has no key of its own.
 *
 * **Only reports, and commands as harmless as a key.** Nothing that moves a working tree, starts
 * or kills a server, or ends a session is here: those stay typed, where a person reads the line
 * before pressing Enter. `test/keys-palette.test.ts` holds each row to an MCP exposure that does
 * not act, or names why it may.
 */
export type PaletteCommand = {
  readonly does: string;
  readonly argv: readonly string[];
  /** Whether the clone is appended -- a fleet-level command takes none. */
  readonly clone: boolean;
  /** Whether the popup waits for a key afterwards, so a table stays readable. */
  readonly waits: boolean;
};

export const PALETTE_ONLY: readonly PaletteCommand[] = [
  { does: 'status of this clone', argv: ['status'], clone: true, waits: true },
  { does: 'the port map of every clone', argv: ['ports'], clone: false, waits: true },
  { does: 'dev servers of every clone', argv: ['servers', 'list'], clone: false, waits: true },
  {
    does: "open the branch's pull request in the browser",
    argv: ['browse', 'pr'],
    clone: true,
    waits: false,
  },
  {
    does: "open the branch's ticket in the browser",
    argv: ['browse', 'ticket'],
    clone: true,
    waits: false,
  },
  {
    does: "refresh the bar's pull-request record",
    argv: ['pr', 'refresh'],
    clone: true,
    waits: true,
  },
  {
    does: "merge the clones' shared tmp/ entries",
    argv: ['tmp', 'merge'],
    clone: false,
    waits: true,
  },
  { does: 'check this clone, changing nothing', argv: ['doctor'], clone: true, waits: true },
];

/** One row of the palette: its line, and what choosing it runs. */
export type PaletteRow = {
  readonly label: string;
  /** The `hangar` words, without the clone. */
  readonly argv: readonly string[];
  readonly clone: boolean;
  readonly waits: boolean;
  /** A `report` key's own bar lines, which the palette prints from the exit status. */
  readonly ok?: string | undefined;
  readonly fail?: string | undefined;
};

/**
 * The palette's rows: every key but the palette itself, then every `PALETTE_ONLY` command. PURE.
 *
 * The chord or the command comes FIRST, padded to one width, so a narrow popup cuts the prose and
 * never the part a person learns from -- and fzf matches both, so `C-g`, `gate` and `ports` all
 * find their row.
 */
export const paletteRows = (
  table: readonly HangarKey[],
  only: readonly PaletteCommand[],
): PaletteRow[] => {
  const rows = [
    ...table
      .filter((k) => k.argv.join(' ') !== 'key palette')
      .map((k) => ({
        short: chordName(k.key),
        does: k.does,
        argv: k.argv,
        clone: true,
        waits: false,
        ok: k.ok,
        fail: k.fail,
      })),
    ...only.map((c) => ({ short: `hangar ${c.argv.join(' ')}`, ...c })),
  ];
  const width = Math.max(...rows.map((r) => r.short.length));
  return rows.map(({ short, does, ...row }) => ({
    label: `${short.padEnd(width)}   ${does}`,
    ...row,
  }));
};

// ---- the same keys in VS Code (macOS) -------------------------------------------------------

/**
 * A key the VS Code extension binds that tmux has no counterpart for: both hand a file reference
 * to the clone's Claude Code, which only an editor has to give.
 */
export type VscodeOnlyKey = {
  readonly chord: string;
  readonly command: string;
  readonly when: string;
  readonly does: string;
};

export const VSCODE_ONLY_KEYS: readonly VscodeOnlyKey[] = [
  {
    chord: 'ctrl+k ctrl+k',
    command: 'hangar.ref',
    when: 'editorTextFocus',
    does: "paste @<file>#<lines> of the selection into the clone's Claude Code",
  },
  {
    chord: 'ctrl+k ctrl+k',
    command: 'hangar.refExplorer',
    when: 'filesExplorerFocus && !inputFocus',
    does: "paste @<file> of each selected file into the clone's Claude Code",
  },
  {
    chord: 'ctrl+b ctrl+s',
    command: 'hangar.selectionCommand',
    when: 'editorTextFocus',
    does: "paste `keys.selectionCommand` with the selection's @<file>#<lines> filled in",
  },
];

/** tmux's `C-g` as VS Code's `ctrl+g`; a plain letter is the same in both. PURE. */
export const vscodeKeyName = (tmuxKey: string): string =>
  tmuxKey.startsWith('C-') ? `ctrl+${tmuxKey.slice(2)}` : tmuxKey;

export type VscodeKeybinding = {
  readonly command: string;
  readonly key: string;
  readonly when: string;
};

/**
 * The extension manifest's `keybindings`, from the table. PURE.
 *
 * **macOS only, by `isMac` in every `when`**, which leaves the chords inert anywhere else. On
 * macOS VS Code binds `ctrl+b` (cursor left, as a second key beside the arrow) and `ctrl+k`
 * (delete to the end of the line) while text has focus -- read from VS Code 1.145's own bundle --
 * and both chords take those away in the editor. That was decided, not missed.
 */
export const vscodeKeybindings = (
  table: readonly HangarKey[],
  only: readonly VscodeOnlyKey[],
): VscodeKeybinding[] => [
  ...table.flatMap((entry) =>
    entry.vscode === undefined
      ? []
      : [{ command: entry.vscode, key: `ctrl+b ${vscodeKeyName(entry.key)}`, when: 'isMac' }],
  ),
  ...only.map((k) => ({ command: k.command, key: k.chord, when: `isMac && ${k.when}` })),
];
