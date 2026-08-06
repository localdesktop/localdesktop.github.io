#!/usr/bin/env bash
# build-pipewire-aaudio-sink.sh — cross-compile the standalone PipeWire/AAudio
# sink client (src/bin/localdesktop_pipewire_aaudio_sink.rs) for Android.
#
# Usage:
#   ANDROID_NDK_HOME=... PIPEWIRE_PREFIX=... ./scripts/build-pipewire-aaudio-sink.sh
#
# PIPEWIRE_PREFIX must be an Android/Termux sysroot containing libpipewire-0.3
# plus the PipeWire and SPA headers. The default build API is 30 to match the
# bundled Termux PipeWire binary; override API only if your sysroot has a
# different Android API floor.
#
# The output filename uses `.so` because Android reliably extracts native
# libraries from the APK. It is still an executable, following the existing
# libproot.so packaging pattern.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

# Cargo/cc/bindgen spell the same target three different ways.
TARGET_SNAKE="${TARGET//-/_}"
TARGET_SHOUT="$(echo "$TARGET_SNAKE" | tr '[:lower:]' '[:upper:]')"

export "CARGO_TARGET_${TARGET_SHOUT}_LINKER=$CC"
# Android 15+ 16 KB page devices; the Rust target still defaults to 4 KB.
# scripts/check_elf_alignment.sh verifies the result.
export "CARGO_TARGET_${TARGET_SHOUT}_RUSTFLAGS=-C link-arg=-Wl,-z,max-page-size=16384"
export "CC_${TARGET_SNAKE}=$CC"
export "AR_${TARGET_SNAKE}=$TOOLCHAIN/bin/llvm-ar"
export BINDGEN_EXTRA_CLANG_ARGS="--target=${TARGET}${API} --sysroot=$TOOLCHAIN/sysroot ${BINDGEN_EXTRA_CLANG_ARGS:-}"

# pipewire-sys/libspa-sys locate their headers through system-deps. Feed it the
# sysroot directly instead of requiring a cross-aware pkg-config.
export SYSTEM_DEPS_LIBPIPEWIRE_NO_PKG_CONFIG=1
export SYSTEM_DEPS_LIBPIPEWIRE_LIB=pipewire-0.3
export SYSTEM_DEPS_LIBPIPEWIRE_SEARCH_NATIVE="$PIPEWIRE_PREFIX/lib"
export SYSTEM_DEPS_LIBPIPEWIRE_INCLUDE="$PIPEWIRE_PREFIX/include/pipewire-0.3:$PIPEWIRE_PREFIX/include/spa-0.2"
export SYSTEM_DEPS_LIBSPA_NO_PKG_CONFIG=1
export SYSTEM_DEPS_LIBSPA_LIB=pipewire-0.3
export SYSTEM_DEPS_LIBSPA_SEARCH_NATIVE="$PIPEWIRE_PREFIX/lib"
export SYSTEM_DEPS_LIBSPA_INCLUDE="$PIPEWIRE_PREFIX/include/spa-0.2"

cargo build \
  --manifest-path "$ROOT/Cargo.toml" \
  --release \
  --target "$TARGET" \
  --features pipewire-sink \
  --bin localdesktop_pipewire_aaudio_sink

TARGET_DIR="$(cargo metadata --manifest-path "$ROOT/Cargo.toml" --format-version 1 --no-deps \
  | tr ',' '\n' | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p' | head -1)"
TARGET_DIR="${TARGET_DIR:-$ROOT/target}"

mkdir -p "$(dirname "$OUT")"
cp "$TARGET_DIR/$TARGET/release/localdesktop_pipewire_aaudio_sink" "$OUT"

echo "wrote $OUT"
