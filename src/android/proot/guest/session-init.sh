#!/bin/bash
# Runs from ~/.config/autostart once the Xfce session is starting.
#  - sets the Xft DPI that matches the host's current UI scale (the output watcher keeps it
#    up to date afterwards);
#  - refreshes the --no-sandbox application entries, but only when applications were
#    installed, removed or upgraded since the last run (hundreds of proot execs otherwise).
. /usr/local/lib/localdesktop/output-lib.sh

for _ in $(seq 1 50); do
    xfconf-query -c xsettings -lv >/dev/null 2>&1 && break
    sleep 0.1
done

dpi=@XFT_DPI@
if ld_read_state; then
    dpi=$(ld_dpi_from_scale "$LD_SCALE")
fi
ld_apply_dpi "$dpi"

stamp="${XDG_CACHE_HOME:-$HOME/.cache}/localdesktop/no-sandbox-entries.stamp"
stale=0
[ -e "$stamp" ] || stale=1
for dir in /usr/share/applications /usr/local/share/applications /var/lib/pacman/local; do
    [ "$dir" -nt "$stamp" ] && stale=1
done
if [ "$stale" = 1 ]; then
    mkdir -p "${stamp%/*}"
    # Touch first: anything installed while this runs is picked up by the next session.
    touch "$stamp"
    /usr/local/bin/localdesktop-no-sandbox-entries
fi
