# Shared helpers for the host -> guest output contract. Sourced by bash scripts.
#
# The Android compositor writes /tmp/localdesktop-output atomically (write + rename):
#   LOCALDESKTOP_OUTPUT_MODE=<W>x<H>     guest render size in physical pixels
#   LOCALDESKTOP_OUTPUT_SCALE=<float>    UI scale, two decimals
#   LOCALDESKTOP_OUTPUT_REFRESH=<int>    refresh rate in Hz
# and then wakes readers of the FIFO /tmp/localdesktop-output.fifo with a "changed" line.

LD_OUTPUT_STATE=/tmp/localdesktop-output
LD_OUTPUT_FIFO=/tmp/localdesktop-output.fifo

# Reads the state file into LD_MODE, LD_SCALE and LD_REFRESH.
# Returns 1 when there is no usable mode yet.
ld_read_state() {
    LD_MODE=""
    LD_SCALE="1.00"
    LD_REFRESH="60"
    [ -r "$LD_OUTPUT_STATE" ] || return 1

    local line
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            LOCALDESKTOP_OUTPUT_MODE=*) LD_MODE=${line#*=} ;;
            LOCALDESKTOP_OUTPUT_SCALE=*) LD_SCALE=${line#*=} ;;
            LOCALDESKTOP_OUTPUT_REFRESH=*) LD_REFRESH=${line#*=} ;;
        esac
    done < "$LD_OUTPUT_STATE"

    [[ $LD_MODE =~ ^[0-9]+x[0-9]+$ ]] || return 1
    [[ $LD_SCALE =~ ^[0-9]+(\.[0-9]+)?$ ]] || LD_SCALE="1.00"
    [[ $LD_REFRESH =~ ^[0-9]+$ ]] && [ "$LD_REFRESH" -gt 0 ] || LD_REFRESH="60"
    return 0
}

# Sets LD_CENTI to a scale such as "2.50" multiplied by 100 (two decimals, rest dropped).
ld_scale_to_centi() {
    local scale=$1 whole frac=""
    whole=${scale%%.*}
    case "$scale" in *.*) frac=${scale#*.} ;; esac
    frac="${frac}00"
    frac=${frac:0:2}
    LD_CENTI=$((10#${whole:-0} * 100 + 10#$frac))
}

# Prints the integer Xft DPI for a scale such as "2.50": plain DPI, 96 at scale 1.
# (xfsettingsd stores /Xft/DPI as DPI and publishes DPI*1024 to X clients itself.)
ld_dpi_from_scale() {
    ld_scale_to_centi "$1"
    echo $(((LD_CENTI * 96 + 50) / 100))
}

# Sets /Xft/DPI for Xwayland clients through xfconf (needs the Xfce session bus).
ld_apply_dpi() {
    local dpi=$1
    xfconf-query -c xsettings -p /Xft/DPI -n -t int -s "$dpi" 2>/dev/null ||
        xfconf-query -c xsettings -p /Xft/DPI -t int -s "$dpi" 2>/dev/null
}

# Sets LD_OUTPUT_NAME to the first wlroots output. Returns 1 when labwc has none yet.
ld_first_output() {
    local line
    LD_OUTPUT_NAME=""
    while IFS= read -r line; do
        case "$line" in
            '' | [[:space:]]*) ;;
            *)
                LD_OUTPUT_NAME=${line%% *}
                return 0
                ;;
        esac
    done < <(wlr-randr 2>/dev/null)
    return 1
}

# Applies LD_MODE, LD_SCALE and LD_REFRESH to the wlroots output named in $1.
ld_apply_output() {
    local out=$1
    wlr-randr --output "$out" --custom-mode "${LD_MODE}@${LD_REFRESH}Hz" --scale "$LD_SCALE" >/dev/null 2>&1 && return 0
    wlr-randr --output "$out" --custom-mode "$LD_MODE" --scale "$LD_SCALE" >/dev/null 2>&1 && return 0
    wlr-randr --output "$out" --mode "$LD_MODE" --scale "$LD_SCALE" >/dev/null 2>&1 && return 0
    wlr-randr --output "$out" --scale "$LD_SCALE" >/dev/null 2>&1 && return 0
    return 1
}

# Returns 0 when the first wlroots output already runs LD_MODE at LD_SCALE (so nothing has to
# be re-applied). Reads one `wlr-randr` listing: the active mode line ends in "current)" and
# the scale is reported as "Scale: 2.500000". Anything unparsable counts as a mismatch.
ld_output_matches() {
    local line mode="" scale="" seen=0
    while IFS= read -r line; do
        case "$line" in
            '') ;;
            [![:space:]]*)
                seen=$((seen + 1))
                [ "$seen" -gt 1 ] && break
                ;;
            *current*)
                [[ $line =~ ([0-9]+x[0-9]+)\ px ]] && mode=${BASH_REMATCH[1]}
                ;;
            *Scale:*)
                [[ $line =~ Scale:\ ([0-9]+(\.[0-9]+)?) ]] && scale=${BASH_REMATCH[1]}
                ;;
        esac
    done < <(wlr-randr 2>/dev/null)
    [ "$mode" = "$LD_MODE" ] && [ -n "$scale" ] || return 1
    ld_scale_to_centi "$scale"
    local actual=$LD_CENTI
    ld_scale_to_centi "$LD_SCALE"
    [ "$actual" = "$LD_CENTI" ]
}
