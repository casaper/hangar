import { z } from 'zod';
import { TOKENS, unknownTokens } from '../template.ts';

import {
  DEFAULT_EDITOR_KIND,
  EDITOR_KINDS,
  JETBRAINS_PRODUCT_NAMES,
  KINDS_USING_ROOT_PATHS,
} from '../editor/kinds.ts';

/**
 * The `hangar.config.yaml` schema, and the single authority on it.
 *
 * `hangar.schema.json` is GENERATED from this file (`hangar config schema`), so editors get
 * completion and validation from the same rules the loader enforces. Two hand-maintained
 * definitions of one shape would drift; one generated from the other cannot.
 *
 * Every object is STRICT. An unknown key is an error, not something to ignore, because the
 * failure mode of a silently dropped key is a setting that appears configured and is not --
 * `orgin_url` would leave the hangar cloning nothing and say why nowhere. This is a
 * deliberate departure from `colour-assignments.ts`, whose lenient parsing is right *there*
 * only because a safe fallback exists (the index formula). Here there is none: a typo'd
 * origin clones the wrong repo, a wrong offset silently shares a port with another hangar,
 * and a mistyped envKey writes a dotenv the app ignores.
 */

/** A path inside a clone or the hangar: relative, and not allowed to escape upward. */
const containedPath = (what: string) =>
  z
    .string()
    .min(1)
    .refine((p) => !p.startsWith('/'), { message: `${what} must be relative, not absolute` })
    .refine((p) => !p.split('/').includes('..'), { message: `${what} must not contain ".."` });

/**
 * The hangar id. Tighter than it looks, and every constraint is load-bearing.
 *
 * It becomes a path segment (`~/.claude/hangar/<id>`), a filename fragment
 * (`hangar-<id>-01-cyan.json`) and a SHELL FUNCTION NAME (`<id>_clone_rgb`) -- so no dashes,
 * because `-` is the separator inside the generated names, and a leading digit is not a legal
 * identifier. It is required and never derived from the directory basename: `~/work/dvb_gn`
 * and `~/code/dvb_gn` would collide, and the collision lands in shared mutable state where
 * the symptom is "the other hangar's clones changed colour".
 */
const hangarId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,23}$/, 'must be 2-24 chars, lowercase, start with a letter, [a-z0-9_]');

export const clonesSchema = z.strictObject({
  /** Directory prefix. Must not end in a digit, or the generated index regex is ambiguous. */
  prefix: z
    .string()
    .min(1)
    .regex(/[^0-9]$/, 'must not end in a digit')
    .default('clone_'),
  /**
   * Zero-padding width for the index. The generated discovery regex is `\d{pad,}` -- open at
   * the top on purpose: the old `clone_0[0-9]` globs stopped matching at clone_10.
   */
  pad: z.int().min(1).max(6).default(2),
});

const forgeSchema = z.strictObject({
  /** Selects a built-in adapter. `none` means no PR lookup and no web links. */
  kind: z.enum(['bitbucketCloud', 'none']).optional(),
  /** What `add-clone` clones from. The one field with no sensible default. */
  originUrl: z.string().min(1),
  /** Web base for repo/PR links. Derived from `originUrl` by the adapter when absent. */
  webBaseUrl: z.url().optional(),
  /**
   * The branch the repo treats as its default. REQUIRED IN EFFECT, optional in the schema.
   *
   * Nobody has to write it: the first command that needs it detects it (a clone's
   * `origin/HEAD`, then `git remote set-head --auto`, then `git ls-remote --symref` on
   * `originUrl`) and records it here, after which no command asks git again. It is optional
   * HERE because a hard requirement would make `config validate` and `doctor` fail on the
   * very file they exist to diagnose, before the autofill could run -- and because detection
   * needs a clone or a network, neither of which a schema can promise.
   *
   * Undetectable means ABORT, never `master`. Guessing a branch name for an unknown repo is
   * confidently wrong, and it contradicts sync's own rule that a destination missing from
   * origin aborts -- a rebase onto the wrong base is the expensive thing to undo.
   */
  defaultBranch: z.string().min(1).optional(),
  tokenEnvKey: z.string().min(1).optional(),
  /**
   * How many seconds the clone bar may go on showing a pull request's last known state.
   *
   * The bar never blocks on the network: it draws what is on disk and, past this age, spawns one
   * detached refresh whose answer lands at the next redraw. So this is a ceiling on how WRONG the
   * bar may be, not a poll interval -- a hangar nobody is looking at makes no requests at all,
   * because the only thing that starts a refresh is a pane being drawn.
   *
   * The default of 90 is set by the fastest-moving field. The id and the branch never go stale;
   * a build does, and a red mark that stays red for five minutes after the rerun went green is
   * the version of this nobody trusts again.
   *
   * The floor is 10 rather than 0 for the same reason: two API calls per clone per redraw is a
   * rate limit somebody discovers by being throttled. Turning it OFF is `kind: 'none'`, which
   * disables the lookup rather than making it constant.
   */
  prCacheTtlSeconds: z.int().min(10).optional(),
});

