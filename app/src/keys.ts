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
 * and `a` is unbound -- tmux's `g` is a plain letter, so `C-g` is free too. `C-h`, `C-i`, `C-j`
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
    does: 'pick a file to open in the editor, a directory for Finder, or the whole clone',
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
    does: "pick a file of the ticket's tmp/<KEY>/ to open, or the folder itself",
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
    does: 'git fetch --all: origin and every sibling clone',
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
