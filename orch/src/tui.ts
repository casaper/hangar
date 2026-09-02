import pc from 'picocolors';

import { visibleWidth } from './ui.ts';

/**
 * The fleet's one interactive list.
 *
 * Deliberately tiny, and with no dependency: the CLI ships four runtime packages, and a full
 * TUI toolkit for a single-select list would be the largest of them. What is needed is one
 * screen -- a list you move through, a detail pane for whatever is highlighted, enter to take
 * it, escape to leave with nothing taken.
 *
 * Both the row and the detail pane are rendered by the CALLER, as functions of the available
 * width: only the caller knows which part of a row is expendable when the terminal is narrow,
 * and clipping a line to fit is much worse than dropping the column that did not matter.
 */
const ESC = '\x1b';
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR = `${ESC}[H${ESC}[2J`;
const RESET = `${ESC}[0m`;

const ANSI_SEQ = new RegExp(`^${ESC}\\[[0-9;]*[A-Za-z]`);

/**
 * Cut a line to `max` visible columns without cutting an escape sequence in half -- half of a
 * `[38;2;…m` leaves the rest of the screen painted in whatever the fragment decoded to.
 */
const clip = (line: string, max: number): string => {
  if (visibleWidth(line) <= max) return line;
  let out = '';
  let width = 0;
  let i = 0;
  while (i < line.length) {
    const escape = ANSI_SEQ.exec(line.slice(i));
    if (escape) {
      out += escape[0];
      i += escape[0].length;
      continue;
    }
    if (width >= max - 1) break;
    out += line.charAt(i);
    width += 1;
    i += 1;
  }
  return `${out}…${RESET}`;
};

export type PickChoice = {
  /** One line, as wide as `width` allows. May contain colour. */
  readonly row: (width: number) => string;
  /** The pane shown while this choice is highlighted; padded or cut to `detailHeight`. */
  readonly detail: (width: number) => readonly string[];
};

export type PickOptions = {
  /** Shown above the list, e.g. the clone this list belongs to. */
  readonly heading: (width: number) => string;
  readonly choices: readonly PickChoice[];
  /** Lines reserved for the detail pane, so the list does not jump as the selection moves. */
  readonly detailHeight: number;
  /** What marks the highlighted row. Defaults to `>`; a clone list passes its own bullet. */
  readonly marker?: string | undefined;
};

/**
 * `isTTY`, `columns` and `rows` are typed as always-present and are NOT: a redirected stream
 * has none of them. Both helpers take the honest type, which is also what keeps the checks
 * from being flagged as unnecessary -- and what stops `render` splitting a `NaN`-row screen.
 */
const isTty = (flag: boolean | undefined): boolean => flag === true;

const dimension = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** True when a list can be shown at all -- both ends of the terminal must be a real tty. */
export const canPick = (): boolean => isTty(process.stdin.isTTY) && isTty(process.stdout.isTTY);

const CTRL_C = '\x03';

const KEYS_UP = new Set([`${ESC}[A`, 'k']);
const KEYS_DOWN = new Set([`${ESC}[B`, 'j']);
const KEYS_TOP = new Set([`${ESC}[H`, 'g']);
const KEYS_BOTTOM = new Set([`${ESC}[F`, 'G']);
const KEYS_TAKE = new Set(['\r', '\n']);
/** Bare escape, `q` and Ctrl-C all mean "leave with nothing taken". */
const KEYS_CANCEL = new Set([ESC, 'q', CTRL_C]);
const KEY_PAGE_UP = `${ESC}[5~`;
const KEY_PAGE_DOWN = `${ESC}[6~`;

const HINT = 'up/down move · enter choose · esc cancel';

/**
 * Show the list and resolve with the chosen index, or undefined if the user escaped.
 *
 * Read a CHUNK at a time rather than a byte: an arrow key arrives as the three bytes
 * `ESC [ A` in one chunk and a lone `ESC` chunk is the escape key, so the two need no
 * disambiguation timer -- which is the usual reason a hand-rolled reader feels laggy.
 *
 * The terminal is restored on every exit path, including escape and Ctrl-C: raw mode back as
 * it was, stdin paused, cursor shown, alternate screen left. A command that returns with the
 * tty still in raw mode leaves the shell unusable.
 */
export const pickOne = async (options: PickOptions): Promise<number | undefined> => {
  const { choices, detailHeight } = options;
  if (choices.length === 0) return undefined;

  const marker = options.marker ?? pc.bold('>');
  // The marker is usually coloured, so its string length is mostly escape bytes -- the row
  // budget must come from what the terminal actually shows.
  const markerWidth = visibleWidth(marker);
  const blank = ' '.repeat(markerWidth);

  let selected = 0;
  let offset = 0;

  const render = (): void => {
    const width = Math.max(20, dimension(process.stdout.columns, 80));
    const rows = Math.max(10, dimension(process.stdout.rows, 24));
    // heading, blank, list, blank, hint, rule, detail.
    const listHeight = Math.max(3, Math.min(choices.length, rows - detailHeight - 6));
    if (selected < offset) offset = selected;
    if (selected >= offset + listHeight) offset = selected - listHeight + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, choices.length - listHeight)));

    const lines: string[] = [options.heading(width), ''];
    const end = Math.min(choices.length, offset + listHeight);
    for (let i = offset; i < end; i += 1) {
      const choice = choices[i];
      if (choice === undefined) continue;
      const body = choice.row(width - markerWidth - 1);
      lines.push(i === selected ? `${marker} ${body}` : `${blank} ${pc.dim(body)}`);
    }
    const above = offset > 0 ? `${String(offset)} above · ` : '';
    const below = choices.length > end ? `${String(choices.length - end)} below · ` : '';
    lines.push('', pc.dim(`${above}${below}${HINT}`), pc.dim('─'.repeat(Math.min(width, 78))));
    const detail = [...(choices[selected]?.detail(width) ?? [])].slice(0, detailHeight);
    while (detail.length < detailHeight) detail.push('');
    lines.push(...detail);

    process.stdout.write(CLEAR + lines.map((line) => clip(line, width)).join('\r\n'));
  };

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  return await new Promise<number | undefined>((resolve) => {
    const finish = (value: number | undefined): void => {
      stdin.off('data', onData);
      process.stdout.off('resize', render);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
      resolve(value);
    };

    const onData = (chunk: string): void => {
      if (KEYS_CANCEL.has(chunk)) {
        finish(undefined);
        return;
      }
      if (KEYS_TAKE.has(chunk)) {
        finish(selected);
        return;
      }
      if (KEYS_UP.has(chunk)) selected = Math.max(0, selected - 1);
      else if (KEYS_DOWN.has(chunk)) selected = Math.min(choices.length - 1, selected + 1);
      else if (KEYS_TOP.has(chunk)) selected = 0;
      else if (KEYS_BOTTOM.has(chunk)) selected = choices.length - 1;
      else if (chunk === KEY_PAGE_UP) selected = Math.max(0, selected - 10);
      else if (chunk === KEY_PAGE_DOWN) selected = Math.min(choices.length - 1, selected + 10);
      else return;
      render();
    };

    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    process.stdout.on('resize', render);
    render();
  });
};
