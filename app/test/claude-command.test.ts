import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  claudeArgvFor,
  claudeArgvFromProcess,
  claudeHelpWith,
  isMode,
  resolveClaudeBinary,
  splitClaudeArgv,
  TAB_WINDOWS,
} from '../src/commands/claude.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * `hangar claude`'s four pure builders.
 *
 * **A golden capture cannot reach any of this**, which is the whole reason the file exists. The
 * command's output is a live tmux server and an attached terminal; what it gets RIGHT or wrong
 * is an argv it hands to another program, and the failures are all of the shape "typechecks,
 * runs, and does the wrong thing quietly":
 *
 * - `--model sonnet` arriving as `--model` with its value lifted out of sequence;
 * - hangar's own `-n` silently overriding a caller's;
 * - `--resume` reaching claude BEFORE `--settings`, so a resumed session comes back with the
 *   right badge and none of the mode's permissions -- the failure that looks like success;
 * - `resolveClaudeBinary` returning the proxy that called it, which recurses until the process
 *   table gives up.
 *
 * Properties rather than snapshots, per this package's convention: the assertions say what must
 * be true of the argv, not what its bytes are.
 */

const hangar = syntheticHangar();

// ---------------------------------------------------------------------------------------------
// splitClaudeArgv
// ---------------------------------------------------------------------------------------------

test('the mode defaults to ops, and nothing is consumed that hangar does not own', () => {
  const inv = splitClaudeArgv([]);
  assert.equal(inv.mode, 'ops');
  assert.equal(inv.replace, false);
  assert.equal(inv.help, false);
  assert.deepEqual(inv.passthrough, []);
});

test('-m is found at every position, which is the whole reason commander does not parse this', () => {
  // Trailing is how a person actually types it, and it is the case `passThroughOptions` breaks.
  for (const argv of [
    ['-m', 'dev', '--resume', 'abc'],
    ['--resume', 'abc', '-m', 'dev'],
    ['--resume', 'abc', '--mode', 'dev'],
    ['--mode=dev', '--resume', 'abc'],
    ['--resume', 'abc', '--mode=dev'],
  ]) {
    const inv = splitClaudeArgv(argv);
    assert.equal(inv.mode, 'dev', `-m was not found in ${argv.join(' ')}`);
    assert.deepEqual(
      inv.passthrough,
      ['--resume', 'abc'],
      `passthrough was disturbed by ${argv.join(' ')}`,
    );
  }
});

test('an option and its value stay adjacent and in order', () => {
  // THE bug commander's `allowUnknownOption` would introduce: `sonnet` is `--model`'s value, not
  // a positional, and nothing in hangar knows that -- so nothing may reorder around it.
  const inv = splitClaudeArgv(['--model', 'sonnet', '-p', 'hi', '--add-dir', '/x']);
  assert.deepEqual(inv.passthrough, ['--model', 'sonnet', '-p', 'hi', '--add-dir', '/x']);
  assert.equal(inv.mode, 'ops');
});

test('-- hands everything after it to claude verbatim, a literal -m included', () => {
  const inv = splitClaudeArgv(['--', '-m', 'literal', '--replace']);
  assert.equal(inv.mode, 'ops', 'a mode after -- is claude’s, not hangar’s');
  assert.equal(inv.replace, false, '--replace after -- is claude’s too');
  assert.deepEqual(inv.passthrough, ['-m', 'literal', '--replace']);
});

test('an unknown mode is refused rather than defaulted', () => {
  assert.throws(() => splitClaudeArgv(['-m', 'prod']), /unknown mode "prod"/);
  assert.throws(() => splitClaudeArgv(['-m']), /needs a mode/);
});

test('the shell tab is a window and not a mode, so -m cannot name it', () => {
  // The shell tab has no settings file and no remit, so a `-m shell` that parsed would launch a
  // session with neither -- which looks exactly like a mode until you read its permissions.
  assert.equal(isMode('shell'), false);
  assert.throws(() => splitClaudeArgv(['-m', 'shell']), /unknown mode "shell"/);
});

