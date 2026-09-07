import type { Hangar } from '../hangar.ts';
import { type Artifact, artifactHeader } from './index.ts';

export type TerminalColourSettings = {
  readonly chrome: boolean;
  readonly title: boolean;
  readonly env: boolean;
  /** Fraction of the hue that reaches a background tint, 0-1. */
  readonly tint: number;
};

/**
 * `clone-terminal.sh` -- the per-clone terminal colour, for whatever terminal the developer runs.
 *
 * ## Why the shell does the colouring and not the CLI
 *
 * The colour has to be right for a tab the developer opened BY HAND, not only for the three
 * `hangar open` created, and it has to follow them when they `cd` from one clone to another in
 * the same tab. Only the shell knows when that happens. `hangar open` paints just one case the
 * shell cannot reach: Terminal.app, which ignores the escape sequence entirely -- see the
 * `paintOnCreate` capability.
 *
 * ## Why a chpwd hook rather than direnv
 *
 * direnv only fires on entering or leaving a directory that has an `.envrc`, it redirects the
 * `.envrc`'s stdout, and it has no notion of "left the hangar entirely" -- so escape codes
 * emitted from `.envrc` would be both fragile and incomplete. Colouring the terminal is the
 * shell's job; zsh's `chpwd` fires on every directory change, which is exactly the trigger the
 * colour needs. direnv still owns the environment; it just should not own terminal I/O.
 *
 * ## Three layers, because the emulators support wildly different amounts
 *
 * | layer  | how                                        | works in                                  |
 * | ------ | ------------------------------------------ | ----------------------------------------- |
 * | chrome | iTerm2's OSC 6 tab colour                  | iTerm2 -- the full hue, on the tab itself |
 * |        | `tmux set -w` window options               | tmux -- the full hue, on its own chrome   |
 * |        | OSC 11 background, darkened to a tint      | Konsole, VTE (GNOME Terminal), xterm, …   |
 * |        | nothing; `hangar open` uses AppleScript    | Terminal.app                              |
 * | title  | OSC 0 (and OSC 30 for Konsole's tab)       | everywhere                                |
 * | env    | `HANGAR_CLONE*` variables                  | everywhere, with no terminal support at all |
 *
 * The env layer is the floor and the reason this works on terminals nobody has thought about: a
 * prompt, a starship config or a tmux status line can colour itself from `HANGAR_CLONE_SGR`
 * without the emulator co-operating in any way.
 *
 * ## tmux is coloured HERE and not by the terminal driver
 *
 * tmux swallows the emulator's escape sequences, so under it this hook used to fall through to
 * `title` and a tmux user got no colour at all -- the one full-capability driver on Linux, and
 * the only layer it had was `env`, which needs the developer to write their own status-line
 * format. The driver looks like the obvious place to fix that, and is not, for two reasons.
 *
 * A driver only ever paints tabs `hangar open` created, whereas this hook paints whatever `$PWD`
 * is in -- so a window made with `C-b c` gets its colour too, which is the same argument
 * `TerminalCapabilities.paintOnCreate` already makes for every other emulator. And the value a
 * `paintOnCreate` driver is handed is the TINTED background (`commands/open.ts`), which is the
 * wrong colour for a status-line entry; routing tmux through the seam would mean carrying two
 * colours through it for one consumer.
 *
 * So `tmux.ts` keeps `paintOnCreate: false`, and that is now a positive statement -- the hook
 * covers it -- rather than the gap it was.
 *
 * ## Why the background is a TINT and not the hue
 *
 * A saturated hue behind text is unreadable. iTerm2 escapes this because OSC 6 colours the tab
 * in the tab bar, where full strength is exactly what is wanted; everywhere else the only lever
 * is the window background, so it gets a dark fraction of the hue instead -- enough to tell four
 * windows apart at a glance, not enough to fight the theme. `terminal.colour.tint` is the knob.
 *
 * ## Everything is named with the hangar id
 *
 * Two hangars can be sourced into one shell. Every function and every state variable below
 * therefore carries the id, and the reset is guarded so that a hook only clears a colour IT set
 * -- otherwise leaving hangar A's clone for hangar B's would have A's hook wipe the colour B had
 * just painted, in whichever order the two hooks happen to be registered.
 */
