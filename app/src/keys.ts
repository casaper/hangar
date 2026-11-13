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
    vscode: 'hangar.ticketFolder',
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
 * A command the palette offers that has no key of its own, built into every hangar.
 *
 * **Reports, plus two acting rows named by `acts`.** A report is what an MCP exposure that does
 * not act would be (`test/keys-palette.test.ts` holds each to one). The two that act are the
 * person's own, chosen from a list rather than typed: opening or rewriting this branch's pull
 * request, and reloading this clone. Nothing else that moves a tree, a server or a session is
 * here -- those stay typed, where the line is read before Enter.
 */
export type PaletteCommand = {
  /** What `--entry` and the VS Code command id (`hangar.palette.<name>`) call it. */
  readonly name: string;
  readonly does: string;
  readonly argv: readonly string[];
  /** Whether the clone is appended -- a fleet-level command takes none. */
  readonly clone: boolean;
  /** Whether the popup waits for a key afterwards, so a table stays readable. */
  readonly waits: boolean;
  readonly acts: boolean;
  /** How VS Code shows the answer: the whole output in its Hangar channel, or the first line. */
  readonly vscode: 'output' | 'line';
};

const report = (
  name: string,
  does: string,
  argv: readonly string[],
  clone: boolean,
  vscode: 'output' | 'line' = 'output',
): PaletteCommand => ({ name, does, argv, clone, waits: vscode === 'output', acts: false, vscode });

export const PALETTE_ONLY: readonly PaletteCommand[] = [
  report('status', 'status of this clone', ['status'], true),
  report('ports', 'the port map of every clone', ['ports'], false),
  report('servers', 'dev servers of every clone', ['servers', 'list'], false),
  report(
    'browse-pr',
    "open the branch's pull request in the browser",
    ['browse', 'pr'],
    true,
    'line',
  ),
  report(
    'browse-ticket',
    "open the branch's ticket in the browser",
    ['browse', 'ticket'],
    true,
    'line',
  ),
  report('pr-refresh', "refresh the bar's pull-request record", ['pr', 'refresh'], true),
  report('tmp-merge', "merge the clones' shared tmp/ entries", ['tmp', 'merge'], false),
  report('doctor', 'check this clone, changing nothing', ['doctor'], true),
  {
    name: 'update-pr',
    does: "open this branch's pull request, or rewrite the one it has (no confirmation)",
    argv: ['key', 'pr'],
    clone: true,
    waits: true,
    acts: true,
    vscode: 'output',
  },
  {
    name: 'hangar-reload',
    does: "reload this clone's tmux session: idle shells and Claude Code restarted (no confirmation)",
    argv: ['reload', '-y'],
    clone: true,
    waits: false,
    acts: true,
    vscode: 'line',
  },
];

/**
 * A palette entry from `keys.palette` in the config: a prompt for Claude Code.
 *
 * Config and never built in, because a prompt names a skill and a skill's name is one repo's
 * business (`forge.prDescriptionPrompt`'s rule). `session` pastes it into the clone's running
 * Claude Code and submits it; `background` runs it as a headless `claude -p` that ends by itself.
 */
export type PaletteEntry = {
  readonly name: string;
  readonly does?: string | undefined;
  readonly run: 'session' | 'background';
  readonly prompt: string;
  readonly allowedTools?: readonly string[] | undefined;
  readonly timeoutMinutes?: number | undefined;
};

/** The tools a `background` entry may use unasked when it names none. */
export const DEFAULT_BACKGROUND_TOOLS: readonly string[] = [
  'Read',
  'Edit',
  'Write',
  'Grep',
  'Glob',
  'Agent',
];

/** What an entry needs from the editor, read off its tokens. PURE. */
export const paletteNeeds = (prompt: string): 'lines' | 'files' | 'nothing' =>
  prompt.includes('{ref}') ? 'lines' : prompt.includes('{file}') ? 'files' : 'nothing';

