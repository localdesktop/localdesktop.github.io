#!/bin/sh
# Collect a concise Local Desktop support report without modifying the system.
# Run inside the Local Desktop Arch Linux environment:
#   sh scripts/localdesktop-support-report.sh

set -u

section() {
    printf '\n## %s\n' "$1"
}

run_optional() {
    label=$1
    shift
    printf '\n### %s\n' "$label"
    if command -v "$1" >/dev/null 2>&1; then
        "$@" 2>&1 || true
    else
        printf '%s is not installed\n' "$1"
    fi
}

printf '# Local Desktop support report\n'
printf 'Generated: '
date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date

section 'Environment'
printf 'User: %s\n' "$(id 2>/dev/null || true)"
printf 'Kernel: %s\n' "$(uname -a 2>/dev/null || true)"
printf 'Architecture: %s\n' "$(uname -m 2>/dev/null || true)"
printf 'Desktop: %s\n' "${XDG_CURRENT_DESKTOP:-unset}"
printf 'Session type: %s\n' "${XDG_SESSION_TYPE:-unset}"
printf 'Wayland display: %s\n' "${WAYLAND_DISPLAY:-unset}"
printf 'Display: %s\n' "${DISPLAY:-unset}"
printf 'Pulse server: %s\n' "${PULSE_SERVER:-unset}"
printf 'Runtime dir: %s\n' "${XDG_RUNTIME_DIR:-unset}"

section 'Android and device nodes'
for node in /dev/kgsl-3d0 /dev/dri/renderD128 /dev/dri/card0 /dev/mali0; do
    if [ -e "$node" ]; then
        ls -l "$node" 2>&1 || true
    else
        printf '%s: unavailable\n' "$node"
    fi
done

section 'Installed graphics packages'
if command -v pacman >/dev/null 2>&1; then
    pacman -Q 2>/dev/null | grep -Ei '^(mesa|vulkan|libglvnd|wayland|xorg-xwayland|labwc|xfce)' || true
else
    printf 'pacman is unavailable\n'
fi

run_optional 'OpenGL renderer' glxinfo -B
run_optional 'EGL information' eglinfo -B
run_optional 'Vulkan summary' vulkaninfo --summary
run_optional 'Wayland outputs' wlr-randr
run_optional 'PulseAudio sinks' pactl info
run_optional 'PulseAudio sink list' pactl list short sinks

section 'Storage mounts'
mount 2>/dev/null | grep -E '(/android|/root/Android|/sdcard|/dev|/proc|/sys)' || true

section 'Resource snapshot'
run_optional 'Memory' free -h
run_optional 'Processes by CPU' ps -eo pid,comm,%cpu,%mem --sort=-%cpu

cat <<'EOF'

## Interpretation notes
- The Android host compositor and applications inside PRoot are separate graphics layers.
- A hardware-accelerated host EGL/GLES compositor does not prove that guest applications use the GPU.
- Turnip is relevant to Qualcomm Adreno Vulkan workloads. It does not accelerate Mali devices.
- Missing /dev/kgsl-3d0 or a compatible Vulkan loader/ICD means Turnip cannot operate in the guest.
- Software renderers such as llvmpipe indicate guest-side CPU rendering.

Attach this complete report to the relevant GitHub issue. Remove any information you consider sensitive before posting.
EOF
