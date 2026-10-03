#!/bin/bash
# localdesktop-update: opt-in system update (pacman -Syu).
#
# Local Desktop never updates the guest on its own after the first install, so security fixes
# (Firefox above all, which runs without its content sandbox here) only arrive when you run
# this. Packages listed in IgnorePkg in /etc/pacman.conf (the PipeWire set, which has to match
# the Android-side PipeWire daemon) stay on their installed version.
if [ "$(id -u)" != 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        exec sudo "$0" "$@"
    fi
    echo "localdesktop-update must run as root (no sudo available for $(id -un))." >&2
    exit 1
fi

wait_for_enter() {
    # Menu launcher (LOCALDESKTOP_PAUSE=1): keep the terminal window open so the result can be read.
    if [ -n "${LOCALDESKTOP_PAUSE:-}" ]; then
        printf '\nPress Enter to close this window. '
        read -r _
    fi
}

state_dir=/etc/localdesktop
mkdir -p "$state_dir"
rm -f /var/lib/pacman/db.lck

echo "== Updating the system (pacman -Syu) =="
echo "Packages held back by IgnorePkg:"
grep -E '^\s*IgnorePkg' /etc/pacman.conf || echo "  (none)"
echo

if pacman -Syu --noconfirm "$@"; then
    status=0
else
    echo
    echo "pacman failed. Refreshing the package signing keys and trying once more..."
    if pacman -Sy --noconfirm --needed archlinuxarm-keyring &&
        pacman-key --populate archlinuxarm &&
        pacman -Su --noconfirm "$@"; then
        status=0
    else
        status=1
    fi
fi

if [ "$status" = 0 ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$state_dir/last-update"
    echo
    echo "Update finished. Restart the desktop (close and reopen the app) to use updated programs."
else
    echo
    echo "The update failed. Check your network connection and run localdesktop-update again."
fi
wait_for_enter
exit "$status"
