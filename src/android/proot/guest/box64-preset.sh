#!/bin/sh
# box64-preset PRESET PROGRAM [ARGS...]: run an x86_64 program under Box64 with a preset.
#
# The presets are the ones GameNative ships (Box86_64PresetManager.java, GPL-3.0,
# https://github.com/utkarshdalal/GameNative), expressed as BOX64_* environment variables.
# A variable you have already set is NOT overridden: `BOX64_DYNAREC_FORWARD=1024 box64-preset
# performance app` keeps 1024. Per-program tweaks belong in ~/.box64rc (see /etc/box64.box64rc).
#
#   stability      slowest, safest (strict memory model, safe flags)
#   compatibility  default of the `box64` command in /usr/local/bin
#   intermediate   balanced
#   performance    fastest, may break some programs
#   denuvo         stability tuned for Denuvo-protected games
#   unity          performance tuned for Unity Player games
usage() {
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit "${1:-2}"
}

case "${1:-}" in
    -h | --help | help) usage 0 ;;
esac
[ $# -ge 2 ] || usage

preset=$1
shift

set_default() { eval "[ -n \"\${$1+x}\" ] || export $1=$2"; }

case "$preset" in
    stability)     s=2 fn=0 fr=0 x87=1 bb=0 sm=2 fw=128 cr=0 w=0 avx=0 up=1 m32=0 ;;
    compatibility) s=2 fn=0 fr=0 x87=1 bb=0 sm=1 fw=128 cr=0 w=1 avx=0 up=1 m32=0 ;;
    intermediate)  s=2 fn=1 fr=0 x87=1 bb=1 sm=0 fw=128 cr=0 w=1 avx=0 up=0 m32=1 ;;
    performance)   s=1 fn=1 fr=1 x87=0 bb=3 sm=0 fw=512 cr=1 w=1 avx=0 up=0 m32=1 ;;
    denuvo)        s=2 fn=0 fr=0 x87=1 bb=0 sm=3 fw=512 cr=0 w=0 avx=0 up=1 m32=0 ;;
    unity)         s=1 fn=1 fr=1 x87=0 bb=3 sm=1 fw=512 cr=1 w=0 avx=2 up=0 m32=0 ;;
    *)
        echo "box64-preset: unknown preset '$preset'" >&2
        usage ;;
esac

set_default BOX64_DYNAREC_SAFEFLAGS "$s"
set_default BOX64_DYNAREC_FASTNAN "$fn"
set_default BOX64_DYNAREC_FASTROUND "$fr"
set_default BOX64_DYNAREC_X87DOUBLE "$x87"
set_default BOX64_DYNAREC_BIGBLOCK "$bb"
set_default BOX64_DYNAREC_STRONGMEM "$sm"
set_default BOX64_DYNAREC_FORWARD "$fw"
set_default BOX64_DYNAREC_CALLRET "$cr"
set_default BOX64_DYNAREC_WAIT "$w"
set_default BOX64_AVX "$avx"
set_default BOX64_UNITYPLAYER "$up"
set_default BOX64_MMAP32 "$m32"
# Always on: no startup banner, route GLX through the native Mesa (Xwayland).
set_default BOX64_NOBANNER 1
set_default BOX64_X11GLX 1

exec /usr/bin/box64 "$@"
