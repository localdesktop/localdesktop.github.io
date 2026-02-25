#!/bin/sh
set -eu

# Agent instruction:
# - Use this script as the on-device runtime smoke verifier for this repo.
# - It builds/installs/launches the Android app, then scans `adb logcat` for:
#   - a success regex (default: rootless-chroot command execution observed)
#   - failure regexes (default: panic / missing loader shim / install retry exhaustion)
# - Exit code contract for automation loops:
#   - 0 => smoke pass
#   - 1 => timeout / inconclusive (success pattern not seen yet)
#   - 2 => known failure detected in logs
# - Recommended agent loop:
#   1) run `cargo test` (fast local check)
#   2) run this script
#   3) inspect the saved logcat file printed by the script
#   4) patch code and repeat
# - The script prints the path of the captured logcat dump (`--out` overrides default).

PKG="app.polarbear"
APK_PATH="localdesktop.apk"
BUILD=1
INSTALL=1
TIMEOUT_SECS=120
DEVICE_SERIAL=""
SUCCESS_PATTERN="Running command in arch rootless-chroot"
FAIL_PATTERNS="missing loader shim|Dependency installation failed after|panic!|FATAL EXCEPTION"
OUT_LOG="${TMPDIR:-/tmp}/localdesktop_smoke_logcat.txt"

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --device SERIAL          adb device serial
  --apk PATH               apk path (default: ${APK_PATH})
  --skip-build             do not run cargo run
  --skip-install           do not run adb install -r
  --timeout SECONDS        wait timeout (default: ${TIMEOUT_SECS})
  --success REGEX          success regex in logcat
  --fail REGEX             failure regex (default includes panic/shim/install failures)
  --out PATH               save logcat dump to path
  --help

Exit codes:
  0 success pattern observed and no failure pattern seen first
  1 timeout / no success pattern
  2 failure pattern observed
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --device)
      DEVICE_SERIAL="${2:?missing serial}"
      shift 2
      ;;
    --apk)
      APK_PATH="${2:?missing apk path}"
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
    --timeout)
      TIMEOUT_SECS="${2:?missing timeout}"
      shift 2
      ;;
    --success)
      SUCCESS_PATTERN="${2:?missing regex}"
      shift 2
      ;;
    --fail)
      FAIL_PATTERNS="${2:?missing regex}"
      shift 2
      ;;
    --out)
      OUT_LOG="${2:?missing path}"
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

if [ "$BUILD" -eq 1 ]; then
  echo "[smoke] Building APK via cargo run"
  cargo run
fi

if [ ! -f "$APK_PATH" ]; then
  echo "[smoke] APK not found: $APK_PATH" >&2
  exit 1
fi

echo "[smoke] Checking adb device"
run_adb "get-state" >/dev/null

if [ "$INSTALL" -eq 1 ]; then
  echo "[smoke] Installing APK: $APK_PATH"
  run_adb "install -r \"$APK_PATH\""
fi

echo "[smoke] Clearing logcat and stopping app"
run_adb "logcat -c" || true
run_adb "shell am force-stop $PKG" || true

echo "[smoke] Launching app"
run_adb "shell monkey -p $PKG -c android.intent.category.LAUNCHER 1" >/dev/null

START_TS=$(date +%s)
echo "[smoke] Waiting up to ${TIMEOUT_SECS}s for success pattern"

while :; do
  NOW_TS=$(date +%s)
  ELAPSED=$((NOW_TS - START_TS))
  run_adb "logcat -d -v time" >"$OUT_LOG" 2>/dev/null || true

  if grep -Eq "$FAIL_PATTERNS" "$OUT_LOG"; then
    echo "[smoke] FAILURE pattern matched: $FAIL_PATTERNS" >&2
    echo "[smoke] Log saved to: $OUT_LOG" >&2
    exit 2
  fi

  if grep -Eq "$SUCCESS_PATTERN" "$OUT_LOG"; then
    echo "[smoke] SUCCESS pattern matched: $SUCCESS_PATTERN"
    echo "[smoke] Log saved to: $OUT_LOG"
    exit 0
  fi

  if [ "$ELAPSED" -ge "$TIMEOUT_SECS" ]; then
    echo "[smoke] TIMEOUT after ${TIMEOUT_SECS}s. Success pattern not found." >&2
    echo "[smoke] Log saved to: $OUT_LOG" >&2
    exit 1
  fi

  sleep 2
done
