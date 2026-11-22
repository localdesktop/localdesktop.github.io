---
title: Porting to other platforms
description: What it takes to build Local Desktop for an Android ABI other than arm64-v8a, such as x86_64, and which native libraries have to be rebuilt.
---

Local Desktop only ships binaries for **arm64-v8a**. That covers almost every Android phone and tablet sold today. If you want to run it somewhere else, for example an x86_64 Android emulator or a Chromebook, you have to build it from source, and rebuild every native library it bundles.

:::warning
This is an advanced topic, and nobody has done it end to end recently. Prepare to fix cross-compilation issues, and please share what you learn by editing this page.
:::

## What is arm64-only

Local Desktop's own code is Rust and Java, so it builds for any target Rust supports. The problem is everything else in the APK, which is prebuilt for arm64:

| What | Where | How it's built |
|---|---|---|
| PRoot and its loader | `assets/libs/arm64-v8a/libproot.so`, `libproot_loader.so` | `patches/build-proot-android/` |
| libxkbcommon | `assets/libs/arm64-v8a/libxkbcommon.so` | `patches/build-libxkbcommon/` (Docker) |
| PipeWire, WirePlumber and their modules | `assets/libs/arm64-v8a/` (see `PIPEWIRE_ASSETS_MANIFEST.txt`) | Taken from Termux packages |
| The PipeWire AAudio sink | `assets/libs/arm64-v8a/` | `scripts/build-pipewire-aaudio-sink.sh` |
| The guest's GPU drivers | `assets/guest-mesa.tar.xz` | `patches/build-mesa/` (Docker, `--platform linux/arm64`) |
| The dynamic loader for the guest | `assets/ld-linux-aarch64.so.1` | From Arch Linux ARM |

On top of that, `build.rs` links against `./assets/libs/arm64-v8a`, and the Arch Linux root filesystem that the app downloads (`src/core/config.rs`) is the aarch64 one. Both need to change for another architecture. The GPU drivers (Turnip) only make sense on Qualcomm Adreno GPUs anyway, so you can skip them on other platforms: Local Desktop falls back to software rendering.

## Rebuild the libraries

### libproot.so and libproot_loader.so

1. Set `$ANDROID_NDK_HOME` to your Android NDK.
2. In `patches/build-proot-android/config`, change `ARCHS='aarch64'` to your target architecture.
3. In `patches/build-proot-android/make-proot-assets.sh`, change the `assets/libs/arm64-v8a` folder to your target's [ABI folder](https://developer.android.com/ndk/guides/abis) (for example `x86_64`).
4. Build:

   ```bash
   cd patches/build-proot-android/
   ./build.sh
   ```

The script copies and strips `libproot.so` and `libproot_loader.so` into the assets folder for you. On Android, executables inside an APK have to be named `lib*.so`, or the system won't extract them, which is why PRoot is called `libproot.so`.

### libxkbcommon.so

1. Make sure Docker is installed.
2. Build:

   ```bash
   cd patches/build-libxkbcommon
   ./build.sh
   ```

3. Copy `patches/build-libxkbcommon/output/lib/libxkbcommon.so` into your `assets/libs/<abi>/` folder.

The Dockerfile compiles in the path where the guest's XKB data lives, `/data/data/io.github.localdesktop/files/arch/...`. If you change the package name in `manifest.yaml`, change it there too. See [the XKB bug](/docs/developer/bug-cheat-sheet/xkb-error) for why.

### libwayland.so

Not needed. [Smithay](https://github.com/Smithay/smithay) implements the Wayland server in pure Rust, so there's no `libwayland-server.so` to cross-compile.

## Build Local Desktop

If you unzip a Local Desktop APK, you will find `lib/arm64-v8a/liblocaldesktop.so`. That's where all the Rust code goes: the crate is a `cdylib` that Android's `NativeActivity` loads, and `android_main` is its entry point.

Normally you would build the `.so` with `cargo`, write an `AndroidManifest.xml`, and zip everything into an APK. xbuild does all of that from `manifest.yaml`. Once the libraries above are in `assets/libs/<abi>/`, build with:

```bash
x build --release --format apk --platform android --arch <arch>
```

The APK is in `target/x/release/android/gradle/app/build/outputs/apk/release/app-release.apk`.
