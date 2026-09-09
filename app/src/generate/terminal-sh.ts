import type { Hangar } from '../hangar.ts';
import { tmuxSocketName } from '../tmux.ts';
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
 * The colour has to be right for a window the developer opened BY HAND -- a `C-b c` inside a
 * clone's session, or a shell in a clone that is not in tmux at all -- and not only for the ones
 * `hangar open` created. It also has to follow them when they `cd` from one clone into another in
 * the same window. Only the shell knows when either happens. The one thing `hangar open` paints
 * itself is the session's `status-left`, which has to be right before any shell has printed a
 * prompt.
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
 * | chrome | `tmux set -w` window options               | every window `hangar open` creates        |
 * |        | iTerm2's OSC 6 tab colour                  | iTerm2, in a shell outside tmux           |
 * |        | OSC 11 background, darkened to a tint      | Konsole, VTE (GNOME Terminal), xterm, …   |
 * |        | nothing at all                             | Terminal.app, which understands neither   |
 * | title  | OSC 0 (and OSC 30 for Konsole's tab)       | everywhere                                |
 * | env    | `HANGAR_CLONE*` variables                  | everywhere, with no terminal support at all |
 * | prompt | `PROMPT`/`PS1`, saved and restored         | this hangar's OWN tmux sessions only      |
 *
 * The env layer is the floor and the reason this works on terminals nobody has thought about: a
 * prompt, a starship config or a tmux status line can colour itself from `HANGAR_CLONE_SGR`
 * without the emulator co-operating in any way.
 *
 * ## Why the prompt layer alone is gated on the SOCKET
 *
 * The other three ask "which clone is this", and the answer is useful in any terminal. The prompt
 * layer TAKES INFORMATION AWAY -- the user, the host, the path, the git state and the time all go,
 * down to a single `❯` in the clone's hue -- and that is only safe where something else is saying
 * them. That something is the pane-border footer, which exists only in sessions on this hangar's
 * own tmux server. So `$TMUX` is matched against `hangar-<id>` followed by a comma: a shell in a
 * clone that is not in one of those sessions keeps the prompt the developer configured, because
 * there it is still the only thing telling them where they are.
 *
 * `HANGAR_KEEP_PROMPT` is the escape hatch, in the shape `HANGAR_TERM_BG` already has. Saving and
 * restoring `PROMPT` plus `RPROMPT` is enough for a theme that only sets those two; a theme that
 * paints from `precmd_functions` would keep painting over this, and that is a real limit rather
 * than a claim about every theme.
 *
 * ## tmux is coloured HERE, on every `cd`, and not where the window was opened
 *
 * tmux swallows the emulator's escape sequences, so under it the chrome layer is tmux's own
 * window options instead. Doing that here rather than where `hangar open` creates a window is
 * what makes it cover a window the developer made themselves with `C-b c`, or a `cd` from one
 * clone's directory into another's -- neither of which anything on the opening side ever sees.
 *
 * The one piece `open` does paint is the session's `status-left`, at session scope when it
 * creates the session: the status bar has to be right the instant the client attaches, which is
 * before any shell has printed a prompt, and it is a session option this hook could only reach
 * with `-g` -- which would have the last clone entered recolour every other session's bar.
 *
 * ## Why the background is a TINT and not the hue
 *
 * A saturated hue behind text is unreadable *when you do not control the text*. iTerm2 escapes
 * this because OSC 6 colours the tab in the tab bar, where full strength is exactly what is
 * wanted; everywhere else the only lever is the whole window background, sitting behind a
 * terminal's worth of output whose colours nothing here chose, so it gets a dark fraction of the
 * hue instead -- enough to tell four windows apart at a glance, not enough to fight the theme.
 * `terminal.colour.tint` is the knob.
 *
 * The tmux status bar is the one place full strength goes BEHIND text, and that is the same rule
 * applied rather than an exception to it: the bar is the only surface here whose text this code
 * also owns, so it can put `colour.ink` in front of the hue and know the pair reads.
 * `src/palette.ts` carries the proof that it always does.
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
  const socket = tmuxSocketName(hangarId);

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
    '#           The window you are in gets the hue as a BACKGROUND behind a chosen ink; the',
    '#           others get it as text, lifted far enough to read on the bar.',
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
    '# ---------------------------------------------------------------------------',
    "# Whether this shell is inside THIS hangar's own tmux server, decided once for the",
    '# same reason the family is: $TMUX cannot change under a running shell.',
    '#',
    '# $TMUX is <socket-path>,<pid>,<session>, so the comma is what makes the match exact --',
    '# without it the pattern would also catch the hangar-root modes socket, which is',
    '# `hangar-<id>-claude` and has no clone, no footer and no reason to lose its prompt.',
    '# ---------------------------------------------------------------------------',
    `case "\${TMUX:-}" in`,
    `    */${socket},*) ${p}_ours=1 ;;`,
    `    *) ${p}_ours=0 ;;`,
    'esac',
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
    '# $1 = r;g;b, or empty to restore the terminal default. $2 = the ink that reads on that',
    '# hue, $3 = the hue lifted far enough to read AS text on the status bar. Both arrive from',
    '# the table beside this file rather than being worked out here: choosing them needs WCAG',
    '# relative luminance, a gamma curve per channel, which is not arithmetic to redo in shell on',
    '# every `cd`. Only the tmux arm reads them; the others take the hue and ignore the rest.',
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
    '            # Both status styles, because tmux picks between them itself: the first is the',
    '            # window when it is not current, the second when it is. Without the second, the',
    '            # clone you are LOOKING at is the one window with no colour.',
    '            #',
    '            # The current one takes the hue as a BACKGROUND with the ink in front of it --',
    '            # the same shape the clone badge on the bar gets from `hangar open`, so which',
    '            # clone and which window read alike. The others take it as TEXT, and take the',
    '            # LIFTED form: two of the sixteen palette hues cannot be read at full strength',
    '            # on the bar, and the lift is per-hue rather than lightening all sixteen.',
    '            command tmux set -w -t "$TMUX_PANE" window-status-current-style "bg=$hue,fg=$2,bold" 2>/dev/null',
    '            command tmux set -w -t "$TMUX_PANE" window-status-style "fg=$3" 2>/dev/null',
    '            # The borders carry it as a solid BAND -- background and line character both',
    "            # the hue -- because the bottom one is the clone's footer. `pane-border-format`",
    '            # draws the clone, the path, the git state and the branch onto it in',
    '            # `colour.ink`, and a band is what puts those characters ON the hue rather than',
    '            # in a gap in it. The borders a split adds take the same style, which is the',
    '            # hue in more places rather than a different colour anywhere.',
    '            command tmux set -w -t "$TMUX_PANE" pane-border-style "bg=$hue,fg=$hue" 2>/dev/null',
    '            command tmux set -w -t "$TMUX_PANE" pane-active-border-style "bg=$hue,fg=$hue" 2>/dev/null',
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
    '# $1 = r;g;b, or empty to put the shell back on the prompt it had.',
    '#',
    "# Only inside this hangar's OWN tmux, because that is the only place the footer exists to",
    '# have made the information redundant. A shell in a clone that is not in one of these',
    '# sessions keeps whatever prompt the developer configured -- there it is still the only',
    '# thing saying where they are.',
    `${p}_prompt_set() {`,
    '    # Putting a saved prompt BACK comes before either gate, and that ordering is the fix',
    '    # for a real bug: with the gates first, setting HANGAR_KEEP_PROMPT in a shell that had',
    '    # already been given the short prompt left it stuck with it for ever -- the hatch would',
    '    # have blocked the very call that restores. A gate may refuse to take a prompt away; it',
    '    # may not refuse to give one back.',
    '    if [ -z "$1" ]; then',
    `        if [ -n "\${${p}_had_prompt:-}" ]; then`,
    `            if [ -n "\${ZSH_VERSION:-}" ]; then`,
    `                PROMPT=\${${p}_old_prompt}`,
    `                RPROMPT=\${${p}_old_rprompt}`,
    '            else',
    `                PS1=\${${p}_old_ps1}`,
    '            fi',
    `            unset ${p}_had_prompt`,
    '        fi',
    '        return 0',
    '    fi',
    `    [ "\${${p}_ours}" = 1 ] || return 0`,
    '    # The escape hatch, in the shape HANGAR_TERM_BG already has: a prompt is more personal',
    '    # than a tab colour, so there is a way to keep your own without editing a generated file.',
    '    [ -n "${HANGAR_KEEP_PROMPT:-}" ] && return 0',
    '    # Saved ONCE, on the way in, so a `cd` from one clone straight into another does not',
    '    # save the prompt this function itself installed and then restore THAT on the way out.',
    `    if [ -z "\${${p}_had_prompt:-}" ]; then`,
    `        if [ -n "\${ZSH_VERSION:-}" ]; then`,
    `            ${p}_old_prompt=$PROMPT`,
    `            ${p}_old_rprompt=\${RPROMPT:-}`,
    '        else',
    `            ${p}_old_ps1=$PS1`,
    '        fi',
    `        ${p}_had_prompt=1`,
    '    fi',
    '    local hue',
    `    hue=$(${p}_hex "$1" 100)`,
    `    if [ -n "\${ZSH_VERSION:-}" ]; then`,
    '        # The hue when the last command succeeded and red when it did not, which is the one',
    '        # thing a prompt still has to say once the footer carries the rest. `%F{#rrggbb}`',
    '        # takes 24-bit colour in zsh, and `%(?..)` needs no option set.',
    `        PROMPT="%(?.%F{$hue}.%F{red})❯%f "`,
    "        RPROMPT=''",
    '    else',
    '        # No exit-status arm in bash: $? has already been replaced by the time',
    '        # PROMPT_COMMAND runs this hook, and reading it would mean owning the whole of',
    '        # PROMPT_COMMAND rather than prepending one function to whatever is already there.',
    `        PS1="\\\\[\\\\033[38;2;$1m\\\\]❯\\\\[\\\\033[0m\\\\] "`,
    '    fi',
    '}',

    '# ---------------------------------------------------------------------------',
    '# The hook itself. Which clone (if any) is $PWD in, and paint accordingly.',
    '#',
    '# The reset is guarded so this hook only clears what IT set. Two hangars can be sourced',
    "# into one shell; leaving A's clone for B's runs both hooks in registration order, and",
    '# without the guard whichever ran second would undo the other. A clone the sibling hook',
    '# has already claimed is left entirely alone -- it repaints the chrome itself.',
    '# ---------------------------------------------------------------------------',
    `${p}_chpwd() {`,
    '    local clone= rest= first= fields= rgb= x256= name= ink= bar=',
    `    case "$PWD" in`,
    `        "\${${p}_root}"/*)`,
    `            rest=\${PWD#"\${${p}_root}/"}`,
    '            first=${rest%%/*}',
    `            fields=$(${table} "$first" 2>/dev/null) && clone=$first`,
    '            ;;',
    '    esac',
    '',
    '    if [ -n "$clone" ]; then',
    "        # Split the table's five space-separated fields WITHOUT `set --`: zsh does not",
    '        # word-split an unquoted parameter, so `set -- $fields` would hand over one field',
    '        # there and four empty ones. Parameter expansion behaves the same in both shells.',
    '        #',
    '        # One uniform pair of steps per field, and only the LAST is taken with `#* `. That',
    '        # shape is the fix for a real trap: the older three-field split ended',
    '        # `name=${rest#* }` -- everything after the second space -- so appending a field to',
    '        # the table landed it INSIDE $name, which is exported as HANGAR_CLONE_COLOUR. It',
    '        # would have read `cyan #000000`, with every gate still green. Written this way, a',
    '        # sixth field cannot corrupt the fifth.',
    '        rgb=${fields%% *};  rest=${fields#* }',
    '        x256=${rest%% *};   rest=${rest#* }',
    '        name=${rest%% *};   rest=${rest#* }',
    '        ink=${rest%% *};    bar=${rest#* }',
    `        ${p}_chrome_set "$rgb" "$ink" "$bar"`,
    `        ${p}_title_set "$clone · \${${p}_id}"`,
    `        ${p}_env_set "$clone" "$rgb" "$x256" "$name"`,
    `        ${p}_prompt_set "$rgb"`,
    `        ${p}_active=$clone`,
    `    elif [ -n "\${${p}_active:-}" ]; then`,
    `        if [ -z "\${HANGAR_CLONE:-}" ] || [ "\${HANGAR_CLONE}" = "\${${p}_active}" ]; then`,
    `            ${p}_chrome_set ''`,
    `            ${p}_title_set ''`,
    `            ${p}_env_set ''`,
    `            ${p}_prompt_set ''`,
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
