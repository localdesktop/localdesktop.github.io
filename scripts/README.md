# Proot build helper scripts

scripts/update-proot-from-termux.sh

- Fetches Termux's `proot` source via the included `patches/build-proot-android` helper, builds it
  (requires Android NDK and other build dependencies), then searches the build output for
  `libproot.so` and `libproot_loader.so` and copies them into `assets/libs/arm64-v8a`.

Usage:

1. Ensure Android NDK is installed and `patches/build-proot-android/config` is edited to point to it.
2. Make the script executable:

```bash
chmod +x scripts/update-proot-from-termux.sh
```

3. Run the script from the repo root:

```bash
./scripts/update-proot-from-termux.sh
```

Notes:

- Building is environment-dependent and may take time. If no .so files are found, inspect
  `patches/build-proot-android/build` for build artifacts and adapt the helper scripts.
