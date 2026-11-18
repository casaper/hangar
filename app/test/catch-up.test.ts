import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  busyRunners,
  catchUpClosingMessage,
  catchUpPauseMessage,
  conflictsMessage,
  doneMessage,
  publishedMessage,
  restageDecision,
} from '../src/commands/catch-up.ts';
import { rebranchNameProblems } from '../src/commands/rebranch.ts';
import { callerSession, type ProcessRow } from '../src/procs.ts';
import { THIS_REPOS_TICKET_PREFIX } from './fixture.ts';

/**
 * `hangar catch-up`, `hangar pr rebranch` and the gate's `follow-rename`: the decisions each
 * makes, as properties. The git and forge halves are exercised by hand (see the sync reference
 * in hangar-internals); these are the parts that can be wrong without any repository at all.
 */

const row = (pid: number, ppid: number, command = 'x'): ProcessRow => ({ pid, ppid, command });

test('the calling session is found up the parent chain, and only that one', () => {
  // claude(100) -> zsh(200) -> sh bin/hangar(300) -> node(400); another session at 900
  const table = new Map([
    [400, row(400, 300)],
    [300, row(300, 200)],
    [200, row(200, 100)],
    [100, row(100, 1)],
    [900, row(900, 1)],
  ]);
  const sessions = [{ pid: 100 }, { pid: 900 }];
  assert.equal(callerSession(table, 400, sessions)?.pid, 100);
  assert.equal(callerSession(table, 900, sessions)?.pid, 900);
  assert.equal(
    callerSession(new Map([[5, row(5, 1)]]), 5, sessions),
    undefined,
    'from a plain shell',
  );
  const loop = new Map([
    [7, row(7, 8)],
    [8, row(8, 7)],
  ]);
  assert.equal(callerSession(loop, 7, sessions), undefined, 'a looping table ends');
});

test('staging comes back only where the stash index still describes HEAD', () => {
  const base = { conflicted: false, stagedBefore: true, unchangedByUpdate: true, inHead: true };
  assert.equal(restageDecision(base), 'from-stash-index');
  assert.equal(restageDecision({ ...base, unchangedByUpdate: false }), 'unstage');
  assert.equal(restageDecision({ ...base, stagedBefore: false }), 'unstage');
  assert.equal(restageDecision({ ...base, conflicted: true }), 'leave', 'the caller resolves it');
  assert.equal(
    restageDecision({ ...base, stagedBefore: false, inHead: false }),
    'leave',
    'a new file stays added rather than becoming untracked',
  );
});

test('a test run inside the clone blocks a stash; a server or a sibling does not', () => {
  const rows = [
    row(1, 0, 'node /x/node_modules/.bin/playwright test spec.ts'),
    row(2, 0, 'node /x/node_modules/.bin/playwright show-report'),
    row(3, 0, 'node /x/node_modules/.bin/vitest run'),
    row(4, 0, 'node ng serve'),
    // Long-lived servers that never exit on their own: an editor's test server, the session's
    // own Playwright MCP, and a browser one of them launched.
    row(5, 0, 'node angular/node_modules/@playwright/test/cli.js test-server -c pw.config.ts'),
    row(6, 0, 'node /x/node_modules/@playwright/mcp/cli.js --config /x/playwright-mcp.config.json'),
    row(7, 0, '/cache/ms-playwright/chromium-1200/chrome --headless'),
    row(8, 0, 'node /x/node_modules/@playwright/test/cli.js test --project mcp'),
  ];
  const cwds = new Map([
    [1, '/h/wt-001/angular'],
    [2, '/h/wt-001'],
    [3, '/h/wt-0010'],
    [4, '/h/wt-001'],
    [5, '/h/wt-001'],
    [6, '/h/wt-001'],
    [7, '/h/wt-001'],
    [8, '/h/wt-001'],
  ]);
  assert.deepEqual(
    busyRunners(rows, cwds, '/h/wt-001').map((r) => r.pid),
    [1, 8],
  );
});

