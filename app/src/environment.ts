import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { platform } from './platform/index.ts';
import { home } from './user-paths.ts';

/**
 * The external programs Hangar depends on, and the ones it merely wants.
 *
 * Derived at the moment it is reported -- never cached, never written to a file. A recorded
 * "you have ripgrep" is wrong the moment someone uninstalls it, and the whole value of this
 * check is being true right now.
 */

export type ToolKind = 'required' | 'preferred';

export type Tool = {
  /** How a human refers to it. */
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
  /**
   * The name a package manager knows it by, when it IS a package.
   *
   * Split from the hint text because the hint is platform-specific and the package name almost
   * never is: `brew install jq` on macOS and `apt install jq` on Debian differ in the verb, not
   * the noun. Before F11 every one of these read `brew install …` on every platform, which on
   * Linux is an instruction that cannot be followed -- printed at exactly the moment someone is
   * already stuck.
   */
  readonly pkg?: string;
  /**
   * A hint that is not a package install, or the step that FOLLOWS one.
   *
   * Node, pnpm and the two Node managers are the real cases: none of them is installed by a
   * package manager here (Node comes from `.nvmrc` through fnm, pnpm through corepack), so their
   * hints are already platform-neutral and stay written out.
   */
  readonly install?: string;
  /** Present when the program is not a plain binary on PATH (nvm is a shell function). */
  readonly detect?: (root: string) => boolean;
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

/**
 * Is the running Node the version this hangar pins in `.nvmrc`?
 *
 * A PRESENCE check would be worthless: this code is running under Node, so `node` is on PATH
 * by construction and the row could never go red. What actually goes wrong is the version --
 * a shell where direnv has not loaded, or an fnm that never installed the pinned release,
 * runs the CLI under whatever Node happens to come first on PATH. `.nvmrc` and `app/.nvmrc`
 * are a pair, so the hangar root's copy is the authority.
 *
 * A missing or unparseable `.nvmrc` reports OK rather than inventing a failure: whether the
 * hangar pins a version at all is its own business, and its absence is not this check's
 * finding.
 */
const nodeMatchesNvmrc = (root: string): boolean => {
  let pinned: string;
  try {
    pinned = readFileSync(join(root, '.nvmrc'), 'utf8');
  } catch {
    return true;
  }
  const want = /^\s*v?(\d+)/.exec(pinned)?.[1];
  if (want === undefined) return true;
  return process.versions.node.split('.')[0] === want;
};

export const TOOLS: readonly Tool[] = Object.freeze([
  {
    name: 'git',
    kind: 'required',
    why: 'every clone is a git checkout, and sibling remotes are how commits move between them',
    pkg: 'git',
  },
  {
    name: 'direnv',
    kind: 'required',
    why: 'the only thing that puts this hangar’s own `hangar` on PATH, and loads each clone’s ports',
    pkg: 'direnv',
    install: 'then hook it into your shell: https://direnv.net/docs/hook.html',
  },
  {
    // The name carries the CONDITION because the renderer's verb is fixed at `MISSING`: a
    // bare `node` row reading MISSING on a machine where node plainly works would send
    // someone off installing what they already have. What is missing is the pinned version.
    name: 'node (.nvmrc)',
    kind: 'required',
    why: 'the CLI is a Node program with no build step, and a shell without direnv runs it under whatever Node came first on PATH',
    install:
      'installed per directory by fnm or nvm from .nvmrc — run `direnv allow` at the hangar root',
    detect: nodeMatchesNvmrc,
  },
  {
    name: 'pnpm',
    kind: 'required',
    why: 'installs and pins the CLI’s own dependencies, and runs its typecheck/lint/format gates',
    install:
      '`direnv allow` at the hangar root activates it through corepack, at the version app/package.json pins — no separate install',
  },
  {
    // Not optional and not only for ports: `cwdsOf` in `procs.ts` maps a pid to its working
    // directory with it, which is how a live Claude Code session is attributed to a clone at
    // all. Without lsof `sync --all` stops skipping busy clones and `remove-clone` loses both
    // of its liveness guards -- and every one of those failures looks like "nothing is running".
    name: 'lsof',
    kind: 'required',
    why: 'attributes a running process to a clone — live sessions by working directory, dev servers by listening port',
    pkg: 'lsof',
  },
  {
    name: 'jq',
    kind: 'required',
    why: 'reads Claude Code settings and session transcripts, which are JSON',
    pkg: 'jq',
  },
  {
    name: 'yq',
    kind: 'required',
    why: 'reads hangar.config.yaml from shell contexts that cannot start Node (the statusline)',
    pkg: 'yq',
  },
  {
    name: 'ripgrep',
    bin: 'rg',
    kind: 'preferred',
    why: 'faster than grep with a stronger regex engine; `hangar teach-rg` points agents at it',
    pkg: 'ripgrep',
  },
  {
    name: 'ripgrep-all',
    bin: 'rga',
    kind: 'preferred',
    why: 'searches inside PDFs and archives, which plain rg skips',
    pkg: 'ripgrep-all',
  },
  {
    name: 'tree',
    kind: 'preferred',
    why: 'the cheapest way to show an agent a directory shape',
    pkg: 'tree',
  },
  {
    name: 'git-lfs',
    kind: 'preferred',
    why: 'repos with large binary assets need it, and a missing filter corrupts checkouts silently',
    pkg: 'git-lfs',
    install: 'then `git lfs install` once, per user account',
  },
  {
    name: 'git-extras',
    kind: 'preferred',
    why: 'adds git summary / git effort / git delete-branch, used when comparing clones',
    pkg: 'git-extras',
  },
  {
    name: 'git-filter-repo',
    kind: 'preferred',
    why: 'the only safe way to rewrite history, e.g. when extracting a hangar into its own repo',
    pkg: 'git-filter-repo',
  },
]);

/** Either fnm or nvm satisfies the Node-manager requirement; fnm is the supported one. */
export const NODE_MANAGERS: readonly Tool[] = Object.freeze([
  {
    name: 'fnm',
    kind: 'required',
    why: 'resolves the .nvmrc Node version per directory (preferred: faster, and a real binary)',
    pkg: 'fnm',
    install: 'or the upstream installer: https://github.com/Schniz/fnm#installation',
  },
  {
    name: 'nvm',
    kind: 'required',
    why: 'alternative Node version manager',
    // No package: nvm is a shell function sourced from a script, and every distribution that
    // packages it produces an install that `nvmPresent` below cannot see.
    install: 'the upstream installer: https://github.com/nvm-sh/nvm#installing-and-updating',
    detect: nvmPresent,
  },
]);

/**
 * The one line to print beside a missing tool, for THIS machine.
 *
 * Not a field on the tool, and not computed when `TOOLS` is built: `TOOLS` is a module constant
 * evaluated at import, and a hint baked in there would be the import-time-evaluation trap this
 * CLI has already paid for once -- correct here, and silently wrong the moment anything renders
 * for a platform other than the one that loaded the module.
 */
export const installHint = (tool: Tool): string =>
  [tool.pkg === undefined ? undefined : platform().installHint(tool.pkg), tool.install]
    .filter((part) => part !== undefined)
    .join(' — ');

/** The Apple-silicon install location, and the only prefix that needs no probe to find. */
const DEFAULT_BREW_PREFIX = '/opt/homebrew';

/**
 * `HOMEBREW_PREFIX`, then the Apple-silicon default, then `brew` itself.
 *
 * `brew shellenv` is what exports `HOMEBREW_PREFIX`, and it is in the Apple-silicon install
 * instructions but was not in the older Intel one -- so an Intel Mac with Homebrew at
 * `/usr/local` very often has it unset. Stopping at the default then reported `homebrew MISSING`
 * on a machine that has Homebrew, and made `setup` refuse to continue over it.
 *
 * The probe is LAST and conditional, so the overwhelmingly common path -- the variable exported,
 * or `/opt/homebrew` sitting right there -- spawns nothing. It is timed out rather than trusted
 * because `brew` is a bash script and this runs inside `hangar doctor`: a health check that can
 * hang is worse than one that falls back to the default.
 *
 * `.envrc.hangar`'s `hangar_use_gnu` resolves it in the same three steps, in the same order.
 */
const resolveBrewPrefix = (needed: boolean): string => {
  const declared = process.env['HOMEBREW_PREFIX'];
  if (declared !== undefined && declared !== '') return declared;
  if (!needed || existsSync(DEFAULT_BREW_PREFIX)) return DEFAULT_BREW_PREFIX;
  if (!onPath('brew')) return DEFAULT_BREW_PREFIX;
  const out = spawnSync('brew', ['--prefix'], { encoding: 'utf8', timeout: 5000 });
  const value = out.status === 0 ? out.stdout.trim() : '';
  return value === '' ? DEFAULT_BREW_PREFIX : value;
};

export type ToolStatus = { readonly tool: Tool; readonly present: boolean };

export const toolPresent = (root: string, tool: Tool): boolean =>
  tool.detect === undefined ? onPath(tool.bin ?? tool.name) : tool.detect(root);

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

/**
 * Inspect the machine.
 *
 * Takes the hangar ROOT rather than reading a module constant, because the one check that is not
 * purely about the machine -- whether the running Node matches the pinned version -- reads that
 * hangar's `.nvmrc`, and two hangars may pin different versions.
 */
export const inspectEnvironment = (root: string): EnvironmentReport => {
  const statuses = TOOLS.map((tool) => ({ tool, present: toolPresent(root, tool) }));

  const found = NODE_MANAGERS.find((m) => toolPresent(root, m));
  const nodeManager = {
    found: found?.name,
    candidates: NODE_MANAGERS.map((m) => m.name),
  };

  const needed = process.platform === 'darwin';
  /*
   * `brew --prefix` between the env var and the Apple-silicon default.
   *
   * `HOMEBREW_PREFIX` is exported by `brew shellenv`, which the Apple-silicon install
   * instructions tell you to put in your profile and the older Intel install did not -- so an
   * Intel Mac with Homebrew at /usr/local very often has it unset. With only the `/opt/homebrew`
   * fallback, `setup` then reported `homebrew MISSING` and refused to continue on a machine that
   * has Homebrew, and `.envrc.hangar` failed the same way for the same reason.
   *
   * Asking `brew` itself is the answer that cannot be wrong, and it costs one spawn on a path
   * that already shells out a dozen times. Guarded by `onPath`, so a machine with no Homebrew
   * pays nothing and still gets the honest "missing" it should.
   */
  const prefix = resolveBrewPrefix(needed);
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