const trackerSchema = z.strictObject({
  kind: z.enum(['jira', 'none']).default('none'),
  baseUrl: z.url().optional(),
  issueUrlTemplate: z.string().min(1).default('{baseUrl}/browse/{key}'),
  /**
   * Issue-key prefixes, e.g. `["DN"]`. Absent means any key-shaped token, minus a denylist.
   * Present turns the open pattern into a whitelist, which is the better fix.
   */
  keyPrefixes: z.array(z.string().regex(/^[A-Z][A-Z0-9]+$/)).optional(),
  cache: z
    .strictObject({
      ttlMinutes: z.int().min(0).default(60),
      bypassEnvKey: z.string().min(1).default('HANGAR_TRACKER_NO_CACHE'),
    })
    .default({ ttlMinutes: 60, bypassEnvKey: 'HANGAR_TRACKER_NO_CACHE' }),
  /** Repo-relative. The command the PreToolUse hook recognises as a fetch. */
  syncScript: containedPath('tracker.syncScript').optional(),
  /**
   * Repo-relative. The repo's own authority on cache filenames -- Hangar ASKS it and never
   * reimplements it, because an untracked copy drifts the first time a branch changes a
   * relation slug.
   */
  namerScript: containedPath('tracker.namerScript').optional(),
});

/**
 * One install step. Generic on purpose: any package manager, Node or not.
 *
 * Give either a known `manager` (whose canonical install command is built in) or an explicit
 * `command`. Exactly one -- a step that names both would have two answers to "what runs".
 */
const installStepSchema = z
  .strictObject({
    /** Clone-relative directory to run in. Defaults to `repo.appDir`. */
    dir: containedPath('repo.install[].dir').optional(),
    manager: z
      .enum([
        'npm',
        'pnpm',
        'yarn',
        'bun',
        'deno',
        'maven',
        'gradle',
        'bundler',
        'pip',
        'poetry',
        'uv',
        'cargo',
        'go',
        'composer',
      ])
      .optional(),
    /** Overrides `manager`'s canonical command. argv form, never a shell string. */
    command: z.array(z.string().min(1)).min(1).optional(),
    /** When present, the step runs under the Node version this file names. */
    nodeVersionFile: containedPath('repo.install[].nodeVersionFile').optional(),
    /** A failure is reported and the run continues. */
    optional: z.boolean().default(false),
    /**
     * REQUIRED, for the same reason `repo.symlinks[].why` is.
     *
     * An install step is the one thing Hangar runs inside a clone that can delete work --
     * `npm ci` removes `node_modules` outright -- and a bare `manager: npm` says nothing about
     * why a clone needs it. This string is what `add-clone`, `hangar install` and `doctor`
     * print beside the step, and it is the only place a reader learns whether a step is
     * load-bearing or a leftover.
     */
    why: z.string().min(1),
  })
  .refine((s) => (s.manager === undefined) !== (s.command === undefined), {
    message: 'give exactly one of `manager` or `command`',
  });

