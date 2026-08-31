# Per-clone iTerm2 tab colour for the dvb_gn fleet: cyan / yellow / green whenever the
# shell's PWD is inside clone_01 / clone_02 / clone_03 (including any subdirectory).
#
# Source this from ~/.zshrc. Safe to source anywhere: it is a no-op in a
# non-interactive shell and in any terminal that is not iTerm2.
#
# WHY A chpwd HOOK RATHER THAN direnv: direnv only fires on entering or leaving a
# directory that has an .envrc, it redirects the .envrc's stdout, and it has no notion
# of "left the fleet entirely" -- so escape codes emitted from .envrc are both fragile
# and incomplete. Colouring the terminal is the shell's job; zsh's chpwd fires on every
# directory change, which is exactly the trigger the colour needs. direnv still owns
# the environment (ports, PROJECT_GIT_ROOT_PATH); it just should not own terminal I/O.

[[ -o interactive ]] || return 0
[[ "$TERM_PROGRAM" == "iTerm.app" || "$LC_TERMINAL" == "iTerm2" ]] || return 0

: ${DVB_FLEET_ROOT:="$HOME/code/dvb_gn"}
[[ -r "$DVB_FLEET_ROOT/clone-colours.sh" ]] && source "$DVB_FLEET_ROOT/clone-colours.sh"
(( $+functions[dvb_clone_rgb] )) || return 0

_dvb_iterm_tab_colour() {
    # no argument -> restore iTerm2's default tab colour
    if [[ -z "$1" ]]; then
        printf '\033]6;1;bg;*;default\a'
        return 0
    fi
    local r g b
    IFS=';' read -r r g b <<< "$1"
    printf '\033]6;1;bg;red;brightness;%d\a'   "$r"
    printf '\033]6;1;bg;green;brightness;%d\a' "$g"
    printf '\033]6;1;bg;blue;brightness;%d\a'  "$b"
}

_dvb_iterm_chpwd() {
    local clone='' rgb='' rest first
    if [[ "$PWD" == "$DVB_FLEET_ROOT"/* ]]; then
        rest="${PWD#$DVB_FLEET_ROOT/}"
        first="${rest%%/*}"
        [[ "$first" == clone_0[0-9] ]] && { clone="$first"; rgb="$(dvb_clone_rgb "$clone")"; }
    fi

    if [[ -n "$rgb" ]]; then
        _dvb_iterm_tab_colour "$rgb"
        _DVB_ITERM_ACTIVE="$clone"
    elif [[ -n "${_DVB_ITERM_ACTIVE:-}" ]]; then
        # only reset a colour WE set, so a tab the user coloured by hand is left alone
        _dvb_iterm_tab_colour ''
        unset _DVB_ITERM_ACTIVE
    fi
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd _dvb_iterm_chpwd
_dvb_iterm_chpwd    # apply to the directory the shell starts in
