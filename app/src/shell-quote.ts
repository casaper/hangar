/**
 * Quoting a value into generated shell and tmux text, and reading the first word back out.
 *
 * One module, so every generator quotes the same way: a path with a space breaks a bare hook
 * command, bar job or key binding, a `'` breaks a `NAME='...'` assignment, and a reader that
 * splits on the first space names half a path. Every helper here leaves a value that needs
 * nothing EXACTLY as it is, so a hangar whose root has no space or quote in it gets byte-identical
 * artifacts.
 */

const SAFE_BARE = /^[A-Za-z0-9_./:=-]+$/;

/**
 * One word for a POSIX shell: bare when it is safe bare, single-quoted otherwise. Quote only what
 * needs it, so the common line carries no quotes at all.
 */
export const shellQuote = (value: string): string =>
  SAFE_BARE.test(value) ? value : singleQuoted(value);

/** Always single-quoted, an inner `'` closed, escaped and reopened. For `NAME='...'` lines. */
export const singleQuoted = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * One word for a shell command that lives INSIDE a single-quoted tmux option value, where a `'`
 * would end the value: double quotes instead, with `\`, `"`, `$` and a backtick escaped for the
 * shell, and `#` doubled because tmux expands formats in a job or `run-shell` command first.
 * Bare when nothing needs it.
 */
export const tmuxShellWord = (value: string): string =>
  SAFE_BARE.test(value)
    ? value
    : `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`).replace(/#/g, '##')}"`;

/**
 * The first word of a shell command line, unquoted -- enough for the quoting `shellQuote` does:
 * a single-quoted word with `'\''` inside it, or a bare one. PURE.
 */
export const firstShellWord = (command: string): string => {
  const trimmed = command.trimStart();
  if (!trimmed.startsWith("'")) return trimmed.split(/\s/)[0] ?? '';
  let word = '';
  let rest = trimmed;
  while (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end < 0) return word + rest.slice(1);
    word += rest.slice(1, end);
    rest = rest.slice(end + 1);
    if (rest.startsWith("\\'")) {
      word += "'";
      rest = rest.slice(2);
    } else break;
  }
  return word;
};