export const terminalHookArtifact = (hangar: Hangar, colour: TerminalColourSettings): Artifact => {
  const hangarId = hangar.id;
  const p = `_hangar_${hangarId}`;
  const tint = Math.round(colour.tint * 100);
  const table = `hangar_${hangarId}_colour`;

  const content = [
    artifactHeader(
      hangar,
      `Per-clone terminal colour for the ${hangarId} hangar. Source from ~/.zshrc or ~/.bashrc.`,
    ),
    '#',
    '# Safe to source anywhere: a no-op in a non-interactive shell, and in any terminal whose',
    '# escape sequences it does not know. The hue table it needs is clone-colours.sh beside it.',
    '#',
    '# Layers: tab/background colour where the terminal supports it, the window title, and the',
    '# HANGAR_CLONE* variables -- which need no terminal support at all, so a prompt or a tmux',
    '# status line can colour itself even where the chrome cannot be touched.',
    '',
    `${p}_root='${hangar.root}'`,
    `${p}_id='${hangarId}'`,
    `${p}_tint=${String(tint)}   # per cent of the hue that reaches the background`,
    `${p}_chrome=${colour.chrome ? '1' : '0'}`,
    `${p}_title=${colour.title ? '1' : '0'}`,
    `${p}_env=${colour.env ? '1' : '0'}`,
    '',
    "# Interactive shells only: escape sequences in a script's output are corruption, not colour.",
    'case $- in',
    '    *i*) ;;',
    '    *) return 0 ;;',
    'esac',
    '',
    `[ -r "\${${p}_root}/${hangar.paths.cloneColoursScript.split('/').pop() ?? 'clone-colours.sh'}" ] || return 0`,
    `. "\${${p}_root}/${hangar.paths.cloneColoursScript.split('/').pop() ?? 'clone-colours.sh'}"`,
    '',
    '# ---------------------------------------------------------------------------',
    '# Which family of escape sequences this terminal speaks. Decided ONCE: an emulator',
    '# cannot change under a running shell, and a subshell per `cd` is not worth it.',
    '#',
    '#   iterm2  OSC 6, which colours the tab in the tab bar -- the full hue.',
    '#   konsole OSC 11 background, plus OSC 30 for the tab label.',
    '#   osc11   OSC 11 background. VTE (GNOME Terminal), xterm, alacritty, kitty, foot, …',
    '#   tmux    `set -w` window options: the window-status entry and the pane borders. tmux',
    '#           swallows the emulator sequences, so it is coloured through its own options.',
    '#   title   title only. Terminal.app ignores OSC 11, and `hangar open` paints its tabs',
    '#           over AppleScript instead.',
    '#   none    nothing recognised. No escape sequences at all; the env layer still works.',
    '# ---------------------------------------------------------------------------',
    `if [ -n "\${TMUX:-}" ]; then`,
    `    ${p}_fam='tmux'`,
    `elif [ -n "\${ITERM_SESSION_ID:-}" ] || [ "\${TERM_PROGRAM:-}" = 'iTerm.app' ] || [ "\${LC_TERMINAL:-}" = 'iTerm2' ]; then`,
    `    ${p}_fam='iterm2'`,
    `elif [ "\${TERM_PROGRAM:-}" = 'Apple_Terminal' ]; then`,
    `    ${p}_fam='title'`,
    `elif [ -n "\${KONSOLE_VERSION:-}" ] || [ -n "\${KONSOLE_DBUS_SESSION:-}" ]; then`,
    `    ${p}_fam='konsole'`,
    `elif [ -n "\${VTE_VERSION:-}" ] || [ -n "\${GNOME_TERMINAL_SCREEN:-}" ]; then`,
    `    ${p}_fam='osc11'`,
    'else',
    '    # Two tests, not one on the two joined: TERM_PROGRAM=vscode with TERM=xterm-256color is',
    '    # a terminal that does understand OSC 11, and a concatenated pattern would miss it.',
    `    case "\${TERM_PROGRAM:-}" in`,
    `        WezTerm|ghostty|vscode|Hyper|Tabby) ${p}_fam='osc11' ;;`,
    '        *)',
    `            case "\${TERM:-}" in`,
    `                xterm*|alacritty*|foot*|rio*|contour*|kitty*|st-*) ${p}_fam='osc11' ;;`,
    `                *) ${p}_fam='none' ;;`,
    '            esac',
    '            ;;',
    '    esac',
    'fi',
    '',
    '# The hue as #rrggbb, scaled to $2 per cent. The triple is what the colour table stores.',
    '#',
    '# 100 for a tab label or a pane border, where the full strength is exactly what is wanted,',
    '# and the configured tint for a window BACKGROUND, which text has to stay readable against.',
    `${p}_hex() {`,
    '    local r rest g b',
    '    r=${1%%;*}; rest=${1#*;}; g=${rest%%;*}; b=${rest#*;}',
    `    printf '#%02x%02x%02x' "$((r * $2 / 100))" "$((g * $2 / 100))" "$((b * $2 / 100))"`,
    '}',
    '',
    '# $1 = r;g;b, or empty to restore the terminal default.',
    `${p}_chrome_set() {`,
    `    [ "\${${p}_chrome}" = 1 ] || return 0`,
    `    case "\${${p}_fam}" in`,
    '        iterm2)',
    '            if [ -z "$1" ]; then',
    "                printf '\\033]6;1;bg;*;default\\a'",
    '                return 0',
    '            fi',
    '            local r rest g b',
    '            r=${1%%;*}; rest=${1#*;}; g=${rest%%;*}; b=${rest#*;}',
    '            printf \'\\033]6;1;bg;red;brightness;%d\\a\'   "$r"',
    '            printf \'\\033]6;1;bg;green;brightness;%d\\a\' "$g"',
    '            printf \'\\033]6;1;bg;blue;brightness;%d\\a\'  "$b"',
    '            ;;',
    '        tmux)',
    '            # Window options, never `-g`: two hangars can share one tmux server, and a',
    '            # global would have whichever clone was entered last recolour every window of',
    '            # both. `-u` on the way out restores the session value rather than writing a',
    '            # literal default over it, which is what keeps that sharing lossless.',
    '            #',
    '            # `-t "$TMUX_PANE"` on every call, and it is load-bearing. `set -w` with NO',
    "            # target is the session's ACTIVE window, not the window the calling shell is",
    '            # in -- so with two clone windows open, a `cd` in the background one repainted',
    '            # whichever window was on screen. Measured: entering clone_02 in window 1 put',
    "            # clone_02's hue on window 0 and left window 1 with none.",
    '            #',
    "            # A PANE id is a legal target for a window option and resolves to that pane's",
    '            # own window, so this costs no extra exec -- tmux sets TMUX_PANE in every pane,',
    '            # and it keeps working from a split, which is also why the driver keeps its',
    '            # `@hangar_*` tags at window scope.',
    '            #',
    '            # `command tmux`, not a bare `tmux`: this function is defined by a shell rc,',
    '            # and zsh bakes an alias into a function body at DEFINITION time -- so an',
    '            # `alias tmux=` set before this file is sourced would rewrite all ten calls',
    "            # below and never be visible in them. Measured: oh-my-zsh's tmux plugin",
    '            # forwards every argument-bearing call to `command tmux`, so today it is',
    "            # transparent -- `command` is what makes that somebody else's business.",
    '            if [ -z "$1" ]; then',
    '                command tmux set -uw -t "$TMUX_PANE" @hangar_colour 2>/dev/null',
    '                command tmux set -uw -t "$TMUX_PANE" window-status-style 2>/dev/null',
    '                command tmux set -uw -t "$TMUX_PANE" window-status-current-style 2>/dev/null',
    '                command tmux set -uw -t "$TMUX_PANE" pane-border-style 2>/dev/null',
    '                command tmux set -uw -t "$TMUX_PANE" pane-active-border-style 2>/dev/null',
    '                return 0',
    '            fi',
    '            local hue',
    `            hue=$(${p}_hex "$1" 100)`,
    '            # The hue as data too, in the `@hangar_*` namespace `terminal/tmux.ts` already',
    "            # owns -- so a developer's own status-line format can read it instead of",
    '            # re-deriving the colour, and `tmux show -w` explains what painted the window.',
    '            command tmux set -w -t "$TMUX_PANE" @hangar_colour "$hue" 2>/dev/null',
    '            # Both status styles: the first is the window when it is not current, the second',
    '            # when it is. Without the second, the clone you are LOOKING at is the one window',
    '            # with no colour.',
    '            command tmux set -w -t "$TMUX_PANE" window-status-style "fg=$hue" 2>/dev/null',
    '            command tmux set -w -t "$TMUX_PANE" window-status-current-style "fg=$hue,bold" 2>/dev/null',
    '            # The borders carry it too, for a status line that is switched off or too full.',
    '            command tmux set -w -t "$TMUX_PANE" pane-border-style "fg=$hue" 2>/dev/null',
    '            command tmux set -w -t "$TMUX_PANE" pane-active-border-style "fg=$hue" 2>/dev/null',
    '            ;;',
    '        konsole|osc11)',
    '            if [ -z "$1" ]; then',
    '                # OSC 111 resets the background where it is understood (xterm, VTE). A',
    '                # terminal that ignores it would keep the tint, so HANGAR_TERM_BG is the',
    '                # escape hatch: set it in your rc to the background you actually use.',
    `                if [ -n "\${HANGAR_TERM_BG:-}" ]; then`,
    '                    printf \'\\033]11;%s\\a\' "$HANGAR_TERM_BG"',
    '                else',
    "                    printf '\\033]111\\a'",
    '                fi',
    '                return 0',
    '            fi',
    `            printf '\\033]11;%s\\a' "$(${p}_hex "$1" "\${${p}_tint}")"`,
    '            ;;',
    '    esac',
    '}',
    '',
    '# $1 = title, or empty for "just the directory" -- the neutral a prompt framework would set.',
    `${p}_title_set() {`,
    `    [ "\${${p}_title}" = 1 ] || return 0`,
    '    # Nothing at all into a terminal we did not recognise. OSC 0 is as old and as widely',
    '    # understood as escape sequences get, but "widely" is not "always" -- TERM=dumb, a',
    "    # pipe, a CI log -- and a stray escape there is corruption in someone's output.",
    `    [ "\${${p}_fam}" = 'none' ] && return 0`,
    '    local text=${1:-${PWD##*/}}',
    '    printf \'\\033]0;%s\\a\' "$text"',
    `    [ "\${${p}_fam}" = 'konsole' ] && printf '\\033]30;%s\\a' "$text"`,
    '    return 0',
    '}',
    '',
    '# The variables anything in the shell can colour itself from, with no terminal support.',
    `${p}_env_set() {`,
    `    [ "\${${p}_env}" = 1 ] || return 0`,
    '    if [ -z "$1" ]; then',
    '        unset HANGAR_CLONE HANGAR_CLONE_COLOUR HANGAR_CLONE_RGB HANGAR_CLONE_HEX',
    '        unset HANGAR_CLONE_X256 HANGAR_CLONE_SGR HANGAR_ID',
    '        return 0',
    '    fi',
    '    export HANGAR_CLONE="$1"',
    '    export HANGAR_CLONE_RGB="$2"',
    '    export HANGAR_CLONE_X256="$3"',
    '    export HANGAR_CLONE_COLOUR="$4"',
    `    export HANGAR_ID="\${${p}_id}"`,
    '    local r rest g b',
    '    r=${2%%;*}; rest=${2#*;}; g=${rest%%;*}; b=${rest#*;}',
    '    export HANGAR_CLONE_HEX="$(printf \'#%02x%02x%02x\' "$r" "$g" "$b")"',
    '    # 24-bit where the terminal says it can, the 256-colour cube otherwise -- Terminal.app',
    '    # is the one that matters, and it does not do true colour.',
    '    # A real ESC, not the four characters \\033: this is meant to be used directly in a',
    '    # prompt (PS1/PROMPT), where a literal backslash-zero-three-three would print as text.',
    `    case "\${COLORTERM:-}" in`,
    '        truecolor|24bit) HANGAR_CLONE_SGR=$(printf \'\\033[38;2;%sm\' "$2") ;;',
    '        *) HANGAR_CLONE_SGR=$(printf \'\\033[38;5;%sm\' "$3") ;;',
    '    esac',
    '    export HANGAR_CLONE_SGR',
    '}',
    '',
    '# ---------------------------------------------------------------------------',
    '# The hook itself. Which clone (if any) is $PWD in, and paint accordingly.',
    '#',
    '# The reset is guarded so this hook only clears what IT set. Two hangars can be sourced',
    "# into one shell; leaving A's clone for B's runs both hooks in registration order, and",
    '# without the guard whichever ran second would undo the other. A clone the sibling hook',
    '# has already claimed is left entirely alone -- it repaints the chrome itself.',
    '# ---------------------------------------------------------------------------',
    `${p}_chpwd() {`,
    '    local clone= rest= first= fields= rgb= x256= name=',
    `    case "$PWD" in`,
    `        "\${${p}_root}"/*)`,
    `            rest=\${PWD#"\${${p}_root}/"}`,
    '            first=${rest%%/*}',
    `            fields=$(${table} "$first" 2>/dev/null) && clone=$first`,
    '            ;;',
    '    esac',
    '',
    '    if [ -n "$clone" ]; then',
    "        # Split the table's three space-separated fields WITHOUT `set --`: zsh does not",
    '        # word-split an unquoted parameter, so `set -- $fields` would hand over one field',
    '        # there and two empty ones. Parameter expansion behaves the same in both shells.',
    '        rgb=${fields%% *}; rest=${fields#* }; x256=${rest%% *}; name=${rest#* }',
    `        ${p}_chrome_set "$rgb"`,
    `        ${p}_title_set "$clone · \${${p}_id}"`,
    `        ${p}_env_set "$clone" "$rgb" "$x256" "$name"`,
    `        ${p}_active=$clone`,
    `    elif [ -n "\${${p}_active:-}" ]; then`,
    `        if [ -z "\${HANGAR_CLONE:-}" ] || [ "\${HANGAR_CLONE}" = "\${${p}_active}" ]; then`,
    `            ${p}_chrome_set ''`,
    `            ${p}_title_set ''`,
    `            ${p}_env_set ''`,
    '        fi',
    `        unset ${p}_active`,
    '    fi',
    '}',
    '',
    '# Fires on every prompt in bash, so skip the escape sequences unless $PWD actually moved.',
    `${p}_maybe() {`,
    `    [ "$PWD" = "\${${p}_pwd:-}" ] && return 0`,
    `    ${p}_pwd=$PWD`,
    `    ${p}_chpwd`,
    '    # Never leak a status: in bash this runs from PROMPT_COMMAND, where a non-zero return',
    "    # can end up displayed as the last command's exit code by the prompt itself.",
    '    return 0',
    '}',
    '',
    'if [ -n "${ZSH_VERSION:-}" ]; then',
    '    autoload -Uz add-zsh-hook',
    `    add-zsh-hook chpwd ${p}_maybe`,
    'elif [ -n "${BASH_VERSION:-}" ]; then',
    `    case "\${PROMPT_COMMAND:-}" in`,
    `        *${p}_maybe*) ;;`,
    `        '') PROMPT_COMMAND="${p}_maybe" ;;`,
    `        *) PROMPT_COMMAND="${p}_maybe;\${PROMPT_COMMAND}" ;;`,
    '    esac',
    'fi',
    '',
    '# Apply to the directory the shell starts in.',
    `${p}_maybe`,
    '',
  ].join('\n');

  return {
    path: hangar.paths.terminalHookScript,
    content,
    mode: 0o755,
    what: 'per-clone terminal colour hook (zsh/bash)',
  };
};
