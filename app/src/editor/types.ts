import type { Clone } from '../fleet.ts';
import type { AppWindowOutcome } from '../platform/index.ts';
import type { EditorKind } from './kinds.ts';

/**
 * The editor seam: what Hangar needs from an IDE, and how much of it each one supplies itself.
 *
 * Two jobs, mirroring the terminal seam. Hangar LAUNCHES the editor on a clone, and it keeps one
 * editor SETUP across a fleet whose per-clone paths have to stay per clone.
 *
 * ## The two editors are asymmetric, and it is the editors' doing
 *
 * VS Code needs both jobs done for it. A handful of its settings take an absolute path into the
 * checkout and it resolves them against nothing, so those values must differ per clone -- hence
 * the text transform in `vscode.ts`. And it identifies a workspace by its config file's URI, so
 * a clone's two byte-identical `*.code-workspace` twins are two DIFFERENT workspaces to it, which
 * is why launching has to ask which copy is already open.
 *
 * JetBrains needs neither. It stores project-relative paths as `$PROJECT_DIR$`, so its project
 * files are already clone-portable and there is nothing to rewrite; and it keys a project on its
 * DIRECTORY, so pointing it at a clone that is already open focuses that window by itself.
 *
 * That asymmetry is the whole reason this is a capability record rather than one interface both
 * must satisfy: a JetBrains driver forced to implement `focusExisting` would reimplement, badly,
 * something the IDE already does correctly.
 */
export type { EditorKind } from './kinds.ts';

export type EditorCapabilities = {
  /** Open a clone in this editor at all. */
  readonly launch: boolean;
  /**
   * Hangar has to work out which window already has the clone open, because the editor will not.
   * False does NOT mean duplicate windows -- for JetBrains it means the editor dedupes itself.
   */
  readonly focusExisting: boolean;
  /** Has files worth keeping in step across the fleet -- `<kind> sync` does something. */
  readonly syncArtifacts: boolean;
  /**
   * Some of its settings hold an absolute path into the checkout, so syncing is a text transform
   * rather than a copy. True for VS Code; false for anything with a project-root macro.
   */
  readonly rewritesRootPaths: boolean;
  /**
   * This editor lives INSIDE a terminal, so `open` gives it a tab rather than calling `launch`.
   *
   * True only for terminal vim, and only when no GUI vim is installed. It exists because the
   * alternative is worse in both directions: launching terminal vim as a subprocess would attach
   * it to the tty `hangar` is running on and hold the command hostage, while opening a window
   * from inside the driver would put it somewhere of its own -- this driver knows nothing about
   * the clone's tmux session. Letting `open` add it as one more window in that session is what
   * keeps it beside the clone's configured roles.
   */
  readonly inTerminalTab?: boolean | undefined;
  /**
   * Close the window this clone is open in, from outside the editor.
   *
   * True only for the VS Code family, and only because two things happen to line up: the
   * generated `*.code-workspace` puts the clone's name at the front of `window.title`, so a
   * window can be NAMED from outside, and `platform.closeAppWindow` can press that window's own
   * close button. Both halves are needed, which is why this is a capability rather than a method
   * every driver has to answer for.
   *
   * **There is deliberately no `reloadWindow` beside it**, and that is measured rather than
   * unfinished. `workbench.action.reloadWindow` is registered with
   * `keybinding:{weight:250,when:isDevelopment,primary:Cmd+R}` in the shipped bundle -- the
   * when-clause means a release build has NO default keybinding for it -- so the only route left
   * is typing into the command palette, which is a fuzzy text search rather than an interface: a
   * near-miss runs whichever command the palette ranked first, in the developer's editor. VS Code
   * applies a workspace settings change live anyway, so `hangar reload` rewrites the artifacts
   * and names the gesture instead.
   */
  readonly closeWindow: boolean;
};

/**
 * One file (or one set of byte-identical copies of it) that `<kind> sync` keeps in step.
 *
 * Named `EditorArtifact` rather than `VscodeArtifact` now that JetBrains uses the same record:
 * the engine in `commands/vscode.ts` is generic, and what differs between the two editors is
 * whether `rootKeys` is empty and whether `cloneValues` is set -- with neither,
 * `templatize`/`render` is an identity transform, so the same code path serves both without a
 * branch.
 */
export type EditorArtifact = {
  readonly id: string;
  /**
   * Whether git versions this file, DECLARED.
   *
   * A tracked file is not ours to write: it belongs to whatever branch the clone has checked
   * out, and rewriting it dirties that branch and can end up committed. This flag is a FLOOR,
   * never a verdict -- `isTracked` below may add protection, and must never remove it. A purely
   * dynamic `git ls-files` test would make the protection conditional on the checked-out branch,
   * so a branch that happens not to track `launch.json` would let `ide vscode sync` push one
   * branch's copy into a sibling, which is the exact failure this flag exists to prevent.
   */
  readonly tracked: boolean;
  /** Every copy of this file in a clone. They are byte-identical; the first is canonical. */
  readonly copies: (clone: Clone) => readonly string[];
  /** Setting key -> the path, relative to the clone root, its absolute value must point at. */
  readonly rootKeys: Readonly<Record<string, string>>;
  /** Whether the file carries the `"<index>: <id>"` workspace folder label. */
  readonly indexLabel: boolean;
  /**
   * Whether the file carries the per-clone settings in `workspaceCloneValues`.
   *
   * Those are the clone's name and its hue, so a sync that copied them verbatim would give every
   * clone the source clone's identity -- which is the whole thing the fleet's colours exist to
   * prevent. Tokenised by key on the way out and rebuilt from the builder on the way in, so a
   * sync repairs them rather than spreading one.
   */
  readonly cloneValues: boolean;
};

export type EditorDriver = {
  readonly kind: EditorKind;
  /** How to name it to the user: `VS Code`, `IntelliJ IDEA`, … */
  readonly label: string;
  readonly capabilities: EditorCapabilities;
  /** Whether it can be launched right now, i.e. its command-line launcher was found. */
  readonly isAvailable: () => boolean;
  /** Why not, for the error message. Only consulted when `isAvailable` is false. */
  readonly unavailableHint: () => string;
  /**
   * Open the clone. Reports what it did so the caller can say so, or `undefined` when it
   * declined -- a missing workspace file, a launcher that failed.
   */
  readonly launch: (clone: Clone) => LaunchResult | undefined;
  /**
   * Close the window this clone is open in. Only called when `capabilities.closeWindow`.
   *
   * Returns the platform's own outcome unchanged, because every arm of it has something
   * different to tell the developer -- a permission to grant, a window that was never open, an
   * editor that is not running -- and a driver flattening that to a boolean would throw away the
   * only part worth printing.
   */
  readonly closeWindow?: ((clone: Clone) => AppWindowOutcome) | undefined;
  /** What `<kind> sync` keeps in step. Empty when `syncArtifacts` is false. */
  readonly artifacts: readonly EditorArtifact[];
  /** The command a terminal-resident editor runs in its tab. Only read when `inTerminalTab`. */
  readonly terminalCommand?: string | undefined;
};

export type LaunchResult = {
  /** What was handed to the editor -- a workspace file, or the clone directory. */
  readonly target: string;
  /** True when an already-open window was focused rather than a new one created. */
  readonly reused: boolean;
  /** Set when the editor was asked but said something worth passing on. */
  readonly note?: string | undefined;
};
