import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { home } from './paths.ts';

/**
 * The external programs Hangar depends on, and the ones it merely wants.
 *
 * Derived at the moment it is reported -- never cached, never written to a file. A recorded
 * "you have ripgrep" is wrong the moment someone uninstalls it, and the whole value of this
 * check is being true right now.
 */

export type ToolKind = 'required' | 'preferred';

export type Tool = {
  /** How a human refers to it -- also the Homebrew formula name. */
  readonly name: string;
  /**
   * The executable to look for, when it differs from `name`. ripgrep installs `rg`, and
   * ripgrep-all installs `rga` -- checking the formula name reports both as missing on a
   * machine that has them.
   */
  readonly bin?: string;
  readonly kind: ToolKind;
  /** Why Hangar wants it, in one clause. Printed beside a miss, so it must earn the line. */
  readonly why: string;
  readonly install: string;
  /** Present when the program is not a plain binary on PATH (nvm is a shell function). */
  readonly detect?: () => boolean;
};

/**
 * nvm is a shell FUNCTION sourced into the shell, not an executable, so `command -v nvm`
 * never finds it however correctly it is installed. Test for its script instead. The app
 * repo's own `.envrc.base` gets this wrong and so always falls through to fnm.
 */
const nvmPresent = (): boolean => {
  const dir = process.env['NVM_DIR'] ?? join(home, '.nvm');
  return existsSync(join(dir, 'nvm.sh'));
};

/**
 * Is this program executable on PATH?
 *
 * Walks PATH in-process rather than spawning `command -v` ten times: the whole report is
 * rendered on `setup` and on every `doctor`, and ten spawns is most of that runtime. It also
 * keeps a tool name out of a shell string entirely.
 */
const onPath = (name: string): boolean => {
  const path = process.env['PATH'];
  if (path === undefined || path === '') return false;
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not here, or not executable -- keep looking.
    }
  }
  return false;
};

export const TOOLS: readonly Tool[] = Object.freeze([
  {
    name: 'git',
    kind: 'required',
    why: 'every clone is a git checkout, and sibling remotes are how commits move between them',
    install: 'brew install git',
  },
  {
    name: 'direnv',
    kind: 'required',
    why: 'the only thing that puts this hangar’s own `hangar` on PATH, and loads each clone’s ports',
    install:
      'brew install direnv   # then hook it into your shell: https://direnv.net/docs/hook.html',
  },
  {
    name: 'jq',
    kind: 'required',
    why: 'reads Claude Code settings and session transcripts, which are JSON',
    install: 'brew install jq',
  },
  {
    name: 'yq',
    kind: 'required',
    why: 'reads hangar.config.yaml from shell contexts that cannot start Node (the statusline)',
    install: 'brew install yq',
  },
  {
    name: 'ripgrep',
    bin: 'rg',
    kind: 'preferred',
    why: 'faster than grep with a stronger regex engine; `hangar teach-rg` points agents at it',
    install: 'brew install ripgrep',
  },
  {
    name: 'ripgrep-all',
    bin: 'rga',
    kind: 'preferred',
    why: 'searches inside PDFs and archives, which plain rg skips',
    install: 'brew install ripgrep-all',
  },
  {
    name: 'tree',
    kind: 'preferred',
    why: 'the cheapest way to show an agent a directory shape',
    install: 'brew install tree',
  },
  {
    name: 'git-lfs',
    kind: 'preferred',
    why: 'repos with large binary assets need it, and a missing filter corrupts checkouts silently',
    install: 'brew install git-lfs && git lfs install',
  },
  {
    name: 'git-extras',
    kind: 'preferred',
    why: 'adds git summary / git effort / git delete-branch, used when comparing clones',
    install: 'brew install git-extras',
  },
  {
    name: 'git-filter-repo',
    kind: 'preferred',
    why: 'the only safe way to rewrite history, e.g. when extracting a hangar into its own repo',
    install: 'brew install git-filter-repo',
  },
]);

/** Either fnm or nvm satisfies the Node-manager requirement; fnm is the supported one. */
export const NODE_MANAGERS: readonly Tool[] = Object.freeze([
  {
    name: 'fnm',
    kind: 'required',
    why: 'resolves the .nvmrc Node version per directory (preferred: faster, and a real binary)',
    install: 'brew install fnm',
  },
  {
    name: 'nvm',
    kind: 'required',
    why: 'alternative Node version manager',
    install: 'brew install nvm',
    detect: nvmPresent,
  },
]);

export type ToolStatus = { readonly tool: Tool; readonly present: boolean };

export const toolPresent = (tool: Tool): boolean =>
  tool.detect === undefined ? onPath(tool.bin ?? tool.name) : tool.detect();

export type EnvironmentReport = {
  readonly statuses: readonly ToolStatus[];
  /** Exactly one row for the fnm-or-nvm requirement, naming whichever was found. */
  readonly nodeManager: {
    readonly found: string | undefined;
    readonly candidates: readonly string[];
  };
  /** macOS only. Hangar needs Homebrew there for the GNU userland and every install hint. */
  readonly homebrew: {
    readonly needed: boolean;
    readonly present: boolean;
    readonly prefix: string;
  };
  readonly missingRequired: readonly string[];
  readonly missingPreferred: readonly string[];
};

/** Inspect the machine. Pure with respect to Hangar's own state -- it only reads the system. */
export const inspectEnvironment = (): EnvironmentReport => {
  const statuses = TOOLS.map((tool) => ({ tool, present: toolPresent(tool) }));

  const found = NODE_MANAGERS.find((m) => toolPresent(m));
  const nodeManager = {
    found: found?.name,
    candidates: NODE_MANAGERS.map((m) => m.name),
  };

  const needed = process.platform === 'darwin';
  const prefix = process.env['HOMEBREW_PREFIX'] ?? '/opt/homebrew';
  const homebrew = {
    needed,
    present: needed ? existsSync(join(prefix, 'bin', 'brew')) : true,
    prefix,
  };

  const missingRequired = [
    ...statuses.filter((s) => !s.present && s.tool.kind === 'required').map((s) => s.tool.name),
    ...(nodeManager.found === undefined ? ['fnm or nvm'] : []),
    ...(homebrew.needed && !homebrew.present ? ['homebrew'] : []),
  ];
  const missingPreferred = statuses
    .filter((s) => !s.present && s.tool.kind === 'preferred')
    .map((s) => s.tool.name);

  return { statuses, nodeManager, homebrew, missingRequired, missingPreferred };
};
