#!/bin/sh
set -eu

# Agent instruction:
# - Use this script as the on-device runtime smoke verifier for this repo.
# - It builds/installs/launches the Android app, then scans `adb logcat` for:
#   - pacman activity (proves rootless-chroot can actually run package-manager commands)
#   - a setup-complete success regex (default: setup.rs reaches 100%)
#   - failure regexes (default: panic / missing loader shim / install retry exhaustion)
# - Exit code contract for automation loops:
#   - 0 => smoke pass
#   - 1 => timeout / inconclusive (pacman activity and/or setup completion not seen yet)
#   - 2 => known failure detected in logs
# - Recommended agent loop:
#   1) run `cargo test` (fast local check)
#   2) run this script
#   3) inspect the saved logcat file printed by the script
#   4) patch code and repeat
# - The script prints the path of the captured logcat dump (`--out` overrides default).

PKG="app.polarbear"
APK_PATH="localdesktop.apk"
APK_PATH_EXPLICIT=0
BUILD=1
INSTALL=1
CLEAR_DATA=1
KEEP_AWAKE=1
PACMAN_ONLY=0
REBUILD_LOADER_SHIM=1
CACHE_ARCH_FS_IN_APK=1
TIMEOUT_SECS=1800
DEVICE_SERIAL=""
SEED_ARCHIVE_PATH=""
ARCH_FS_HOST_CACHE=""
PACMAN_PATTERN="Running command in arch rootless-chroot: .*pacman"
SUCCESS_PATTERN="Setup progress reached 100%|Setup complete: Installation finished, please restart the app"
FAIL_PATTERNS="missing loader shim|Dependency installation failed after|install_dependencies: failed after|failed to initialize alpm library|config file /etc/pacman\\.d/mirrorlist could not be read|panic!|FATAL EXCEPTION|Fatal signal [0-9]+ .*app\\.polarbear|POLAR BEAR EXPECTATION|data_app_native_crash"
OUT_LOG="${TMPDIR:-/tmp}/localdesktop_smoke_logcat.txt"
XBUILD_DEBUG_APK_PATH="target/x/release/android/gradle/app/build/outputs/apk/debug/app-debug.apk"
APK_ARCH_FS_ASSET_PATH="assets/archlinux-fs.tar.xz"
GRADLE_APP_ASSETS_DIR="target/x/release/android/gradle/app/src/main/assets"

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --device SERIAL          adb device serial
  --apk PATH               apk path (default: Android host=${APK_PATH}; non-Android host=${XBUILD_DEBUG_APK_PATH})
  --skip-build             do not build APK (cargo run on Android host, x build elsewhere)
  --skip-install           do not run adb install -r
  --skip-clear-data        do not clear app data before launch
  --skip-keep-awake        do not try to keep device awake during smoke run
  --pacman-only            succeed once rootless pacman activity is observed (do not wait for setup completion)
  --skip-loader-shim-rebuild
                           do not rebuild assets/libs/arm64-v8a/librootless_chroot_loader.so from src before x build
  --skip-arch-fs-apk-cache
                           do not cache/embed archlinux-fs.tar.xz in APK assets before x build
  --arch-fs-cache PATH     host cache path for archlinux-fs.tar.xz used for APK asset embedding
  --seed-arch-fs PATH      host path to predownloaded archlinux-fs.tar.xz copied into app sandbox after pm clear
  --timeout SECONDS        wait timeout (default: ${TIMEOUT_SECS})
  --success REGEX          setup-complete success regex in logcat
  --fail REGEX             failure regex (default includes panic/shim/install failures)
  --out PATH               save logcat dump to path
  --help

Exit codes:
  0 pacman activity observed and setup-complete pattern observed
  1 timeout / missing pacman activity or setup-complete pattern
  2 failure pattern observed
EOF
}

