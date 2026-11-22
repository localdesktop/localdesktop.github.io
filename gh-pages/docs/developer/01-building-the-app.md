---
title: Building the app
description: Build the Local Desktop APK from source on macOS, Linux, Docker or Termux, and how releases are made from pull request labels.
---

Local Desktop is one Rust crate, plus a few Java classes, packaged into an APK with a patched version of [xbuild](https://github.com/rust-mobile/xbuild). This page shows how to build it on a computer, in Docker, or on your phone.

## What you need

- [Rust](https://www.rust-lang.org/tools/install), with the Android target: `rustup target add aarch64-linux-android`
- JDK 17 and Gradle 8, since xbuild uses Gradle to compile the Java code and package the APK
- The Android SDK. xbuild downloads the NDK it needs by itself.

:::tip
If you use VS Code or Cursor, the [Local Desktop Dev extension](/docs/developer/using-the-maintainer-tools) has a **Doctor** that checks all of this for you and tells you what's missing.
:::

## Build

1. Clone the repository:

   ```bash
   git clone https://github.com/localdesktop/localdesktop.github.io.git
   cd localdesktop.github.io
   ```

2. Install our patched xbuild. It adds Android services, Java sources and a few other things that upstream xbuild doesn't support yet (see [Patching dependencies](/docs/developer/patching-dependencies)):

   ```bash
   cargo install --path patches/xbuild/xbuild --force
   ```

   This installs the `x` command. Use `--force` so that an older `x` gets replaced when the patch changes.

3. Build a debug APK:

   ```bash
   x build --platform android --arch arm64 --format apk
   ```

   Or a release APK:

   ```bash
   x build --release --platform android --arch arm64 --format apk
   ```

The APKs are in:

| Build | APK |
|---|---|
| Debug | `target/x/debug/android/gradle/app/build/outputs/apk/debug/app-debug.apk` |
| Release | `target/x/release/android/gradle/app/build/outputs/apk/release/app-release.apk` |

For a debug build, the unstripped `.so` files (with symbols, for a debugger or a crash report) are in `target/x/debug/android/gradle/app/src/main/jniLibs/arm64-v8a/`.

Install it with `adb install -r <apk>`. Only arm64 devices are supported.

:::danger
If `adb install` fails with a signature mismatch (for example, a debug build over a release from GitHub), **don't uninstall the app** unless you are ready to lose its data. Uninstalling deletes Arch Linux and everything in it.
:::

### With `make` or Docker

The `Makefile` has two shortcuts:

- `make build` installs the patched xbuild and builds a release APK.
- `make build-docker` builds inside Docker (Android SDK 30, JDK 17, Gradle 8 and Rust are set up in the `Dockerfile`), then copies `target/` back to your machine. Use it if you don't want to install the toolchain.

## Release builds

You don't build releases yourself: GitHub Actions builds and signs them from the label on your pull request. See [Contributing](/docs/developer/contributing#the-release-label).

## FAQ

### Can I test a release-signed APK from a PR?

Yes, see [Contributing](/docs/developer/contributing#what-happens-after-you-label-it).

### Can I build on Termux?

Yes, right on your phone. See [Anyone Can Code](/blog/2026/02/28/anyone-can-code) for the whole story.

For the simplest path, install Rust in Termux and run:

```bash
pkg i rust
cargo run
```

This uses our own small APK builder (`src/bin/build_apk.rs`) instead of xbuild and Gradle, and writes `localdesktop.apk` in the project root. It packages the prebuilt `src/android/dex/classes.dex` instead of compiling the Java code, so if you change a `.java` file, rebuild the dex first (see `src/android/dex/README.md`).

If you want the same patched xbuild pipeline as CI, run:

```bash
bash scripts/build-termux.sh
```

It installs the Termux packages it needs (Rust, OpenJDK 17, Gradle, the NDK and `aapt2`), sets up the SDK, then builds a release APK at `target/x/release/android/gradle/app/build/outputs/apk/release/app-release.apk`.

### Can I build inside Local Desktop, or Termux + `proot-distro`?

Not easily. The `cargo run` builder only runs on Android itself (Termux), not inside a Linux distro. The xbuild pipeline needs the Android SDK, and Google doesn't publish its build tools for ARM64 Linux. Use Termux on the same phone instead, it's the path we test.
