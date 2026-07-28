#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API="${API:-30}"
ABI="${ABI:-arm64-v8a}"
TARGET="${TARGET:-aarch64-linux-android}"
OUT="${OUT:-$ROOT/assets/libs/$ABI/liblocaldesktop_pipewire_aaudio_sink.so}"

ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
if [[ -z "$ANDROID_NDK_HOME" ]]; then
  echo "ANDROID_NDK_HOME or ANDROID_NDK_ROOT must point to the Android NDK" >&2
  exit 2
fi

if [[ -z "${PIPEWIRE_PREFIX:-}" ]]; then
  echo "PIPEWIRE_PREFIX must point to an Android sysroot/prefix with PipeWire headers and libs" >&2
  exit 2
fi

case "$(uname -s)" in
  Darwin) HOST_TAG="${HOST_TAG:-darwin-x86_64}" ;;
  Linux) HOST_TAG="${HOST_TAG:-linux-x86_64}" ;;
  *) echo "Unsupported host OS; set HOST_TAG manually" >&2; exit 2 ;;
esac

TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG"
CC="${CC:-$TOOLCHAIN/bin/${TARGET}${API}-clang}"

PIPEWIRE_CFLAGS="${PIPEWIRE_CFLAGS:--I$PIPEWIRE_PREFIX/include/pipewire-0.3 -I$PIPEWIRE_PREFIX/include/spa-0.2}"
PIPEWIRE_LIBS="${PIPEWIRE_LIBS:--L$PIPEWIRE_PREFIX/lib -lpipewire-0.3}"

mkdir -p "$(dirname "$OUT")"

"$CC" \
  -std=c11 \
  -Wall \
  -Wextra \
  -Wno-unused-parameter \
  -fPIE \
  -pie \
  $PIPEWIRE_CFLAGS \
  "$ROOT/native/pipewire-aaudio-sink/localdesktop-pipewire-aaudio-sink.c" \
  $PIPEWIRE_LIBS \
  -ldl \
  -llog \
  -o "$OUT"

echo "wrote $OUT"
