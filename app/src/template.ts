import { CliError } from './exec.ts';

/**
 * The one `{token}` renderer.
 *
 * Several config values are templates -- a symlink target, a workspace file name, an issue URL,
 * a role's URL, and the per-clone environment variables `repo.cloneEnv.vars` declares. They were
 * all declared with `{token}` placeholders and none of them were rendered: the example config
 * said so about itself. One renderer with one token table is what makes them live, and it is
 * deliberately the ONLY place a token is understood, so a new one is a single edit and an
 * unknown one is impossible to spell.
 *
 * `unknownTokens` exists so the schema can reject a typo'd token at LOAD time rather than at
 * render time. That matters more here than it looks: several of these values are written into a
 * live clone, and `PGDATABASE=myrepo_{indx2}` would otherwise reach a dotenv verbatim and point
 * a running server at a database nobody meant.
 */
export const TOKENS = [
  'id',
  'displayName',
  'index',
  'index2',
  'clone',
  'root',
  'port',
  'secretsFile',
  'baseUrl',
  'key',
] as const;

export type Token = (typeof TOKENS)[number];
export type TokenValues = Partial<Readonly<Record<Token, string>>>;

const TOKEN_RE = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Every `{token}` in a template that is not in the table above.
 *
 * Used by the schema's cross-checks. Returns names, not positions: the message names the token
 * and the field, which is what a reader needs to fix it.
 */
export const unknownTokens = (template: string): string[] => {
  const known = new Set<string>(TOKENS);
  const found = new Set<string>();
  for (const match of template.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (name !== undefined && !known.has(name)) found.add(name);
  }
  return [...found];
};

/**
 * Render a template, or throw naming what was missing.
 *
 * A token that is KNOWN but has no value in this context is an error rather than an empty
 * string: `{port}` means nothing outside a port role, and rendering it away would produce
 * `PGDATABASE=myrepo_` -- a plausible-looking value that is wrong. Silence is the one thing this
 * must not do.
 */
export const render = (template: string, values: TokenValues, what: string): string =>
  template.replace(TOKEN_RE, (whole, name: string) => {
    if (!(TOKENS as readonly string[]).includes(name)) {
      throw new CliError(
        `${what} uses an unknown token ${whole}`,
        `Known tokens: ${TOKENS.map((t) => `{${t}}`).join(' ')}`,
      );
    }
    const value = values[name as Token];
    if (value === undefined) {
      throw new CliError(
        `${what} uses ${whole}, which has no value here`,
        'Some tokens are only available in some places -- `{port}` needs a port role, `{index}` needs a clone.',
      );
    }
    return value;
  });
