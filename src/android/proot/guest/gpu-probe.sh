#!/bin/bash
# localdesktop-gpu-probe: diagnostics for the experimental Adreno GPU path (Phase-0 probes).
# Writes /var/log/localdesktop/gpu-probe.txt and prints it. Safe to run any time; it changes nothing.
#
# It always probes with the KGSL Mesa environment from /etc/localdesktop/gpu-env.sh (written when
# [gpu] enabled = true), falling back to a plain environment so the two can be compared.
report=/var/log/localdesktop/gpu-probe.txt
mkdir -p "${report%/*}" 2>/dev/null || report=/tmp/localdesktop-gpu-probe.txt
prefix=@MESA_PREFIX@

interactive=0
[ -n "${LOCALDESKTOP_PAUSE:-}" ] && interactive=1   # set by the menu launcher
exec > >(tee "$report") 2>&1

section() { printf '\n===== %s =====\n' "$*"; }
run() {
    printf '$ %s\n' "$*"
    timeout 60 "$@" 2>&1 | head -n "${LINES_MAX:-80}"
    printf '(exit %s)\n' "${PIPESTATUS[0]}"
}

echo "Local Desktop GPU probe, $(date -u +%Y-%m-%dT%H:%M:%SZ)"

section "Configuration"
echo "KGSL Mesa prefix: $prefix"
if [ -r "$prefix/.release" ]; then echo "installed release: $(cat "$prefix/.release")"; else echo "installed release: NOT INSTALLED (set [gpu] enabled = true and restart the app)"; fi
if [ -r /etc/localdesktop/gpu-env.sh ]; then
    echo "gpu-env.sh present (GPU enabled in localdesktop.toml)"
    . /etc/localdesktop/gpu-env.sh
else
    echo "gpu-env.sh missing: [gpu] enabled is false, probing the stock software renderer"
fi
echo "uname: $(uname -a)"
echo "page size: $(getconf PAGESIZE)"
env | grep -E '^(LD_LIBRARY_PATH|LIBGL_|MESA_|GALLIUM_|VK_|TU_|ZINK_|__EGL_|GBM_|DRIRC_|WLR_|GSK_|LP_NUM)' | sort

section "Device nodes (must be openable by this app inside proot)"
for node in /dev/kgsl-3d0 /dev/dma_heap/system /dev/ion /dev/dri/renderD128 /dev/ashmem; do
    if [ -e "$node" ]; then
        ls -l "$node"
        if ( exec 9<>"$node" ) 2>/dev/null; then echo "  open(O_RDWR): OK"; else echo "  open(O_RDWR): FAILED (permission or SELinux)"; fi
    else
        echo "$node: missing"
    fi
done
for file in /sys/class/kgsl/kgsl-3d0/gpu_model /sys/class/kgsl/kgsl-3d0/gpuclk /sys/class/kgsl/kgsl-3d0/devfreq/cur_freq; do
    [ -r "$file" ] && echo "$file: $(cat "$file" 2>/dev/null)"
done

section "Wayland globals of the host compositor (dmabuf support decides the present path)"
if command -v wayland-info >/dev/null 2>&1; then
    WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}" \
        timeout 10 wayland-info 2>&1 | grep -E 'interface:' | sed 's/^[[:space:]]*//' | head -n 60
else
    echo "wayland-info not installed (package wayland-utils)"
fi

section "Vulkan (Turnip)"
if command -v vulkaninfo >/dev/null 2>&1; then
    export TU_DEBUG="${TU_DEBUG:+$TU_DEBUG,}startup"
    run vulkaninfo --summary
    unset TU_DEBUG
    echo
    echo "WSI-related extensions (needed by Mesa's Wayland present path):"
    vulkaninfo 2>/dev/null | grep -E 'VK_KHR_external_memory_fd|VK_EXT_external_memory_dma_buf|VK_EXT_image_drm_format_modifier|VK_KHR_wayland_surface' | sort -u
else
    echo "vulkaninfo not installed (package vulkan-tools)"
fi

section "EGL / OpenGL"
if command -v eglinfo >/dev/null 2>&1; then
    LINES_MAX=60 EGL_PLATFORM=surfaceless run eglinfo -B
else
    echo "eglinfo not installed (package mesa-utils)"
fi
if command -v glxinfo >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
    LINES_MAX=40 run glxinfo -B
fi

section "glmark2 offscreen (30 s cap)"
if command -v glmark2-es2 >/dev/null 2>&1; then
    EGL_PLATFORM=surfaceless run glmark2-es2 --off-screen -b build:duration=2.0 -b texture:duration=2.0
elif command -v glmark2 >/dev/null 2>&1; then
    run glmark2 --off-screen -b build:duration=2.0 -b texture:duration=2.0
else
    echo "glmark2 not installed (package glmark2)"
fi

section "Same probes with the stock software renderer (for comparison)"
if command -v eglinfo >/dev/null 2>&1; then
    env -u LD_LIBRARY_PATH -u LIBGL_DRIVERS_PATH -u MESA_LOADER_DRIVER_OVERRIDE -u __EGL_VENDOR_LIBRARY_FILENAMES \
        -u GALLIUM_DRIVER -u VK_ICD_FILENAMES -u VK_DRIVER_FILES -u GBM_BACKENDS_PATH \
        EGL_PLATFORM=surfaceless LINES_MAX=30 bash -c 'timeout 60 eglinfo -B 2>&1 | head -n 30'
fi

echo
echo "Report saved to $report"
if [ "$interactive" = 1 ]; then
    # Opened from a terminal launcher: keep the window until the report was read.
    sleep 0.3
    printf '\nPress Enter to close this window. '
    read -r _ < /dev/tty
fi
