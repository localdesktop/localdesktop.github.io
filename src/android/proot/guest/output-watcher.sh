#!/bin/bash
# Keeps labwc's wlroots output (mode, refresh rate, fractional scale) and the Xft DPI of
# Xwayland clients aligned with the Android host window.
#
# Event driven: the host writes /tmp/localdesktop-output and then a line into the FIFO
# /tmp/localdesktop-output.fifo. This script blocks on the FIFO with the bash builtin `read`
# (no process is spawned while idle) and re-reads the state file when woken. A slow timer
# covers a lost wakeup. It exits when labwc's Wayland socket disappears.
. /usr/local/lib/localdesktop/output-lib.sh

lock_file=/tmp/localdesktop-wlroots-output.pid
if [ -r "$lock_file" ]; then
    read -r old_pid < "$lock_file"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
        exit 0
    fi
fi
echo "$$" > "$lock_file"
trap 'rm -f "$lock_file"' EXIT
trap 'exit 0' INT TERM HUP

# Opening the FIFO read-write never blocks and keeps a reader attached, so the host's
# non-blocking write cannot fail with ENXIO between two loop iterations.
[ -p "$LD_OUTPUT_FIFO" ] || { rm -f "$LD_OUTPUT_FIFO"; mkfifo -m 600 "$LD_OUTPUT_FIFO"; }
exec 3<> "$LD_OUTPUT_FIFO"

compositor_alive() {
    [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/tmp}/$WAYLAND_DISPLAY" ]
}

applied=""       # "mode scale refresh" last applied to the output
applied_dpi=""   # DPI last written to xfconf
failures=0

while compositor_alive; do
    wait_s=30
    if ld_read_state; then
        config="$LD_MODE $LD_SCALE $LD_REFRESH"
        if [ "$config" != "$applied" ]; then
            if ld_first_output && ld_apply_output "$LD_OUTPUT_NAME"; then
                applied=$config
                failures=0
            else
                # labwc may not have created its output yet; retry quickly, but only for a while.
                failures=$((failures + 1))
                [ "$failures" -le 120 ] && wait_s=1
            fi
        fi
        dpi=$(ld_dpi_from_scale "$LD_SCALE")
        # Only talk to xfconf once the Xfce session bus exists; session-init covers the start.
        if [ "$dpi" != "$applied_dpi" ] && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && ld_apply_dpi "$dpi"; then
            applied_dpi=$dpi
        fi
    else
        wait_s=1
        failures=$((failures + 1))
        [ "$failures" -gt 120 ] && wait_s=30
    fi

    # Sleep until the host reports a change (or the timeout), then drain a burst of
    # notifications (fold animations send many) before re-reading the state. When the slow
    # fallback timer fires without a notification, re-apply if labwc drifted from the state.
    if read -r -t "$wait_s" -u 3 _; then
        while read -r -t 0.15 -u 3 _; do :; done
    elif [ "$wait_s" -ge 30 ] && ! ld_output_matches; then
        applied=""
    fi
done
