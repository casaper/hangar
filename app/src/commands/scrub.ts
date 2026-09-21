import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, sep } from 'node:path';

import { type Clone, discoverClones } from '../fleet.ts';
import { type Hangar } from '../hangar.ts';
import { blank, heading, note, ok, raw, warn } from '../ui.ts';

/**
 * `hangar scrub` -- find the fleet in text a clone session wrote for somebody else to read.
 *
 * A clone session can see the whole hangar, and its identity file tells it that none of that
 * belongs in what it writes. This is the check behind that instruction, and it exists because
 * the instruction alone was not enough: a draft issue description under `tmp/` explained that
 * its reproduction page loaded "this clone's own `node_modules`", and the steps beside it told
 * the reader the app serves on one clone's dev-server port. Nothing tracked, nothing committed,
 * and both bound for the tracker exactly as written.
 *
 * **It scans `tmp/` and nothing else, and that is a decision rather than a first cut.** `tmp/`
 * is where issue text is drafted, where reproduction cases are built, and where content goes out
 * verbatim -- and it is shared fleet-wide, so a leak there is already everybody's. Pointing this
 * at a clone's working tree instead would print a screen of changed files on every run of a
 * clone mid-feature, and this repo already knows what a check that is red in normal operation is
 * worth. If the committed half turns out to matter it is an additive flag, not a rewrite.
 *
 * **It reports and never edits.** Every finding needs a human judgement about what the sentence
 * was trying to say -- "this clone's own `node_modules`" was making a real point, that the page
 * loads the installed copy rather than a CDN one, and the fix is to say that rather than to
 * delete the fact. A tool that rewrote the line would take the point out with the leak.
 */

/** What kind of fleet thing a line names. One per pattern, so a finding can say why. */
export type LeakKind = 'clone name' | 'fleet path' | 'fleet port' | 'hangar' | 'fleet phrase';

export type LeakPattern = {
  readonly kind: LeakKind;
  readonly pattern: RegExp;
  /**
   * A second condition the whole LINE has to meet before a match counts.
   *
   * Only the ports need one, and they need it badly: a port is four digits, and four digits are
   * also a forum topic id, an identifier and a year. Measured against this fleet's own store,
   * `https://discuss.codemirror.net/t/table-alias-autocompletion-in-lang-sql/4300` was reported
   * as a leaked dev-server port while `on \`localhost:4700\`` on the next file along was a real
   * one. Nothing about the number tells them apart; the words around it do.
   */
  readonly lineContext?: RegExp;
  /** Said to whoever reads the report, in place of the rule they would otherwise go and find. */
  readonly why: string;
};