/** The canonical install command per known manager. `command` overrides these. */
export const MANAGER_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  npm: ['npm', 'ci'],
  pnpm: ['pnpm', 'install', '--frozen-lockfile'],
  yarn: ['yarn', 'install', '--immutable'],
  bun: ['bun', 'install', '--frozen-lockfile'],
  deno: ['deno', 'install', '--frozen'],
  maven: ['mvn', '-q', '-B', 'dependency:go-offline'],
  gradle: ['gradle', '--quiet', 'dependencies'],
  bundler: ['bundle', 'install'],
  pip: ['pip', 'install', '-r', 'requirements.txt'],
  poetry: ['poetry', 'install'],
  uv: ['uv', 'sync', '--frozen'],
  cargo: ['cargo', 'fetch', '--locked'],
  go: ['go', 'mod', 'download'],
  composer: ['composer', 'install'],
});

/**
 * The clone-relative path whose existence means a manager's install has actually run.
 *
 * Deliberately PARTIAL, and the gaps are the honest part. Only some managers leave their
 * result inside the checkout: the four JavaScript ones write `node_modules`, `uv` writes
 * `.venv`, `composer` writes `vendor`. Maven puts it in `~/.m2`, Go in the module cache,
 * cargo in `~/.cargo`, pip and poetry wherever the active environment is -- all outside the
 * clone, and all of them shared between clones, so no per-clone path could answer for them.
 *
 * A manager with no marker makes `doctor` report **cannot verify** rather than a red row. A
 * red row nobody can clear is a row nobody reads, and inventing a marker for maven would make
 * `doctor` red on a correctly installed clone forever. It lives here so the fourteen managers
 * and their markers cannot drift into two files.
 */
export const INSTALL_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  npm: 'node_modules',
  pnpm: 'node_modules',
  yarn: 'node_modules',
  bun: 'node_modules',
  uv: '.venv',
  composer: 'vendor',
});

const symlinkSchema = z.strictObject({
  path: containedPath('repo.symlinks[].path'),
  /** Templated. `{secretsFile}` is the usual target. */
  target: z.string().min(1),
  skipIfDirMissing: z.boolean().default(true),
  /**
   * REQUIRED, and not pedantry: every symlink here exists for a reason nobody can
   * reconstruct from the filesystem, and this string is what `add-clone` and `doctor` print.
   */
  why: z.string().min(1),
});

const repoSchema = z.strictObject({
  /** Where the app package lives. `""` means the repo root. */
  appDir: z.union([z.literal(''), containedPath('repo.appDir')]).default(''),
  /** Fallback union for direnv discovery; `git ls-files -- *.envrc` is tried first. */
  envrcDirs: z.array(z.string().min(1)).default(['.']),
  cloneEnv: z
    .strictObject({
      file: z.string().min(1).default('.env.local'),
      /** Omit to write no root-path line at all. */
      rootPathEnvKey: z.string().min(1).optional(),
      /**
       * Per-clone values beyond the ports, as templated `KEY: value` pairs.
       *
       * Ports are not the only thing a clone needs to itself. A repo whose clones each want
       * their own database or container set expresses that here --
       * `PGDATABASE: myrepo_{index2}`, `COMPOSE_PROJECT_NAME: myrepo_{index2}` -- and every
       * clone gets its own, derived from the index like everything else, with no bookkeeping.
       *
       * It goes through the same builder the ports do, so `doctor` byte-compares it and `--fix`
       * repairs it without a new check. A value landing in a LIVE dotenv means a running server
       * and a new shell disagree until the server restarts, which is the same caveat the ports
       * have always had.
       */
      vars: z
        .record(
          z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an UPPER_SNAKE env var name'),
          z.string().min(1),
        )
        .default({}),
    })
    .default({ file: '.env.local', vars: {} }),
  symlinks: z.array(symlinkSchema).default([]),
  install: z.array(installStepSchema).default([]),
  /**
   * The repo's own port resolver, run INSIDE a clone so direnv has loaded its dotenv, and
   * compared against this config. Turns the by-convention agreement between Hangar and a
   * repo's own port table into a checked one.
   */
  portCheckCommand: z.array(z.string().min(1)).min(1).optional(),
});

