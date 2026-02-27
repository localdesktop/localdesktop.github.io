#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PKG="${PKG:-app.polarbear}"
ACTIVITY="${ACTIVITY:-android.app.NativeActivity}"
APK_PATH="${APK_PATH:-target/x/release/android/gradle/app/build/outputs/apk/debug/app-debug.apk}"
WAIT_SECONDS="${WAIT_SECONDS:-15}"

echo "[1/3] Build APK"
x build --release --platform android --arch arm64 --format apk

echo "[2/3] Install APK"
adb install -r -d "$APK_PATH"

echo "[3/3] Launch app and collect logs"
adb shell am force-stop "$PKG" || true
adb logcat -c
adb shell am start -n "$PKG/$ACTIVITY"
sleep "$WAIT_SECONDS"

APP_PID="$(adb shell pidof "$PKG" 2>/dev/null || true)"
echo "App PID: ${APP_PID:-<not-running>}"

LOG_OUT="${LOG_OUT:-/tmp/localdesktop-logcat.txt}"
adb logcat -d > "$LOG_OUT"
echo "Log snapshot saved to: $LOG_OUT"

echo "Filtered highlights:"
rg -n \
  "localdesktop|proot-rs|proot|ApplicationContext|unsupported|Failed|error|panic|RustStdoutStderr|libpenguin" \
  "$LOG_OUT" || true