require_opt_arg() {
  OPT_NAME="$1"
  OPT_VALUE="${2-}"
  case "$OPT_VALUE" in
    ""|--*)
      echo "Missing value for $OPT_NAME" >&2
      usage >&2
      exit 1
      ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --device)
      require_opt_arg "$1" "${2-}"
      DEVICE_SERIAL="$2"
      shift 2
      ;;
    --apk)
      require_opt_arg "$1" "${2-}"
      APK_PATH="$2"
      APK_PATH_EXPLICIT=1
      shift 2
      ;;
    --skip-build)
      BUILD=0
      shift
      ;;
    --skip-install)
      INSTALL=0
      shift
      ;;
    --skip-clear-data)
      CLEAR_DATA=0
      shift
      ;;
    --skip-keep-awake)
      KEEP_AWAKE=0
      shift
      ;;
    --pacman-only)
      PACMAN_ONLY=1
      shift
      ;;
    --skip-loader-shim-rebuild)
      REBUILD_LOADER_SHIM=0
      shift
      ;;
    --skip-arch-fs-apk-cache)
      CACHE_ARCH_FS_IN_APK=0
      shift
      ;;
    --arch-fs-cache)
      require_opt_arg "$1" "${2-}"
      ARCH_FS_HOST_CACHE="$2"
      shift 2
      ;;
    --seed-arch-fs)
      require_opt_arg "$1" "${2-}"
      SEED_ARCHIVE_PATH="$2"
      shift 2
      ;;
    --timeout)
      require_opt_arg "$1" "${2-}"
      TIMEOUT_SECS="$2"
      shift 2
      ;;
    --success)
      require_opt_arg "$1" "${2-}"
      SUCCESS_PATTERN="$2"
      shift 2
      ;;
    --fail)
      require_opt_arg "$1" "${2-}"
      FAIL_PATTERNS="$2"
      shift 2
      ;;
    --out)
      require_opt_arg "$1" "${2-}"
      OUT_LOG="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

host_is_android() {
  if [ -f /system/build.prop ]; then
    return 0
  fi
  if [ "$(uname -o 2>/dev/null || true)" = "Android" ]; then
    return 0
  fi
  return 1
}

if host_is_android; then
  HOST_KIND="android"
else
  HOST_KIND="non-android"
fi

if [ "$HOST_KIND" = "non-android" ] && [ "$APK_PATH_EXPLICIT" -eq 0 ]; then
  APK_PATH="$XBUILD_DEBUG_APK_PATH"
fi

ADB="adb"
if [ -n "$DEVICE_SERIAL" ]; then
  ADB="adb -s $DEVICE_SERIAL"
fi

run_adb() {
  # shellcheck disable=SC2086
  sh -c "$ADB $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing command: $1" >&2
    exit 1
  }
}

require_cmd adb
require_cmd grep

rebuild_loader_shim_asset() {
  SHIM_SRC="src/bin/rootless_chroot_loader.rs"
  SHIM_ASSET="assets/libs/arm64-v8a/librootless_chroot_loader.so"
  SHIM_TMP="${TMPDIR:-/tmp}/librootless_chroot_loader.so"

  if [ ! -f "$SHIM_SRC" ]; then
    echo "[smoke] Loader shim source missing: $SHIM_SRC" >&2
    exit 1
  fi

  require_cmd rustc
  echo "[smoke] Rebuilding packaged loader shim asset from source"
  rustc --target aarch64-linux-android "$SHIM_SRC" \
    -O -C panic=abort -C linker=rust-lld \
    -C link-arg=-static -C link-arg=-pie -C link-arg=--entry=_start \
    -o "$SHIM_TMP"
  cp "$SHIM_TMP" "$SHIM_ASSET"
  rm -f "$SHIM_TMP"
}

default_arch_fs_cache_path() {
  if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
    echo "${HOME}/Library/Caches/localdesktop/archlinux-fs.tar.xz"
  else
    echo "${XDG_CACHE_HOME:-$HOME/.cache}/localdesktop/archlinux-fs.tar.xz"
  fi
}

arch_fs_archive_url_from_config() {
  awk -F'"' '/ARCH_FS_ARCHIVE/ { print $2; exit }' src/core/config.rs
}

