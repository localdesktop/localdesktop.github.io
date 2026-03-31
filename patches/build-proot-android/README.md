# build-proot-android

PRoot build scripts for Android. They produce PRoot binaries, statically linked with libtalloc, with unbundled loader and freely relocatable in a file tree.

Usage:
- Build or get prebuilt at https://github.com/green-green-avk/build-proot-android/tree/master/packages
- Unpack `<somewhere>`
- Run as `<somewhere>/root/bin/proot`\
for details, see https://github.com/green-green-avk/proot/blob/master/doc/usage/android/start-script-example
- ???
- Profit

How to build:
 - Dependencies: Android NDK / make / tar / gzip
 - Tune `config` file to match your environment
 - Run `./build.sh`

Vendored `build/proot` tracks the latest `termux/proot` `master` commit that
was current on March 31, 2026: `ab2e3464d04483b98a0614b470f3f8950d5a6468`
(committed on February 21, 2026). This repo still carries a small set of
downstream Android/APK build patches on top of that source snapshot.

See https://github.com/green-green-avk/proot for more info.