/**
 * What VS Code had selected: the active editor's reference, and the Explorer's selected paths.
 *
 * `editor` is the extension's own `refFor` string -- `@<abs>#<a>-<b>` for selected lines, the bare
 * `@<abs>` for a cursor -- so the format has one implementation, and "are there lines" is whether
 * it carries a `#`. A record of start and end lines could not tell an empty cursor from one whole
 * selected line.
 */
export type IdeSelection = {
  readonly editor?: string | undefined;
  readonly explorer: readonly string[];
};

/** The prompt an entry sends, or the sentence that says why it cannot. PURE. */
export const promptFor = (
  prompt: string,
  selection: IdeSelection,
): { readonly text: string } | { readonly refuse: string } => {
  const needs = paletteNeeds(prompt);
  if (needs === 'nothing') return { text: prompt };
  if (needs === 'lines') {
    if (selection.editor === undefined) return { refuse: 'no file is open in VS Code' };
    if (!selection.editor.includes('#')) {
      return { refuse: 'select lines in VS Code first -- the cursor alone names only the file' };
    }
    return { text: prompt.replaceAll('{ref}', selection.editor) };
  }
  const files =
    selection.explorer.length > 0
      ? selection.explorer.map((path) => `@${path}`)
      : selection.editor === undefined
        ? []
        : [selection.editor.replace(/#.*$/, '')];
  if (files.length === 0) return { refuse: 'no file is open or selected in VS Code' };
  return { text: prompt.replaceAll('{file}', files.join(' ')) };
};

/** One row of the palette: its line, and what choosing it runs. */
export type PaletteRow =
  | {
      readonly kind: 'command';
      readonly label: string;
      /** The `hangar` words, without the clone. */
      readonly argv: readonly string[];
      readonly clone: boolean;
      readonly waits: boolean;
      /** A `report` key's own bar lines, which the palette prints from the exit status. */
      readonly ok?: string | undefined;
      readonly fail?: string | undefined;
      readonly name?: string | undefined;
    }
  | { readonly kind: 'entry'; readonly label: string; readonly entry: PaletteEntry };

/**
 * The palette's rows: every key but the palette itself, every `PALETTE_ONLY` command, then the
 * config's entries. PURE.
 *
 * The chord, the command or the name comes FIRST, padded to one width, so a narrow popup cuts the
 * prose and never the part a person learns from -- and fzf matches both, so `C-g`, `gate` and
 * `ports` all find their row. A report shows the `hangar` line it runs; a row that acts shows its
 * name, because the line it runs is not one a person would type.
 */
export const paletteRows = (
  table: readonly HangarKey[],
  only: readonly PaletteCommand[],
  entries: readonly PaletteEntry[],
): PaletteRow[] => {
  type Draft = { short: string; does: string; row: (label: string) => PaletteRow };
  const drafts: Draft[] = [
    ...table
      .filter((k) => k.argv.join(' ') !== 'key palette')
      .map((k) => ({
        short: chordName(k.key),
        does: k.does,
        row: (label: string): PaletteRow => ({
          kind: 'command',
          label,
          argv: k.argv,
          clone: true,
          waits: false,
          ok: k.ok,
          fail: k.fail,
        }),
      })),
    ...only.map((c) => ({
      short: c.acts ? c.name : `hangar ${c.argv.join(' ')}`,
      does: c.does,
      row: (label: string): PaletteRow => ({
        kind: 'command',
        label,
        argv: c.argv,
        clone: c.clone,
        waits: c.waits,
        name: c.name,
      }),
    })),
    ...entries.map((e) => ({
      short: e.name,
      does: e.does ?? (e.run === 'background' ? `${e.prompt} (in the background)` : e.prompt),
      row: (label: string): PaletteRow => ({ kind: 'entry', label, entry: e }),
    })),
  ];
  const width = Math.max(...drafts.map((d) => d.short.length));
  return drafts.map((d) => d.row(`${d.short.padEnd(width)}   ${d.does}`));
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
