#!/data/data/com.termux/files/usr/bin/bash
# build-termux.sh — Build LocalDesktop APK from Termux on Android
#
# Usage:
#   bash scripts/build-termux.sh
#
# The script is idempotent: already-installed packages and already-downloaded
# SDK components are skipped automatically.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_HOME="${ANDROID_HOME:-$HOME/.cache/x/Android.sdk}"
CARGO_BIN="$HOME/.cargo/bin"

echo "==> LocalDesktop Termux build"
echo "    Repo:         $REPO_ROOT"
echo "    ANDROID_HOME: $ANDROID_HOME"
echo ""

# ---------------------------------------------------------------------------
# 1. Termux dependencies
# ---------------------------------------------------------------------------
echo "[1/5] Installing Termux packages..."
pkg install -y rust openjdk-17 gradle ndk-multilib aapt2 2>/dev/null | tail -3

# ---------------------------------------------------------------------------
# 2. PATH setup
# ---------------------------------------------------------------------------
export PATH="$CARGO_BIN:$HOME/bin:$PATH"
export ANDROID_HOME

# Fake rustup shim: xbuild calls `rustup target add` to check targets.
# Termux's Rust already ships the aarch64-linux-android target.
RUSTUP_SHIM="$HOME/bin/rustup"
if [ ! -f "$RUSTUP_SHIM" ]; then
    echo "[2/5] Installing rustup shim..."
    mkdir -p "$HOME/bin"
    cat > "$RUSTUP_SHIM" << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
if [ "$1" = "target" ] && [ "$2" = "add" ]; then
    echo "info: component 'rust-std' for target '${3}' is up to date"
    exit 0
fi
echo "rustup shim: unsupported command: $*" >&2
exit 1
EOF
    chmod +x "$RUSTUP_SHIM"
else
    echo "[2/5] rustup shim already present."
fi

# ---------------------------------------------------------------------------
# 3. xbuild (patched fork — Android host support + AGP/KGP compatibility)
# ---------------------------------------------------------------------------
echo "[3/5] Installing xbuild..."
# MALLOC_TAG_LEVEL=0 avoids an LLVM/lld crash caused by Android pointer tagging
MALLOC_TAG_LEVEL=0 cargo install --path "$REPO_ROOT/patches/xbuild/xbuild" --force \
    2>&1 | grep -E "Compiling xbuild|Replacing|Installed|error" || true

# ---------------------------------------------------------------------------
# 4. Android SDK build-tools
# ---------------------------------------------------------------------------
echo "[4/5] Downloading Android SDK components..."
mkdir -p "$ANDROID_HOME/licenses"
# Accept standard SDK licenses
printf "24333f8a63b6825ea9c5514f83c2829b004d1fee\n8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e\n" \
    > "$ANDROID_HOME/licenses/android-sdk-license"
printf "84831b9409646a918e30573bab4c9c91346d8abd\n" \
    > "$ANDROID_HOME/licenses/android-sdk-preview-license"

if [ ! -d "$ANDROID_HOME/build-tools/34.0.0" ]; then
    MALLOC_TAG_LEVEL=0 cargo run --manifest-path "$REPO_ROOT/Cargo.toml" \
        --bin download_sdk 2>&1 | grep -v "^   Compiling\|^    Checking\|^warning"
else
    echo "    build-tools;34.0.0 already present."
fi

# ---------------------------------------------------------------------------
# 5. Build APK
# ---------------------------------------------------------------------------
echo "[5/5] Building APK..."
cd "$REPO_ROOT"
MALLOC_TAG_LEVEL=0 x build --release --platform android --arch arm64 --format apk

APK="$REPO_ROOT/target/x/release/android/localdesktop.apk"
if [ -f "$APK" ]; then
    echo ""
    echo "✅ Build successful!"
    echo "   APK: $APK"
    echo "   Size: $(du -h "$APK" | cut -f1)"
else
    echo "❌ Build failed — APK not found." >&2
    exit 1
fi
