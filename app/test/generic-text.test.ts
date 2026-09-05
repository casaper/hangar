import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  claudeLocalMdContent,
  envLocalContent,
  exampleIssueKey,
  portCheckHint,
} from '../src/clone-config.ts';
import { cloneColoursArtifact } from '../src/generate/colours-sh.ts';
import { cloneAt } from '../src/fleet.ts';
import { syntheticHangar } from './fixture.ts';

/**
 * Nothing generated into a clone names the repo Hangar was BUILT in.
 *
 * This is the one property a golden capture could express and structurally did not: for most of
 * this CLI's life the gated baseline included a capture of the maintainer's own hangar, where
 * `node dev/ports.mjs`, `clone_NN/` and `tmp/ABC-1234/...` are all correct -- so six hardcoded
 * literals sat in files that are written into every clone of EVERY hangar, each one reading as
 * derived output because it was surrounded by derived output. They were found by pointing a
 * second fixture at a config that disagrees, which is what the assertions below do directly.
 *
 * The list is deliberately literal rather than a pattern. A regex for "looks like this fleet"
 * would need updating to stay true; these six strings are facts about one repo and will never
 * legitimately appear in text rendered for another.
 */
const THIS_REPOS_OWN = [
  'dev/ports.mjs',
  'clone_NN',
  'clone_0',
  'ABC-1234',
  '.env.local',
  'angular/',
] as const;

/**
 * A config sharing NOTHING with this repo's, built by overriding the hostile fixture's keys.
 *
 * Every value below is one a leaked literal would contradict, and none of them agrees with the
 * schema DEFAULT either -- `clone_` is the default prefix and `.env.local` the default dotenv
 * name, so a config that took either would hide the very literal this file is looking for.
 */
const foreignConfig = (repoExtra: string, topExtra: string): string => `
id: foreign
clones:
  prefix: box.
  pad: 4
forge:
  kind: none
  originUrl: git@example.invalid:acme/ledger.git
  defaultBranch: mainline
repo:
  appDir: srv
  cloneEnv:
    file: .env.foreign
${repoExtra}
ports:
  step: 100
  offset: 11
  roles:
    - id: http
      envKey: FOREIGN_HTTP_PORT
      base: 7000
      label: HTTP
${topExtra}`;

const foreign = ({ repo = '', top = '' }: { repo?: string; top?: string } = {}): ReturnType<
  typeof syntheticHangar
> => syntheticHangar({ configText: foreignConfig(repo, top) });

const JIRA = 'tracker:\n  kind: jira\n  baseUrl: https://j.invalid\n';

test('no per-clone artifact names the repo this CLI was built in', () => {
  for (const hangar of [foreign(), foreign({ top: `${JIRA}  keyPrefixes: [ZZ]\n` })]) {
    const clone = cloneAt(hangar, 2);
    const texts = [
      envLocalContent(clone),
      claudeLocalMdContent(clone),
      cloneColoursArtifact(hangar, [clone]).content,
    ];
    for (const text of texts) {
      for (const literal of THIS_REPOS_OWN) {
        assert.ok(!text.includes(literal), `generated text names "${literal}":\n${text}`);
      }
    }
  }
});

test('the port hint names the repo’s own resolver, and degrades to one that always exists', () => {
  // Declared: Hangar asks the repo's resolver rather than reimplementing it.
  const declared = foreign({ repo: '  portCheckCommand: [make, ports]' });
  assert.equal(portCheckHint(declared), 'make ports');
  assert.match(envLocalContent(cloneAt(declared, 1)), /`make ports`/);

  // Undeclared: `hangar ports` is always on PATH, and answers for the fleet rather than a clone.
  assert.equal(portCheckHint(foreign()), 'hangar ports');
  assert.match(claudeLocalMdContent(cloneAt(foreign(), 1)), /`hangar ports`/);
});

test('the example issue key follows the tracker, and a hangar without one is shown no cache filename', () => {
  const jira = foreign({ top: `${JIRA}  keyPrefixes: [ZZ, QQ]\n` });
  assert.equal(exampleIssueKey(jira), 'ZZ-1234');
  assert.match(claudeLocalMdContent(cloneAt(jira, 1)), /tmp\/ZZ-1234\/ticket_ZZ-1234\.md/);

  // `keyPrefixes` is optional even with a tracker: an example still has to be key-SHAPED and
  // must not be a real key borrowed from somebody else's project.
  const open = foreign({ top: JIRA });
  assert.equal(exampleIssueKey(open), 'ABC-1234');

  // No tracker: the hard-link warning is true, the cached-record example is not.
  const text = claudeLocalMdContent(cloneAt(foreign(), 1));
  assert.ok(!text.includes('ticket_'), 'a trackerless hangar was shown a cache filename');
  assert.match(text, /hard link/);
});

test('the sibling directory pattern is the configured prefix', () => {
  const text = claudeLocalMdContent(cloneAt(foreign(), 1));
  assert.match(text, /`box\.<NN>\/` directories/);
  // Not the padded name of one clone: which clones exist is deliberately in no file.
  assert.ok(!text.includes('box.0002'), 'the identity file names a sibling');
});