const healthCheckSchema = z.strictObject({
  kind: z.literal('httpCurl'),
  timeoutSeconds: z.int().min(1).max(60).default(3),
  path: z.string().default(''),
});

const portRoleSchema = z.strictObject({
  id: z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'must be a lowerCamelCase identifier'),
  envKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an UPPER_SNAKE env var name'),
  base: z.int().min(1024).max(65535),
  label: z.string().min(1),
  /** `null` for a role with no URL. */
  url: z.string().min(1).nullable().default('http://localhost:{port}'),
  healthCheck: healthCheckSchema.optional(),
});

const portsSchema = z.strictObject({
  /** Spacing between clones. Must match across hangars for the offset guarantee to hold. */
  step: z.int().min(1).max(10000).default(100),
  /**
   * This hangar's residue class, `0 <= offset < step`.
   *
   * Two hangars with the same step and different offsets produce ports in different classes
   * mod step, so their clones can never collide for ANY clone counts -- unlike a reserved
   * block, which fails silently once a hangar outgrows it. `offset: 0` keeps an existing
   * hangar exactly where it is, which matters because changing a port moves a running dev
   * server out from under a live session.
   */
  offset: z.int().min(0).default(0),
  /** Ordered; the order is the display order. Empty means this hangar assigns no ports. */
  roles: z.array(portRoleSchema),
});

export const terminalSchema = z.strictObject({
  /**
   * Which emulator hosts a clone's window. `auto` detects it from the environment, then from what
   * is running.
   *
   * Set it explicitly when detection has no correct answer available -- a machine with both
   * iTerm2 and Terminal.app installed, or both Konsole and GNOME Terminal. The emulator is asked
   * for two things: open one tab or window running one command, and bring one it opened to the
   * front. Everything inside that window is tmux.
   *
   * `none` means Hangar opens no window: it still builds the clone's tmux session, with its
   * roles and its hue, and prints the `tmux attach` line. So a hangar driven from a terminal
   * nobody wrote a driver for keeps its sessions, its colours and its `SYNC PAUSE`.
   */
  kind: z
    .enum(['auto', 'iterm2', 'apple-terminal', 'konsole', 'gnome-terminal', 'none'])
    .default('auto'),
  /**
   * Where a clone's window goes: a `tab` in the emulator's current window, or a `window` of its
   * own. `--tab` and `--window` override it for one run.
   *
   * A tab by default because every emulator here can open one from a command or a script, so it
   * is a real default rather than a nicety on one platform -- and because a clone per tab is how
   * a developer with four of them keeps one window. Terminal.app is the one place it costs
   * something: its `tab` element is read-only in AppleScript, so a tab needs Accessibility
   * permission and a refusal falls back to a window with a note saying what to allow.
   */
  placement: z.enum(['tab', 'window']).default('tab'),
  /**
   * What the generated shell hook paints when a shell moves into a clone.
   *
   * Three independent layers, because the emulators support wildly different amounts and the
   * bottom one always works:
   *
   * - `chrome` -- the window colour. Inside tmux, which is where every window `hangar open`
   *   creates lives, these are tmux window options at full hue on the window-status entry and
   *   both pane borders. In a shell outside tmux it is iTerm2's tab colour or everyone else's
   *   background tint; Terminal.app understands neither sequence, so a plain shell there gets
   *   the two layers below and a Hangar window there gets its chrome from the tmux inside it.
   * - `title` -- the window/tab title, which every terminal since the 1980s supports.
   * - `env` -- `HANGAR_CLONE*` variables, which need no terminal support at all and are the
   *   floor under everything else: a prompt, a starship config or a hand-written tmux status
   *   line can colour itself from `HANGAR_CLONE_SGR` with no co-operation from anything.
   */
  colour: z
    .strictObject({
      chrome: z.boolean().default(true),
      title: z.boolean().default(true),
      env: z.boolean().default(true),
      /**
       * How much of the hue reaches a background tint, 0-1.
       *
       * A saturated hue behind text is unreadable, so the background gets a dark fraction of it
       * -- enough to tell four windows apart at a glance, not enough to fight the theme. iTerm2
       * and tmux are unaffected: they colour a tab and a window-status entry, where the full hue
       * is exactly right.
       */
      tint: z.number().min(0).max(1).default(0.16),
    })
    .prefault({}),
  /**
   * One tmux window per entry, in this order, in each clone's session -- each named for the clone
   * and the role.
   *
   * The key is `tabs` because that is what they are on screen: tmux's window list IS the tab bar,
   * and a key named after the implementation would need a sentence of explanation on every read.
   */
  tabs: z
    .array(
      z.strictObject({
        role: z.string().min(1),
        dir: containedPath('terminal.tabs[].dir').default('.'),
        /** Omit for a plain shell. */
        command: z.string().min(1).optional(),
      }),
    )
    .default([{ role: 'claude', dir: '.', command: 'claude' }]),
});