prepare_arch_fs_apk_asset() {
  SRC_PATH=""
  if [ -n "$SEED_ARCHIVE_PATH" ] && [ -f "$SEED_ARCHIVE_PATH" ]; then
    SRC_PATH="$SEED_ARCHIVE_PATH"
    echo "[smoke] Reusing --seed-arch-fs archive for APK asset: $SRC_PATH"
  else
    if [ -z "$ARCH_FS_HOST_CACHE" ]; then
      ARCH_FS_HOST_CACHE="$(default_arch_fs_cache_path)"
    fi
    SRC_PATH="$ARCH_FS_HOST_CACHE"
    if [ ! -f "$SRC_PATH" ]; then
      URL="$(arch_fs_archive_url_from_config)"
      if [ -z "$URL" ]; then
        echo "[smoke] Could not parse ARCH_FS_ARCHIVE from src/core/config.rs; skipping APK ArchFS asset cache" >&2
        return 0
      fi
      require_cmd curl
      mkdir -p "$(dirname "$SRC_PATH")"
      TMP_DL="${SRC_PATH}.part"
      rm -f "$TMP_DL"
      echo "[smoke] Downloading ArchFS cache for APK asset (one-time): $URL"
      curl -L --fail --retry 3 --retry-delay 2 -o "$TMP_DL" "$URL"
      mv "$TMP_DL" "$SRC_PATH"
      echo "[smoke] Cached ArchFS archive at: $SRC_PATH"
    else
      echo "[smoke] Using cached ArchFS archive for APK asset: $SRC_PATH"
    fi
  fi

  mkdir -p "$(dirname "$APK_ARCH_FS_ASSET_PATH")"
  cp "$SRC_PATH" "$APK_ARCH_FS_ASSET_PATH"
  echo "[smoke] Embedded ArchFS archive into APK assets: $APK_ARCH_FS_ASSET_PATH"
}

inject_arch_fs_asset_into_gradle_apk() {
  if [ ! -f "$APK_ARCH_FS_ASSET_PATH" ]; then
    echo "[smoke] ArchFS APK asset source missing: $APK_ARCH_FS_ASSET_PATH" >&2
    return 1
  fi
  if [ ! -d "$GRADLE_APP_ASSETS_DIR" ]; then
    echo "[smoke] Gradle app assets dir missing: $GRADLE_APP_ASSETS_DIR" >&2
    return 1
  fi
  require_cmd gradle
  cp "$APK_ARCH_FS_ASSET_PATH" "$GRADLE_APP_ASSETS_DIR/archlinux-fs.tar.xz"
  echo "[smoke] Injected ArchFS into generated Gradle assets: $GRADLE_APP_ASSETS_DIR/archlinux-fs.tar.xz"
  echo "[smoke] Reassembling debug APK after Gradle asset injection"
  (cd target/x/release/android/gradle && gradle assembleDebug)
}

if [ "$BUILD" -eq 1 ]; then
  if [ "$HOST_KIND" = "android" ]; then
    echo "[smoke] Building APK via cargo run (Android host)"
    cargo run
  else
    require_cmd x
    if [ "$REBUILD_LOADER_SHIM" -eq 1 ]; then
      rebuild_loader_shim_asset
    fi
    if [ "$CACHE_ARCH_FS_IN_APK" -eq 1 ]; then
      prepare_arch_fs_apk_asset
    fi
    echo "[smoke] Building APK via xbuild (non-Android host)"
    x build --release --platform android --arch arm64 --format apk
    if [ "$CACHE_ARCH_FS_IN_APK" -eq 1 ]; then
      inject_arch_fs_asset_into_gradle_apk
    fi
    echo "[smoke] Using debug APK for install: $XBUILD_DEBUG_APK_PATH"
    if [ "$APK_PATH_EXPLICIT" -eq 0 ]; then
      APK_PATH="$XBUILD_DEBUG_APK_PATH"
    fi
  fi
fi

if [ ! -f "$APK_PATH" ]; then
  echo "[smoke] APK not found: $APK_PATH" >&2
  exit 1
fi

if [ -n "$SEED_ARCHIVE_PATH" ] && [ ! -f "$SEED_ARCHIVE_PATH" ]; then
  echo "[smoke] Seed archive not found: $SEED_ARCHIVE_PATH" >&2
  exit 1
fi

echo "[smoke] Checking adb device"
run_adb "get-state" >/dev/null

if [ "$KEEP_AWAKE" -eq 1 ]; then
  echo "[smoke] Keeping device awake during smoke run"
  run_adb "shell svc power stayon usb" || true
  run_adb "shell input keyevent KEYCODE_WAKEUP" || true
  run_adb "shell wm dismiss-keyguard" || true
fi

