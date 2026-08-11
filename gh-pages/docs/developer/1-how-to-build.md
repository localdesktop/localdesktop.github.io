---
title: How to build?
---

To build Local Desktop from source code, you can follow these steps:

1. Clone the source code repository:

   ```
   git clone https://github.com/localdesktop/localdesktop.github.io.git
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

### Can I test a release-signed APK from a PR?

Yes. Same-repository PRs targeting `main` produce a signed release APK artifact when they have exactly one app-release label: `release:breaking`, `release:feature`, `release:bugfix`, `release:patch`, `release:improvement`, or `release:optimisation`. Download the `.apk` workflow artifact from GitHub Actions and install it over the GitHub APK. Older artifacts may still download as `.zip` files.

PRs labeled `release:docs` do not build an APK.

### Can I build on Termux?

Yes.

For the simplest path, install Rust in Termux and run:

```bash
pkg i rust
cargo run
```

This uses the built-in Rust APK builder and writes `localdesktop.apk` in the project root.

If you want to use the patched `xbuild` pipeline on Termux, run:

```bash
bash scripts/build-termux.sh
```

This writes the APK to `target/x/release/android/localdesktop.apk`.

### Can I build on Termux & `proot-distro`?

Yes.