test('every catch-up message is generic and says what to do next', () => {
  const texts = [
    catchUpPauseMessage('origin/main'),
    catchUpClosingMessage('finished', 'origin/main', false),
    catchUpClosingMessage('aborted', 'origin/main', true),
    catchUpClosingMessage('aborted', 'origin/main', false),
    publishedMessage('feature/x', true, { id: 7, url: 'https://forge/pr/7' }),
    conflictsMessage('rebase', ['a.ts'], 'abc123 subject'),
    conflictsMessage('stash', ['a.ts', 'b.ts'], undefined),
    doneMessage('origin/main', true, 'kept'),
    doneMessage('origin/main', false, 'nothing-stashed'),
  ];
  for (const text of texts) {
    // The target arrives as a parameter; a default branch or a ticket in the TEXT would be one
    // repo's, said to every hangar.
    assert.doesNotMatch(text, /master/i, text);
    assert.ok(!text.includes(THIS_REPOS_TICKET_PREFIX), text);
  }
  assert.match(catchUpPauseMessage('origin/main'), /^SYNC PAUSE/);
  assert.match(catchUpClosingMessage('aborted', 'r', false), /^SYNC ABORTED.*wait/);
  assert.match(conflictsMessage('stash', ['a.ts'], undefined), /--continue[\s\S]*--abort/);
  assert.match(publishedMessage('b', false, { id: 7, url: 'u' }), /#7/);
});

test('a rebranch name keeps the prefix and the ticket and gives nothing away', () => {
  const old = 'feature/ABC-1323_grid_preset';
  const problems = (next: string): string[] => rebranchNameProblems(old, next, 'ABC-1323', ['ABC']);
  assert.deepEqual(problems('feature/ABC-1323_grid_presets'), []);
  assert.deepEqual(problems('feature/ABC-1323_preset_of_grid'), []);
  for (const bad of [
    'feature/ABC-1323_grid_preset',
    'FEATURE/abc-1323_GRID_PRESET',
    'bugfix/ABC-1323_grid_presets',
    'feature/grid_presets',
    'feature/ABC-1323_grid_preset_v2',
    'feature/ABC-1323_grid_preset_recreated',
    'feature/ABC-1323_new_grid_preset',
    'feature/ABC-1323_grid_preset-2',
    'feature/ABC-1323_grid preset',
  ]) {
    assert.notDeepEqual(problems(bad), [], bad);
  }
  assert.deepEqual(
    rebranchNameProblems('feature/ABC-9_new_toolbar', 'feature/ABC-9_new_toolbars', 'ABC-9', [
      'ABC',
    ]),
    [],
    'a word the old name already had is fine',
  );
});

const gate = createRequire(import.meta.url)(
  join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin', 'hangar-commit-gate'),
) as {
  followsRename: (
    state: { locked?: boolean; branch?: string } | null,
    current: string,
    storedExists: boolean,
    newestSubject: string,
  ) => boolean;
  releasesGate: (command: string) => boolean;
};

test('the gate lock follows a real rename and nothing else', () => {
  const state = { locked: true, branch: 'feature/a' };
  const renamed = 'Branch: renamed refs/heads/feature/a to refs/heads/feature/b';
  assert.equal(gate.followsRename(state, 'feature/b', false, renamed), true);
  assert.equal(
    gate.followsRename(state, 'feature/b', true, renamed),
    false,
    'old branch still there',
  );
  assert.equal(gate.followsRename(state, 'feature/b', false, 'checkout: moving'), false);
  assert.equal(gate.followsRename(state, 'feature/c', false, renamed), false, 'a different branch');
  assert.equal(gate.followsRename({ branch: 'feature/a' }, 'feature/b', false, renamed), false);
  assert.equal(gate.followsRename(null, 'feature/b', false, renamed), false);
  assert.equal(gate.releasesGate('hangar-commit-gate follow-rename'), false);
});
