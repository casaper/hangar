# Canonical per-clone hues for the dvb_gn fleet. Sourceable by sh/bash/zsh.
#
# These three values are THE reference. They are mirrored in two places that cannot
# source a shell file -- keep all three in step when changing a hue:
#   ~/.claude/themes/dvb-clone-0*.json      (static JSON, Claude Code theme)
#   ~/.claude/dvb-clone-statusline.sh       (self-contained on purpose: it must never
#                                            fail, so it carries its own copy)
#
# Formula, so the three read as one set: main at G=204,
# shimmer = main + 40% toward white, border = main x 0.8.

dvb_clone_rgb() {
    case "$1" in
        clone_01) printf '0;204;255' ;;   # cyan   #00ccff
        clone_02) printf '255;204;0' ;;   # yellow #ffcc00
        clone_03) printf '0;204;0'   ;;   # green  #00cc00
        *)        return 1 ;;
    esac
}
