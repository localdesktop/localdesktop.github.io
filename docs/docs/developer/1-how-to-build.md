---
title: How to build?
---

To build Local Desktop from source code, you can follow these steps:

1. Clone the source code repository:

   ```
   git clone https://github.com/localdesktop/localdesktop.git
   ```

1. Make sure you already have Rust and Cargo installed. If not, please check the official Rust website for [installation instructions](https://www.rust-lang.org/tools/install). Then, you can install the [xbuild](https://github.com/rust-mobile/xbuild) tool:

   ```
   cargo install xbuild
   ```

   > At the moment, you need to install a locally patched version of xbuild. Follow this instruction instead:
   >
   > ```
   > cd patches/xbuild
   > cargo install --path xbuild
   > ```

1. Build the project:

   ```
   x build --release --platform android --arch arm64 --format apk
   ```

Then you will find the APK file in `target/x/release/android/localdesktop.apk`.

## FAQ

### Can I build on Termux?

No. `xbuild` requires `rustup`, which, at the time of writing, is not available on Termux.

### Can I build on Termux & `proot-distro`?

Yes.