test('no two tabs claim the same window index', () => {
  // tmux refuses `new-window -t` on an occupied index, so a collision here is a command that
  // cannot rebuild its own workspace. The table is derived, which is what makes this a property.
  const indexes = Object.values(TAB_WINDOWS);
  assert.equal(new Set(indexes).size, indexes.length, `two tabs share an index: ${indexes.join()}`);
  assert.ok(indexes.length >= 3, 'the shell tab is missing from the table');
});

test('hangar’s own flags are consumed and never forwarded', () => {
  const inv = splitClaudeArgv(['--replace', '--yes', '--dry-run', '-m', 'dev', '-p', 'x']);
  assert.equal(inv.replace, true);
  assert.equal(inv.yes, true);
  assert.equal(inv.dryRun, true);
  assert.deepEqual(inv.passthrough, ['-p', 'x'], 'a hangar flag reached claude');
});

// ---------------------------------------------------------------------------------------------
// claudeArgvFromProcess
// ---------------------------------------------------------------------------------------------

test('the subcommand boundary survives a hangar directory named claude', () => {
  // `--hangar <path>` is the only global option taking a value, so its value is the one token
  // that could be mistaken for the subcommand. Skipping it is what makes this unambiguous.
  assert.deepEqual(claudeArgvFromProcess(['--hangar', 'claude', 'claude', '-m', 'dev']), [
    '-m',
    'dev',
  ]);
  assert.deepEqual(claudeArgvFromProcess(['claude']), []);
  assert.deepEqual(claudeArgvFromProcess(['list']), []);
});

// ---------------------------------------------------------------------------------------------
// claudeArgvFor -- the ordering that makes resuming into a mode work
// ---------------------------------------------------------------------------------------------

test('the mode’s settings and remit precede anything passed through', () => {
  const argv = claudeArgvFor(hangar, 'ops', ['--resume', 'abc']);
  const settings = argv.indexOf('--settings');
  const prompt = argv.indexOf('--append-system-prompt-file');
  const resume = argv.indexOf('--resume');
  assert.ok(settings !== -1 && prompt !== -1 && resume !== -1);
  // Reversed, `--resume` would be honoured with no permissions and no remit, and the session
  // would come back wearing the badge of a mode it is not in.
  assert.ok(settings < resume, '--settings must precede --resume');
  assert.ok(prompt < resume, '--append-system-prompt-file must precede --resume');
});

test('each mode names its own settings file and its own remit', () => {
  for (const mode of ['ops', 'dev'] as const) {
    const argv = claudeArgvFor(hangar, mode, []);
    assert.equal(
      argv[argv.indexOf('--settings') + 1],
      join(hangar.root, '.claude', 'modes', `${mode}.settings.json`),
    );
    assert.equal(
      argv[argv.indexOf('--append-system-prompt-file') + 1],
      join(hangar.root, '.claude', 'modes', `${mode}.md`),
    );
  }
  // Two modes, two different files -- the assertion that would catch a copy-paste.
  assert.notDeepEqual(claudeArgvFor(hangar, 'ops', []), claudeArgvFor(hangar, 'dev', []));
});

test('a caller who names the session keeps their name', () => {
  // `-n` is claude's `--name`, not a dry run, and hangar uses it for the mode badge. A caller
  // passing their own must win, or `-n` would be a flag that silently does nothing.
  for (const named of [['-n', 'mine'], ['--name', 'mine'], ['--name=mine']]) {
    const argv = claudeArgvFor(hangar, 'ops', named);
    assert.equal(
      argv.filter((t) => t === '-n' || t === '--name' || t.startsWith('--name=')).length,
      1,
      `hangar added a second name alongside ${named.join(' ')}`,
    );
    assert.ok(!argv.includes('hangar ops'), 'hangar overrode the caller’s session name');
  }
  // And with nothing passed, hangar does supply one -- that is what the mode badge reads.
  assert.ok(claudeArgvFor(hangar, 'ops', []).includes('hangar ops'));
});

