import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseRemote, usesBitbucket } from '../src/bitbucket.ts';

const REF = { workspace: 'acme', repo: 'storefront_ui' };

describe('parseRemote', () => {
  for (const url of [
    'git@bitbucket.org:acme/storefront_ui.git',
    'git@bitbucket.org:acme/storefront_ui',
    'git@ssh.bitbucket.org:acme/storefront_ui.git',
    'git@ssh.bitbucket.org:acme/storefront_ui',
    'ssh://git@bitbucket.org/acme/storefront_ui.git',
    'ssh://git@ssh.bitbucket.org/acme/storefront_ui.git',
    'ssh://git@ssh.bitbucket.org:22/acme/storefront_ui',
    'https://bitbucket.org/acme/storefront_ui.git',
  ]) {
    it(`reads ${url}`, () => {
      assert.deepEqual(parseRemote(url), REF);
    });
  }

  for (const url of [
    'git@xssh.bitbucket.org:acme/storefront_ui.git',
    'git@ssh.bitbucket.org:storefront_ui.git',
    'ssh://git@xssh.bitbucket.org/acme/storefront_ui.git',
    'git@github.com:acme/storefront_ui.git',
  ]) {
    it(`refuses ${url}`, () => {
      assert.equal(parseRemote(url), undefined);
    });
  }

  it('lets a hangar whose origin is on the ssh host use Bitbucket', () => {
    assert.equal(
      usesBitbucket({ originUrl: 'git@ssh.bitbucket.org:acme/storefront_ui.git' }),
      true,
    );
  });
});
