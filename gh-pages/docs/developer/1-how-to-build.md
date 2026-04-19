---
title: How to build?
---

To build Local Desktop from source code, you can follow one of these supported paths.

## Simple build on Termux

This is the easiest way to build directly on an Android device.

1. Clone the source code repository:

   ```
   git clone https://github.com/localdesktop/localdesktop.github.io.git
   ```

2. Install Rust in Termux:

   ```
   pkg i rust
   ```

3. Build the project:

   ```bash
   cargo run
   ```

This uses the built-in Rust APK builder and writes the APK to `localdesktop.apk` in the project root.

## `xbuild` pipeline on desktop or advanced Termux setups

Use this path if you want the same packaging pipeline as desktop cross-builds, need to build from Linux/macOS/Windows, or want to use the helper script on Termux.

1. Clone the source code repository:

   ```
   git clone https://github.com/localdesktop/localdesktop.github.io.git
   ```

2. Make sure you already have Rust and Cargo installed. If not, please check the official Rust website for [installation instructions](https://www.rust-lang.org/tools/install).

3. Install the locally patched version of [xbuild](https://github.com/rust-mobile/xbuild):

   ```
   cd patches/xbuild
   cargo install --path xbuild
   ```

4. Build the project:

   ```
   x build --release --platform android --arch arm64 --format apk
   ```

Then you will find the APK file in `target/x/release/android/localdesktop.apk`.

## FAQ

### Can I build on Termux?

Yes.

For the simplest path, use `cargo run`.

If you want to use the patched `xbuild` pipeline on Termux, run:

```bash
bash scripts/build-termux.sh
```

### Can I build on Termux & `proot-distro`?

Yes.