if [ "$INSTALL" -eq 1 ]; then
  echo "[smoke] Installing APK: $APK_PATH"
  run_adb "install -r \"$APK_PATH\""
fi

if [ "$CLEAR_DATA" -eq 1 ]; then
  echo "[smoke] Clearing app data to force first-run setup (setup.rs -> 100%)"
  run_adb "shell pm clear $PKG"
fi

if [ -n "$SEED_ARCHIVE_PATH" ]; then
  REMOTE_SEED="/data/local/tmp/localdesktop_archlinux-fs.tar.xz"
  APP_DATA_DIR="/data/user/0/$PKG"
  echo "[smoke] Seeding Arch FS archive into app sandbox: $SEED_ARCHIVE_PATH"
  run_adb "push \"$SEED_ARCHIVE_PATH\" \"$REMOTE_SEED\""
  run_adb "shell run-as $PKG mkdir -p \"$APP_DATA_DIR/files\""
  run_adb "shell run-as $PKG cp \"$REMOTE_SEED\" \"$APP_DATA_DIR/files/archlinux-fs.tar.xz\""
  run_adb "shell run-as $PKG ls -lh \"$APP_DATA_DIR/files/archlinux-fs.tar.xz\"" >/dev/null
  run_adb "shell rm -f \"$REMOTE_SEED\"" || true
fi

echo "[smoke] Clearing logcat and stopping app"
run_adb "logcat -c" || true
run_adb "shell am force-stop $PKG" || true

echo "[smoke] Launching app"
run_adb "shell monkey -p $PKG -c android.intent.category.LAUNCHER 1" >/dev/null

START_TS=$(date +%s)
if [ "$PACMAN_ONLY" -eq 1 ]; then
  echo "[smoke] Waiting up to ${TIMEOUT_SECS}s for pacman activity (pacman-only mode)"
else
  echo "[smoke] Waiting up to ${TIMEOUT_SECS}s for pacman activity and setup completion"
fi

while :; do
  NOW_TS=$(date +%s)
  ELAPSED=$((NOW_TS - START_TS))
  run_adb "logcat -d -v time" >"$OUT_LOG" 2>/dev/null || true

  if grep -Eq "$FAIL_PATTERNS" "$OUT_LOG"; then
    echo "[smoke] FAILURE pattern matched: $FAIL_PATTERNS" >&2
    echo "[smoke] Log saved to: $OUT_LOG" >&2
    exit 2
  fi

  SAW_PACMAN=0
  SAW_SETUP_DONE=0
  if grep -Eq "$PACMAN_PATTERN" "$OUT_LOG"; then
    SAW_PACMAN=1
  fi
  if grep -Eq "$SUCCESS_PATTERN" "$OUT_LOG"; then
    SAW_SETUP_DONE=1
  fi

  if [ "$SAW_PACMAN" -eq 1 ]; then
    if [ "$PACMAN_ONLY" -eq 1 ]; then
      echo "[smoke] SUCCESS: observed pacman activity (pacman-only mode)"
      echo "[smoke] Pacman pattern: $PACMAN_PATTERN"
      echo "[smoke] Log saved to: $OUT_LOG"
      exit 0
    fi
    if [ "$SAW_SETUP_DONE" -eq 1 ]; then
      echo "[smoke] SUCCESS: observed pacman activity and setup completion"
      echo "[smoke] Pacman pattern: $PACMAN_PATTERN"
      echo "[smoke] Setup-complete pattern: $SUCCESS_PATTERN"
      echo "[smoke] Log saved to: $OUT_LOG"
      exit 0
    fi
  fi

  if [ "$ELAPSED" -ge "$TIMEOUT_SECS" ]; then
    echo "[smoke] TIMEOUT after ${TIMEOUT_SECS}s." >&2
    if [ "$SAW_PACMAN" -eq 0 ]; then
      echo "[smoke] Missing pacman activity pattern: $PACMAN_PATTERN" >&2
    fi
    if [ "$PACMAN_ONLY" -eq 0 ] && [ "$SAW_SETUP_DONE" -eq 0 ]; then
      echo "[smoke] Missing setup-complete pattern: $SUCCESS_PATTERN" >&2
    fi
    echo "[smoke] Log saved to: $OUT_LOG" >&2
    exit 1
  fi

  sleep 2
done