export type Finding = {
  /** The path as the scan reached it, relative to the hangar root. */
  readonly file: string;
  readonly line: number;
  readonly kind: LeakKind;
  readonly match: string;
  readonly text: string;
  readonly why: string;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `~/code/…` for a path under this machine's home, and the path itself otherwise. */
const tildeForm = (path: string): string | undefined => {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : undefined;
};

/**
 * Every pattern is DERIVED from this hangar, never written down here.
 *
 * Hangar manages any repo and any fleet: a literal `clone_` or `4300` in this file would be one
 * fleet's answer shipped as everybody's. The clone prefix and pad come from the config, the
 * ports from the same derivation the dotenvs are written from, and the CLI's own name from the
 * binary path -- so a hangar that renames any of them is still checked for the right strings.
 *
 * **Colour names are deliberately NOT a pattern.** The palette is `red`, `green`, `blue` and
 * thirteen more ordinary English words, and a ticket about a failing status indicator is full of
 * them. A colour leak in practice arrives attached to a clone ("the blue clone"), which the
 * phrase pattern already catches, so the discriminating power is near zero and the noise is not.
 */
export const leakPatterns = (hangar: Hangar, clones: readonly Clone[]): LeakPattern[] => {
  const prefix = escapeRe(hangar.config.clones.prefix);
  const patterns: LeakPattern[] = [
    {
      kind: 'clone name',
      pattern: new RegExp(`${prefix}\\d{${String(hangar.config.clones.pad)},}`, 'gi'),
      why: 'names one clone directory; the reader has one checkout and no clones',
    },
    {
      kind: 'hangar',
      pattern: new RegExp(`\\b${escapeRe(basename(hangar.paths.bin))}\\b`, 'gi'),
      why: 'names the fleet CLI, which is not on the reader’s PATH',
    },
    {
      /*
       * The phrases, and the only patterns here that are English rather than derived -- they are
       * hangar's own vocabulary, so they are the same in every fleet whatever the prefix is.
       *
       * Two words are deliberately absent, both measured against this fleet's own store rather
       * than guessed. A bare `clone` is an ordinary word in a repository ("clone the repo", "the
       * clone's prototype"). A bare `sibling` is ordinary prose in any codebase -- it matched
       * "the sibling tools" and "sibling element" and never once matched a real leak. Each would
       * have traded the whole signal for one more catch.
       */
      kind: 'fleet phrase',
      pattern: /<clone>|\bthe fleet\b|\b(?:this|each|every|another|other|sibling)[- ]clones?\b/gi,
      why: 'fleet vocabulary; say it about the checkout or the project instead',
    },
  ];

  const rootForms = [hangar.root, tildeForm(hangar.root)].filter((p) => p !== undefined);
  patterns.push({
    kind: 'fleet path',
    pattern: new RegExp(rootForms.map(escapeRe).join('|'), 'g'),
    why: 'a path inside the fleet, and on one machine; nobody else can follow it',
  });

  /*
   * A port is only a leak when the FLEET invented it. Every role's `base` is the project's own
   * documented default and is correct in any document, so `4200` stays quiet while the clone that
   * derived `4300` from it does not -- which is also what keeps an arbitrary port somebody picked
   * for a one-off static server from being reported. Bases are excluded across every role, so a
   * base that happens to equal another clone's derived port is not reported either.
   */
  const bases = new Set(hangar.config.ports.roles.map((role) => role.base));
  const derived = [
    ...new Set(
      clones
        .flatMap((clone) => clone.ports.map((entry) => entry.port))
        .filter((p) => !bases.has(p)),
    ),
  ].sort((a, b) => a - b);
  if (derived.length > 0) {
    patterns.push({
      kind: 'fleet port',
      pattern: new RegExp(`\\b(?:${derived.map(String).join('|')})\\b`, 'g'),
      lineContext: /\bports?\b|localhost|127\.0\.0\.1|\[::1\]/i,
      why: 'a port this fleet derived for one clone; the reader’s checkout uses the base',
    });
  }

  return patterns;
};

/** Every match in one file's text, at most one per line per kind so a repeat is not a list. */
export const findingsIn = (
  text: string,
  patterns: readonly LeakPattern[],
  file: string,
): Finding[] => {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const { kind, pattern, lineContext, why } of patterns) {
      if (lineContext !== undefined && !lineContext.test(line)) continue;
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match === null) continue;
      findings.push({
        file,
        line: index + 1,
        kind,
        match: match[0],
        text: line.trim(),
        why,
      });
    }
  });
  return findings;
};

/**
 * The report, as lines. Pure, so every shape of it can be read side by side without a fleet.
 *
 * Empty when there is nothing to say, which is what lets the `SessionEnd` hook run on every
 * session and stay silent on almost all of them.
 */
export const scrubLines = (findings: readonly Finding[], scanned: number): string[] => {
  if (findings.length === 0) return [];

  const files = [...new Set(findings.map((f) => f.file))].sort();
  const out: string[] = [
    `${String(findings.length)} line${findings.length === 1 ? '' : 's'} in ${String(files.length)} of ${String(scanned)} scanned file${scanned === 1 ? '' : 's'} name this fleet.`,
    '',
  ];

  /*
   * Past a screenful, the file list is the useful answer and the lines are not. A report nobody
   * scrolls to the end of has the same value as no report, and this one runs unattended from a
   * `SessionEnd` hook where nothing is going to scroll at all.
   */
  if (findings.length > DETAIL_LIMIT) {
    for (const file of files) {
      const n = findings.filter((x) => x.file === file).length;
      out.push(`  ${String(n).padStart(4)}  ${file}`);
    }
    out.push('', 'Too many to list. `hangar scrub` prints every line with its reason.');
    return out;
  }

  for (const file of files) {
    out.push(file);
    for (const f of findings.filter((x) => x.file === file)) {
      out.push(`  ${String(f.line).padStart(5)}  ${f.kind.padEnd(12)}  ${f.match}`);
      out.push(`         ${truncateLine(f.text)}`);
    }
    out.push('');
  }

  out.push(
    'These are read by people with one checkout and no fleet. Say it about the project instead:',
    'what is true of "this clone" is almost always true of "this checkout", and that version is',
    'true for the reader too. Nothing here has been changed.',
  );
  return out;
};

const DETAIL_LIMIT = 40;

const truncateLine = (s: string): string => (s.length > 96 ? `${s.slice(0, 95)}…` : s);

/* -------------------------------------------------------------------------- */

