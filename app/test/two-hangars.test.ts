import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  claudeLocalMdPath,
  envLocalContent,
  envLocalPath,
  envrcPrivateContent,
  excludeBlock,
  settingsPath,
} from '../src/clone-config.ts';
import { cloneAt } from '../src/fleet.ts';
import { themePath } from '../src/generate/theme-json.ts';
import { hangarClaudeLocalMdContent } from '../src/hangar-files.ts';
import { fixtureConfigText, syntheticHangar } from './fixture.ts';

/**
 * Two hangars rendered side by side in ONE process, interleaved.
 *
 * **This is the one thing no golden capture can express**, and it is why the suite exists at all:
 * `dev/golden.sh` runs the binary twice, in two processes, so a module-level singleton or a cache
 * keyed on nothing would pass it every time and still hand the second hangar the first one's
 * answers. It is also the premise the whole tool rests on -- several hangars on one machine --
 * and the reason `Hangar` is threaded from `cli.ts` rather than held in a module.
 *
 * The two below disagree on every axis that produces a path or a port: id, root, clone prefix,
 * pad, port offset, env keys, secrets file. They are built and read INTERLEAVED rather than one
 * after the other, because a stale cache is only visible when the second read of the first
 * hangar happens after the second hangar has been touched.
 */

const OTHER_CONFIG = fixtureConfigText()
  .replace('\nid: wt\n', '\nid: other\n')
  .replace('  prefix: wt-\n', '  prefix: box_\n')
  .replace('  pad: 3\n', '  pad: 2\n')
  .replace('  offset: 37\n', '  offset: 58\n')
  .replaceAll('FIXTURE_', 'OTHER_')
  .replace('  file: .env.fixture-shared\n', '  file: .env.other-shared\n');

test('two hangars in one process share no path and no port', () => {
  const a = syntheticHangar({ root: '/hangars/alpha', claudeDir: '/synthetic-claude' });
  const b = syntheticHangar({
    root: '/hangars/beta',
    claudeDir: '/synthetic-claude',
    configText: OTHER_CONFIG,
  });

  assert.equal(a.id, 'wt');
  assert.equal(b.id, 'other');

  // Interleaved: a, b, a again. A cache keyed on nothing shows up on the third read.
  const a1 = cloneAt(a, 1);
  const b1 = cloneAt(b, 1);
  const a1Again = cloneAt(a, 1);

  assert.equal(a1.name, 'wt-001');
  assert.equal(b1.name, 'box_01');
  assert.equal(a1Again.name, 'wt-001', 'the first hangar answered differently after the second');
  assert.equal(a1Again.path, '/hangars/alpha/wt-001');
  assert.equal(b1.path, '/hangars/beta/box_01');

  // Ports: same bases, different residue classes mod 100, so no clone of either can ever meet a
  // clone of the other. That is the whole guarantee the offset exists for.
  const aPorts = a1.ports.map((entry) => entry.port);
  const bPorts = b1.ports.map((entry) => entry.port);
  assert.deepEqual(aPorts, [3037, 5469, 8117]);
  assert.deepEqual(bPorts, [3058, 5490, 8138]);
  for (const index of [1, 2, 3, 7, 40]) {
    const mine = new Set(cloneAt(a, index).ports.map((entry) => entry.port));
    for (const other of [1, 2, 3, 7, 40]) {
      for (const port of cloneAt(b, other).ports.map((entry) => entry.port)) {
        assert.ok(!mine.has(port), `port ${port} is claimed by both hangars`);
      }
    }
  }
});

test('every path either hangar produces belongs to that hangar alone', () => {
  const a = syntheticHangar({ root: '/hangars/alpha', claudeDir: '/synthetic-claude' });
  const b = syntheticHangar({
    root: '/hangars/beta',
    claudeDir: '/synthetic-claude',
    configText: OTHER_CONFIG,
  });
  const a1 = cloneAt(a, 1);
  const b1 = cloneAt(b, 1);

  const pathsOf = (hangar: typeof a, clone: typeof a1): string[] => [
    ...Object.values(hangar.paths),
    envLocalPath(clone),
    claudeLocalMdPath(clone),
    settingsPath(clone),
    themePath(clone),
  ];

  const aPaths = pathsOf(a, a1);
  const bPaths = pathsOf(b, b1);

  // Disjointness, both directions. Not `a !== b` per pair: the point is that no path of one
  // appears anywhere in the other's set, which is what a shared singleton would violate.
  const bSet = new Set(bPaths);
  for (const path of aPaths) assert.ok(!bSet.has(path), `${path} belongs to both hangars`);

  // The `~/.claude` ones are the dangerous half -- one directory for every hangar on the
  // machine -- so they get an explicit check rather than resting on set disjointness.
  assert.equal(a.paths.statuslineScript, '/synthetic-claude/wt-clone-statusline.sh');
  assert.equal(b.paths.statuslineScript, '/synthetic-claude/other-clone-statusline.sh');
  assert.equal(a.paths.memory, '/synthetic-claude/wt-memory');
  assert.equal(b.paths.memory, '/synthetic-claude/other-memory');
  assert.match(themePath(a1), /wt-clone-001-/);
  assert.match(themePath(b1), /other-clone-01-/);
});

test('content built for one hangar never names the other', () => {
  const a = syntheticHangar({ root: '/hangars/alpha', claudeDir: '/synthetic-claude' });
  const b = syntheticHangar({
    root: '/hangars/beta',
    claudeDir: '/synthetic-claude',
    configText: OTHER_CONFIG,
  });

  // Interleaved again, and this time over the builders that EMBED a root in text -- the exact
  // failure mode `paths.ts` had: a wrong absolute path that typechecks, lints, and is invisible
  // until someone opens the file inside a live clone.
  const texts: readonly (readonly [string, string, string])[] = [
    ['alpha env.local', envLocalContent(cloneAt(a, 2)), '/hangars/beta'],
    ['beta env.local', envLocalContent(cloneAt(b, 2)), '/hangars/alpha'],
    ['alpha .envrc.private', envrcPrivateContent(a), '/hangars/beta'],
    ['beta .envrc.private', envrcPrivateContent(b), '/hangars/alpha'],
    ['alpha exclude block', excludeBlock(a), '/hangars/beta'],
    ['alpha hangar CLAUDE.local.md', hangarClaudeLocalMdContent(a), '/hangars/beta'],
    ['beta hangar CLAUDE.local.md', hangarClaudeLocalMdContent(b), '/hangars/alpha'],
  ];
  for (const [what, text, forbidden] of texts) {
    assert.ok(!text.includes(forbidden), `${what} names ${forbidden}`);
  }

  // And the env keys, which are what a running server actually reads.
  const alphaEnv = envLocalContent(cloneAt(a, 2));
  const betaEnv = envLocalContent(cloneAt(b, 2));
  assert.match(alphaEnv, /^FIXTURE_API_PORT=3137$/m);
  assert.match(betaEnv, /^OTHER_API_PORT=3158$/m);
  assert.ok(!alphaEnv.includes('OTHER_'), 'alpha carries the other hangar’s env keys');
  assert.ok(!betaEnv.includes('FIXTURE_'), 'beta carries the other hangar’s env keys');
});