export const editorSchema = z.strictObject({
  /**
   * Which editors `hangar open` opens a clone in, and which ones `<kind> sync` keeps in step.
   *
   * A LIST, not one choice: a developer may well keep a clone open in VS Code and in a JetBrains
   * IDE at once, and the two do not conflict -- their project files are different files. An
   * empty list is legal and means Hangar opens no editor at all.
   *
   * VS Code is the default, and it is also the only kind that is exercised: it is the editor
   * this fleet is set up for and the one whose per-clone workspace files `doctor` already
   * maintains. `DEFAULT_EDITOR_KIND` is the single place that says so, and this default is the
   * only route to it: `editor/index.ts` falls back by parsing an empty object through this
   * schema, so a config that omits the key and a config too broken to parse cannot end up
   * disagreeing about which editor comes up.
   */
  kinds: z.array(z.enum(EDITOR_KINDS)).default([DEFAULT_EDITOR_KIND]),
  jetbrains: z
    .strictObject({
      product: z.enum(JETBRAINS_PRODUCT_NAMES).default('idea'),
      /**
       * An explicit launcher path, for a Toolbox install that generated no shell scripts.
       * Empty means "find `<product>` on PATH", with a macOS `open -a` fallback.
       */
      launcher: z.string().default(''),
    })
    .prefault({}),
  vim: z
    .strictObject({
      /**
       * Which vim. Empty prefers a GUI one (`mvim`, `gvim`) and falls back to `nvim`/`vim` in a
       * terminal tab -- a GUI window is the better answer whenever there is one.
       */
      command: z.string().default(''),
    })
    .prefault({}),
  eclipse: z
    .strictObject({
      /** Eclipse ships no launcher script, so this is usually the one inside the app bundle. */
      launcher: z.string().default(''),
    })
    .prefault({}),
  workspaceFileName: z.string().min(1).default('{id}_{index2}.code-workspace'),
  workspaceFolderLabel: z.string().min(1).default('{index}: {id}'),
  workspaceDirs: z.array(z.string().min(1)).min(1).default(['.']),
  /** Settings keys whose value is a clone-relative path needing per-clone rewriting. */
  rootPathKeys: z.record(z.string(), z.string()).default({}),
});

const secretVariableSchema = z.strictObject({
  /** The environment variable name, as it appears in the secrets file. */
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a legal environment variable name'),
  /**
   * REQUIRED, for the same reason `repo.symlinks[].why` is: nothing in the filesystem explains
   * what breaks without this variable, and this string is what `setup` writes into the scaffold
   * and `doctor` prints when it is unset.
   */
  why: z.string().min(1),
  /**
   * `false` means "this hangar cannot work without it" -- an unset one is a `doctor` warning.
   * `true` downgrades that to a dim row, for a credential only some of the fleet's work needs.
   *
   * The default is required, because a variable nobody had to declare is one nobody had to
   * justify, and the `why` above is the price of the row.
   */
  optional: z.boolean().default(false),
});

