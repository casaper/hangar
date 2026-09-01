import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { workspacePath } from '../clone-config.ts';
import { CliError, run } from '../exec.ts';
import { discoverClones, findClone } from '../fleet.ts';
import { itermIsRunning, openWindowWithTabs } from '../iterm.ts';
import { note, ok, warn } from '../ui.ts';

/**
 * `orch-util open <clone>` -- the clone's whole working set in one command.
 *
 * Three iTerm2 tabs (Claude in the clone root, a shell in the clone root, a shell in
 * `angular/`) plus the VS Code workspace.
 *
 * The tab colours are not set here: `dvb-clone-iterm.zsh` colours each tab from its own
 * chpwd hook the moment the shell lands in the clone, so a tab opened by hand looks exactly
 * like one opened by this command.
 */
export type OpenOptions = { code?: boolean | undefined; claude?: boolean | undefined };

export const open = (ref: string, opts: OpenOptions): void => {
  const clone = findClone(ref);
  if (!clone) {
    throw new CliError(
      `no such clone: ${ref}`,
      `Known clones: ${
        discoverClones()
          .map((c) => c.name)
          .join(', ') || '(none)'
      }`,
    );
  }

  if (!itermIsRunning()) {
    throw new CliError(
      'iTerm2 is not running',
      'Start iTerm2 first — this command drives it over AppleScript.',
    );
  }

  const opened = openWindowWithTabs([
    { cwd: clone.path, command: opts.claude === false ? undefined : 'claude' },
    { cwd: clone.path },
    { cwd: join(clone.path, 'angular') },
  ]);
  if (opened) ok(`opened three iTerm2 tabs for ${clone.name}`);
  else warn('iTerm2 refused the AppleScript — no tabs opened');

  if (opts.code === false) return;

  // The workspace file lives at the CLONE ROOT, so `code *.code-workspace` from angular/
  // would match nothing. Open it by full path instead.
  const workspace = workspacePath(clone);
  if (!existsSync(workspace)) {
    warn(`no workspace file at ${workspace} — run \`orch-util doctor --fix\` to create it`);
    return;
  }
  const res = run('code', [workspace]);
  if (res.ok) ok(`opened ${workspace.split('/').pop() ?? workspace} in VS Code`);
  else warn(`could not launch VS Code: ${res.stderr.trim() || 'is the `code` command installed?'}`);
  note(
    `ports: ng ${clone.ports.ng} · storybook ${clone.ports.storybook} · playwright ${clone.ports.playwrightReport}`,
  );
};