/**
 * What a person reads or follows, as an ALLOW-list rather than a list of binaries to skip.
 *
 * Measured, and the measurement is the reason it is this way round: `tmp/` in this fleet holds
 * 77k PNG attachments, Claude Code's own session transcripts and per-agent status scratch, and a
 * deny-list let all of the second and third kind through -- a first run reported 61,538 findings
 * in 919 files, every one of them a machine writing down a path it had genuinely just used. That
 * is not output written for a reader, and a report nobody can finish is worth nothing.
 *
 * So the question this asks is "would somebody read this file, or follow it" -- prose, and the
 * files a reproduction case is made of. A format nobody has thought of yet is skipped by default,
 * which is the safe direction for a check that has to stay readable to stay used.
 */
const DOCUMENT_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.adoc',
  '.rst',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.sql',
  '.yaml',
  '.yml',
]);

/**
 * A dev-server PID file holds a bare number, and a PID can be any number at all -- including one
 * of the ports above. Excluded by the allow-list already; named here because "it is only a
 * number" is exactly the reasoning that would put it back.
 */

const MAX_BYTES = 1_000_000;

/**
 * Every readable text file under the given roots, deduplicated by REAL path.
 *
 * Deduplication is the reason the realpath is the key rather than the path walked in by: every
 * `<clone>/tmp/<name>` is a symlink into one shared store, so a naive walk over a seven-clone
 * fleet would report one draft seven times. A clone's own `tmp/` entry that is still a real
 * directory -- written this session and not yet merged -- resolves to itself and stays a finding
 * of its own, which is exactly the file most likely to be about to go out.
 */
const textFilesUnder = (
  roots: readonly string[],
  hangarRoot: string,
  modifiedSince: number | undefined,
): Map<string, string> => {
  const found = new Map<string, string>();
  const seenDirs = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue; // a broken link, or something that went away mid-walk
      }
      if (stat.isDirectory()) {
        // A dot-directory under `tmp/` is machine scratch by convention -- agent status files,
        // Claude Code's own session store -- and is nobody's output. Skipped whole, so the walk
        // never pays for it either.
        if (!entry.startsWith('.')) walk(path, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.size === 0) continue;
      if (modifiedSince !== undefined && stat.mtimeMs < modifiedSince) continue;
      if (!DOCUMENT_EXT.has(extname(path).toLowerCase())) continue;
      try {
        const realFile = realpathSync(path);
        if (found.has(realFile)) continue;
        const text = readFileSync(path, 'utf8');
        if (text.includes('\u0000')) continue; // binary with a text-ish name
        found.set(realFile, relative(hangarRoot, path));
      } catch {
        continue;
      }
    }
  };

  for (const root of roots) walk(root, 0);
  return found;
};

export type ScrubOptions = {
  /** Say nothing at all when there is nothing to report -- what the `SessionEnd` hook passes. */
  readonly quiet?: boolean | undefined;
  /**
   * Only look at files changed in the last N hours.
   *
   * The hook passes one and a person normally does not, and the difference is what each is for.
   * Run by hand the interesting answer is the whole store, backlog included -- the first run in
   * this fleet found 454 lines in 89 files, every one of them written before the rule existed.
   * A hook that reported that at the end of every session would be reporting somebody else's
   * backlog forever, which is the shape of check this repo already knows nobody reads. Bounded
   * to a day, it reports what the session that is ending might actually have written.
   */
  readonly recentHours?: number | undefined;
};

/**
 * Scan the shared store and every clone's own `tmp/`.
 *
 * Both, rather than just the shared one: a ticket directory the clone's own session created is a
 * REAL directory in that clone until `tmp merge` runs at `SessionEnd`, and that is precisely the
 * draft somebody is about to paste somewhere.
 */
export const scrub = (hangar: Hangar, options: ScrubOptions = {}): number => {
  const clones = discoverClones(hangar);
  const roots = [hangar.paths.tmp, ...clones.map((clone) => join(clone.path, 'tmp'))];
  const since =
    options.recentHours === undefined
      ? undefined
      : Date.now() - options.recentHours * 60 * 60 * 1000;
  const files = textFilesUnder(roots, hangar.root, since);
  const patterns = leakPatterns(hangar, clones);

  const findings: Finding[] = [];
  for (const [realPath, shown] of files) {
    try {
      findings.push(...findingsIn(readFileSync(realPath, 'utf8'), patterns, shown));
    } catch {
      continue;
    }
  }

  const lines = scrubLines(findings, files.size);
  if (lines.length === 0) {
    if (options.quiet !== true) {
      ok(`nothing in tmp/ names the fleet — ${String(files.size)} files scanned`);
    }
    return 0;
  }

  if (options.quiet === true) blank();
  heading('hangar scrub');
  warn(lines[0] ?? '');
  for (const line of lines.slice(1)) raw(line);
  if (options.quiet === true) {
    note('This ran as this session ended. `hangar scrub` reruns it at any time.');
  }
  return findings.length;
};
