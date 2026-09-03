import { join } from 'node:path';

import { run } from '../exec.ts';
import type { Clone } from '../fleet.ts';
import type { EditorArtifact, EditorDriver, LaunchResult } from './types.ts';

/**
 * Emacs, as a GUI editor.
 *
 * The one driver whose launcher has to CHECK SOMETHING FIRST, and that shapes it:
 *
 * `emacsclient` needs a running server, and its failure when there is none is not obviously
 * about that -- it prints a connect error and exits non-zero. So this asks the server first
 * (`emacsclient --eval t`, which is a no-op that fails exactly when there is no server) and only
 * then decides between the client and a fresh `emacs`. Getting that wrong costs the developer the
 * one thing the client exists for: reusing the session they already have open, with their
 * buffers in it.
 *
 * `--no-wait` matters as much. Without it `emacsclient` blocks until the buffer is closed, and
 * `hangar open --all` would stop dead on the first clone waiting for a file nobody knows is
 * waiting.
 *
 * `reused` is true when the client answered, because there the clone really did land in the
 * existing session -- unlike JetBrains and Zed, where the editor decides silently and does not
 * say which happened.
 *
 * Not verified against a live Emacs -- it is not installed on the machine this was built on.
 */
const serverIsRunning = (): boolean => run('emacsclient', ['--eval', 't']).ok;

const launchEmacs = (clone: Clone): LaunchResult | undefined => {
  if (serverIsRunning()) {
    // `-n` is --no-wait: without it this blocks until the buffer is closed.
    const res = run('emacsclient', ['-n', clone.path]);
    if (res.ok) return { target: clone.path, reused: true };
    return {
      target: clone.path,
      reused: false,
      note: `emacsclient refused it: ${res.stderr.trim() || `exited ${String(res.code)}`}`,
    };
  }
  const res = run('emacs', [clone.path]);
  if (res.ok) {
    return {
      target: clone.path,
      reused: false,
      note: 'no Emacs server was running — started a fresh Emacs (`M-x server-start` enables reuse)',
    };
  }
  return undefined;
};

/**
 * `.dir-locals.el` -- Emacs' per-directory settings, and the only project file it has.
 *
 * Its values are elisp forms rather than paths, and the convention is project-relative, so there
 * is nothing clone-specific to rewrite. It is frequently TRACKED, which the sync engine discovers
 * per clone and then refuses to write -- correctly, since it would be branch content.
 */
export const EMACS_ARTIFACTS: readonly EditorArtifact[] = [
  {
    id: '.dir-locals.el',
    tracked: false,
    copies: (clone: Clone) => [join(clone.path, '.dir-locals.el')],
    rootKeys: {},
    indexLabel: false,
  },
];

export const emacsDriver = (): EditorDriver => ({
  kind: 'emacs',
  label: 'Emacs',
  capabilities: {
    launch: true,
    // The client reuses the running session; nothing for Hangar to work out.
    focusExisting: false,
    syncArtifacts: true,
    rewritesRootPaths: false,
  },
  isAvailable: () =>
    run('sh', ['-c', 'command -v emacsclient >/dev/null 2>&1 || command -v emacs >/dev/null 2>&1'])
      .ok,
  unavailableHint: () => 'neither `emacsclient` nor `emacs` is on PATH.',
  launch: launchEmacs,
  artifacts: EMACS_ARTIFACTS,
});
