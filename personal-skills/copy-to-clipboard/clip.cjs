#!/usr/bin/env node
'use strict';
// Copies stdin to the system clipboard, or with --paste prints the clipboard to stdout.
// CommonJS on purpose: the nearest package.json above this file declares no "type".

const { spawnSync } = require('child_process');
const { readFileSync } = require('fs');
const os = require('os');

const args = new Set(process.argv.slice(2));
const PASTE = args.has('--paste');
const KEEP_NEWLINE = args.has('--keep-newline');

const has = (bin) => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;

function isWsl() {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** [copyCommand, pasteCommand]; either may be null when this machine has no tool for it. */
function clipboardCommands() {
  const platform = os.platform();
  if (platform === 'darwin') return [['pbcopy'], ['pbpaste']];
  const powershellPaste = (exe) => [exe, '-NoProfile', '-Command', 'Get-Clipboard -Raw'];
  if (platform === 'win32') return [['clip'], powershellPaste('powershell')];
  if (isWsl() && has('clip.exe')) {
    return [['clip.exe'], has('powershell.exe') ? powershellPaste('powershell.exe') : null];
  }
  if (process.env.WAYLAND_DISPLAY && has('wl-copy')) {
    return [['wl-copy'], has('wl-paste') ? ['wl-paste', '--no-newline'] : null];
  }
  if (has('xclip')) {
    return [
      ['xclip', '-selection', 'clipboard'],
      ['xclip', '-selection', 'clipboard', '-o'],
    ];
  }
  if (has('xsel')) return [['xsel', '--clipboard', '--input'], ['xsel', '--clipboard', '--output']];
  return [null, null];
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(cmd, input) {
  const result = spawnSync(cmd[0], cmd.slice(1), { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`${cmd[0]} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${cmd[0]} failed: ${result.stderr?.toString().trim() ?? ''}`);
  return result.stdout.toString('utf8');
}

const NO_TOOL =
  'No clipboard utility found. macOS has pbcopy/pbpaste built in; on Linux install ' +
  'wl-clipboard (Wayland), xclip or xsel.';

const [copyCmd, pasteCmd] = clipboardCommands();

if (PASTE) {
  if (!pasteCmd) fail(NO_TOOL);
  process.stdout.write(run(pasteCmd));
  process.exit(0);
}

if (!copyCmd) fail(NO_TOOL);

let content = readFileSync(0, 'utf8');
// A heredoc always ends in a newline, and a pasted trailing newline sends a chat message early.
if (!KEEP_NEWLINE) content = content.replace(/\r?\n$/, '');

run(copyCmd, content);

// Read it back: an exit code of 0 from the copy tool does not prove the clipboard holds it.
const chars = [...content].length;
if (!pasteCmd) {
  process.stdout.write(`copied ${chars} chars (not verified: no paste tool on this machine)\n`);
  process.exit(0);
}
const normalise = (s) => s.replace(/\r\n/g, '\n').replace(/\n$/, '');
const readBack = run(pasteCmd);
if (normalise(readBack) !== normalise(content)) {
  fail(`clipboard mismatch: wrote ${chars} chars, read back ${[...readBack].length}`);
}
process.stdout.write(`copied ${chars} chars\n`);
