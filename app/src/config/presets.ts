/**
 * Setup presets: what `hangar setup` SUGGESTS for the answers no checkout can supply.
 *
 * A preset is a template that writes plain config and is never read again. That is the whole
 * design constraint, and it is the difference between this and the `profiles/` directory Track B
 * once specified: a runtime `if (profile === 'sql-postgrest')` would re-introduce exactly the
 * hardcoding this track spent five items deleting. After `setup` runs, the config says what the
 * hangar does and the preset name is a label on the shelf.
 *
 * Presets exist because two questions have no derivable answer and are tedious to type. A port
 * ROLE is a decision about the repo -- what it runs, on which port, under which environment
 * variable -- and no amount of looking at a checkout answers it. `repo.cloneEnv.vars` is the same:
 * whether each clone wants its own database is a fact about how the repo is developed.
 *
 * Everything else `setup` asks about is DERIVED and so is not a preset field: `appDir`, the install
 * manager, `envrcDirs`, the VS Code root-path keys, the default branch, the issue-key prefix and
 * the origin URL all come off the disk.
 */

export type PresetRole = {
  readonly id: string;
  readonly envKey: string;
  readonly base: number;
  readonly label: string;
  /** `null` renders `url: null` -- a role with no URL, like a database port. */
  readonly url: string | null;
  readonly healthCheck?: { readonly timeoutSeconds: number; readonly path: string } | undefined;
};

export type Preset = {
  readonly name: string;
  /** One line, shown in the question. */
  readonly summary: string;
  readonly roles: readonly PresetRole[];
  readonly cloneEnvVars: Readonly<Record<string, string>>;
  /** One line written above `ports.roles`, so the reader knows what to change. */
  readonly roleNote: string;
  /** One line written above `repo.cloneEnv.vars`. */
  readonly varsNote: string;
};

/*
 * Every preset's bases are in DIFFERENT residue classes mod the default step of 100, because the
 * schema rejects two roles whose clones would collide -- and correctly: `api: 3000` beside
 * `admin: 3100` puts clone 1's admin on clone 2's api. A preset shipping that would be a config
 * that cannot load, discovered by whoever ran setup rather than by whoever wrote it.
 */
export const PRESETS: readonly Preset[] = [
  {
    name: 'generic',
    summary: 'no ports, no per-clone variables — declare what you need afterwards',
    roles: [],
    cloneEnvVars: {},
    roleNote: 'No port roles. Add one per server your repo runs.',
    varsNote: 'No per-clone variables beyond the ports.',
  },
  {
    name: 'node-web',
    summary: 'one dev server on 3000',
    roles: [
      {
        id: 'dev',
        envKey: 'DEV_SERVER_PORT',
        base: 3000,
        label: 'dev server',
        url: 'http://localhost:{port}',
        healthCheck: { timeoutSeconds: 3, path: '' },
      },
    ],
    cloneEnvVars: {},
    roleNote:
      'One dev server. Add a role per additional server (a component explorer, a test reporter).',
    varsNote: 'No per-clone variables beyond the ports.',
  },
  {
    name: 'sql-postgrest',
    summary: 'PostgREST on 3000 + Postgres on 5432, and a database per clone',
    roles: [
      {
        id: 'api',
        envKey: 'PGRST_SERVER_PORT',
        base: 3000,
        label: 'PostgREST',
        url: 'http://localhost:{port}',
        healthCheck: { timeoutSeconds: 3, path: '/' },
      },
      {
        id: 'db',
        envKey: 'PGPORT',
        base: 5432,
        label: 'Postgres',
        // A database port answers no HTTP request, so a URL for it would be a link to nothing
        // and a health check would report a server down that is running fine.
        url: null,
      },
    ],
    cloneEnvVars: {
      PGDATABASE: '{id}_{index2}',
      COMPOSE_PROJECT_NAME: '{id}-{index2}',
    },
    roleNote:
      'PostgREST answers HTTP so it gets a URL and a health check; a database port does not.',
    varsNote:
      'A database and a compose project per clone, derived from the index like the ports -- so two clones can run migrations at once without meeting.',
  },
];

export const presetNames = (): string[] => PRESETS.map((p) => p.name);

export const presetByName = (name: string): Preset | undefined =>
  PRESETS.find((p) => p.name === name);

/** The question's own help text: one line per preset. */
export const presetChoices = (): string =>
  PRESETS.map((p) => `    ${p.name.padEnd(14)} ${p.summary}`).join('\n');