// ---------------------------------------------------------------------------------------------
// resolveClaudeBinary -- the recursion guard
// ---------------------------------------------------------------------------------------------

test('the proxy directory is skipped, so the shim can never resolve to itself', () => {
  const shim = join(hangar.root, '.local', 'bin');
  // Nothing exists under a synthetic root, so the honest answer is "not found" -- and the
  // property under test is that the shim is not it.
  assert.equal(resolveClaudeBinary(shim, hangar.root), undefined);
  assert.notEqual(resolveClaudeBinary(`${shim}:/usr/bin`, hangar.root), join(shim, 'claude'));
  assert.equal(resolveClaudeBinary(undefined, hangar.root), undefined);
  assert.equal(resolveClaudeBinary('', hangar.root), undefined);
});

test('a real binary on PATH is found, and the shim ahead of it does not shadow it', () => {
  // `/usr/bin/env` exists everywhere this suite runs, so it stands in for `claude`: the question
  // is only which DIRECTORY the walk accepts, never what the file is.
  const shim = join(hangar.root, '.local', 'bin');
  assert.equal(resolveClaudeBinary('/usr/bin', hangar.root, 'env'), '/usr/bin/env');
  assert.equal(resolveClaudeBinary(`${shim}:/usr/bin`, hangar.root, 'env'), '/usr/bin/env');
});

// ---------------------------------------------------------------------------------------------
// claudeHelpWith
// ---------------------------------------------------------------------------------------------

const CLAUDE_HELP = [
  'Usage: claude [options]',
  '',
  'Options:',
  '  --mcp-config <configs...>             Load MCP servers from JSON files',
  '  --model <model>                       Model for the current session',
  '  -p, --print                           Print response and exit',
  '',
].join('\n');

test('the mode row is inserted where a reader scans for it, in claude’s own column', () => {
  const out = claudeHelpWith(CLAUDE_HELP).split('\n');
  const at = out.findIndex((l) => l.includes('-m, --mode'));
  const model = out.findIndex((l) => /^\s+--model /.test(l));
  assert.ok(at !== -1, 'the flag was not documented at all');
  assert.ok(at < model, '-m, --mode should sort before --model');
  // Same description column as the rows around it: a row that does not line up reads as a bug.
  // Measured as "where the text after the last run of two-or-more spaces begins", which is the
  // only definition that holds for both `-m, --mode <ops|dev>` and `--model <model>`.
  const column = (line: string): number => /^ +\S(?:.*?\S)? {2,}/.exec(line)?.[0].length ?? -1;
  assert.equal(column(out[at] ?? ''), column(out[model] ?? ''));
  // Nothing of claude's own was dropped on the way through.
  for (const line of CLAUDE_HELP.split('\n')) assert.ok(out.includes(line), `lost: ${line}`);
});

test('a help page with no --model row still documents the flag, rather than failing', () => {
  // claude's help layout is not a contract. Losing the anchor must cost a scroll, not the flag.
  const out = claudeHelpWith('Usage: claude\n\nOptions:\n  -p, --print   Print and exit\n');
  assert.match(out, /-m, --mode <ops\|dev>/);
  assert.match(out, /--replace/);
  assert.match(out, /Added by hangar/);
  assert.match(out, /-p, --print/, 'claude’s own help was dropped');
});

test('an empty help page is survivable, because it means claude --help itself failed', () => {
  // This is also the answer when claude is not installed at all: `hangar claude --help` reports
  // ahead of the missing-binary refusal, precisely because that is when it is most wanted.
  const out = claudeHelpWith('');
  assert.match(out, /-m, --mode <ops\|dev>/);
  assert.match(out, /--replace/);
  assert.match(out, /--dry-run/);
  // The heading may not claim a page that is not there.
  assert.doesNotMatch(out, /everything else above/);
  assert.match(out, /every other flag reaches it unchanged/);
  assert.ok(!out.startsWith('\n'), 'no leading blank where the page would have been');
});