const secretsSchema = z.strictObject({
  /** Hangar-root-relative. Lives outside every clone so no clone can commit it. */
  file: containedPath('secrets.file').default('.env.shared'),
  mode: z
    .string()
    .regex(/^[0-7]{3,4}$/, 'must be an octal file mode like "600"')
    .default('600'),
  /**
   * What the REPO's own tooling needs out of that file -- the half no hangar can derive.
   *
   * `forge.tokenEnvKey` and the tracker credentials are Hangar's own, so `setup` already
   * scaffolds those. Everything else a checkout needs is invisible from here: this fleet's
   * Playwright suite reads `USER_READWRITE_PASSWORD`, and the tracked
   * `tests/playwright-regression-tests/.env` sets it EMPTY and is loaded after the shared
   * secrets -- which is why a symlink reloads them, and the symlink's `why` says so. But
   * nothing told a new hangar to put the variable in the file at all, so the symlink was
   * created, `doctor` was green, and Playwright logged in with an empty password: exactly the
   * failure the symlink exists to prevent, reproduced by omission.
   *
   * Named `variables` and not `vars` on purpose -- `repo.cloneEnv.vars` is a MAP of values to
   * write, and this is a LIST of names to check. Two keys spelled the same with different
   * shapes is how a config gets edited into the wrong one.
   */
  variables: z.array(secretVariableSchema).default([]),
});

const paletteSchema = z.strictObject({
  /** REPLACES the built-in 16. Order is load-bearing and append-only. */
  hues: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9]*$/),
        hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
    )
    .min(1)
    .optional(),
  /**
   * Index rotation, so a second hangar's clones start on different hues.
   * Applied on READ, which is what preserves the append-only property of the hue list.
   */
  rotate: z.int().min(0).default(0),
});

export const hangarConfigSchema = z
  .strictObject({
    /** Editor completion only; never read at runtime. */
    $schema: z.string().optional(),
    /** A free-text note. JSON/YAML have no comments the schema can carry. */
    _: z.string().optional(),

    id: hangarId,
    displayName: z.string().min(1).optional(),
    profile: z.string().min(1).default('generic'),

    clones: clonesSchema.prefault({}),
    forge: forgeSchema,
    tracker: trackerSchema.prefault({}),
    repo: repoSchema.prefault({}),
    ports: portsSchema,
    terminal: terminalSchema.prefault({}),
    editor: editorSchema.prefault({}),
    secrets: secretsSchema.prefault({}),
    palette: paletteSchema.prefault({}),
  })
  .superRefine((cfg, ctx) => {
    const { ports, tracker, editor } = cfg;

    /*
     * Every templated value, checked for tokens the renderer does not know.
     *
     * At LOAD time rather than at render time, and that is the point: most of these are written
     * into a live clone, so `PGDATABASE=myrepo_{indx2}` would otherwise reach a dotenv verbatim
     * and aim a running server at a database nobody meant. One list, so a new templated field is
     * one line here and cannot be forgotten.
     */
    const templated: (readonly [(string | number)[], string])[] = [
      [['tracker', 'issueUrlTemplate'], tracker.issueUrlTemplate],
      [['editor', 'workspaceFileName'], editor.workspaceFileName],
      [['editor', 'workspaceFolderLabel'], editor.workspaceFolderLabel],
      ...ports.roles.flatMap((role, i) =>
        role.url === null
          ? []
          : [[['ports', 'roles', i, 'url'], role.url] as readonly [(string | number)[], string]],
      ),
      ...cfg.repo.symlinks.map(
        (link, i) =>
          [['repo', 'symlinks', i, 'target'], link.target] as readonly [
            (string | number)[],
            string,
          ],
      ),
      ...Object.entries(cfg.repo.cloneEnv.vars).map(
        ([key, value]) =>
          [['repo', 'cloneEnv', 'vars', key], value] as readonly [(string | number)[], string],
      ),
    ];
    for (const [path, value] of templated) {
      const unknown = unknownTokens(value);
      if (unknown.length === 0) continue;
      ctx.addIssue({
        code: 'custom',
        path: [...path],
        message: `unknown template token(s) ${unknown.map((t) => `{${t}}`).join(', ')} — known: ${TOKENS.map((t) => `{${t}}`).join(' ')}`,
      });
    }

    // Two hangars can only be guaranteed apart if the offset is inside one step.
    if (ports.offset >= ports.step) {
      ctx.addIssue({
        code: 'custom',
        path: ['ports', 'offset'],
        message: `must be less than ports.step (${String(ports.step)}); ${String(ports.offset)} would overlap the next clone`,
      });
    }

    const seenId = new Map<string, number>();
    const seenEnv = new Map<string, number>();
    ports.roles.forEach((role, i) => {
      const priorId = seenId.get(role.id);
      if (priorId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['ports', 'roles', i, 'id'],
          message: `duplicate role id "${role.id}" (already used at roles[${String(priorId)}])`,
        });
      }
      seenId.set(role.id, i);

      const priorEnv = seenEnv.get(role.envKey);
      if (priorEnv !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['ports', 'roles', i, 'envKey'],
          message: `duplicate envKey "${role.envKey}" (already used at roles[${String(priorEnv)}])`,
        });
      }
      seenEnv.set(role.envKey, i);
    });

    /*
     * Two roles whose bases are congruent mod step collide ACROSS clones: role A of clone 2
     * lands on role B of clone 1. Statically checkable, and silent at runtime -- a dev server
     * answering on another role's port is the kind of thing that verifies the wrong code.
     */
    for (let i = 0; i < ports.roles.length; i += 1) {
      for (let j = i + 1; j < ports.roles.length; j += 1) {
        const a = ports.roles[i];
        const b = ports.roles[j];
        if (a === undefined || b === undefined) continue;
        if ((a.base - b.base) % ports.step === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['ports', 'roles', j, 'base'],
            message: `${a.id} (${String(a.base)}) and ${b.id} (${String(b.base)}) differ by a multiple of step ${String(ports.step)}, so their clones would share ports`,
          });
        }
      }
    }

    if (tracker.kind !== 'none' && tracker.baseUrl === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tracker', 'baseUrl'],
        message: `required when tracker.kind is "${tracker.kind}"`,
      });
    }

    // "No kind that CONSUMES these keys", not "no editor configured": `$PROJECT_DIR$` makes
    // JetBrains project files clone-portable, so `rootPathKeys` is exactly as inert in a
    // JetBrains-only hangar as in one with no editor -- and silently ignoring them is the same
    // bug either way.
    if (
      Object.keys(editor.rootPathKeys).length > 0 &&
      !editor.kinds.some((kind) => KINDS_USING_ROOT_PATHS.includes(kind))
    ) {
      const listed =
        editor.kinds.length === 0 ? 'no editor is configured' : editor.kinds.join(', ');
      ctx.addIssue({
        code: 'custom',
        path: ['editor', 'rootPathKeys'],
        message: `set, but nothing would ever read them (${listed}); only ${KINDS_USING_ROOT_PATHS.join(', ')} rewrites absolute paths`,
      });
    }
  });

export type HangarConfig = z.infer<typeof hangarConfigSchema>;
export type PortRole = HangarConfig['ports']['roles'][number];
export type InstallStep = HangarConfig['repo']['install'][number];
export type SymlinkSpec = HangarConfig['repo']['symlinks'][number];

/** The argv an install step runs, resolving `manager` to its canonical command. */
export const installCommandFor = (step: InstallStep): readonly string[] => {
  if (step.command !== undefined) return step.command;
  const canonical = step.manager === undefined ? undefined : MANAGER_COMMANDS[step.manager];
  // The schema guarantees exactly one of the two is set, so this is unreachable.
  if (canonical === undefined) throw new Error(`install step has neither manager nor command`);
  return canonical;
};
export type SecretVariable = HangarConfig['secrets']['variables'][number];
