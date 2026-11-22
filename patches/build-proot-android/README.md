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

One of them is in `src/syscall/seccomp.c`: the seccomp filter traps only the
`ioctl` requests PRoot rewrites (the `TCSETS*`/`TCGETS2` family and `FICLONE`)
instead of every `ioctl`, so GPU drivers in the guest (Turnip on KGSL) don't
stop at the tracer on each command submission.

Another is in `src/extension/fake_id0/chmod.c`: `chmod` on a file outside the
guest rootfs is still dropped, except on the app's own files (a directory bound
into the guest, such as `/home`), so a script or binary written there can be
made executable.

And in `src/extension/fake_id0/fake_id0.c`: `fstat` on a socket, eventfd or other descriptor
that isn't a file gets the real `fstat`, instead of a `stat` of its `/proc/self/fd` link
(`socket:[N]`), which fails. Node checks its standard streams with `fstat`, and a child process
gets sockets for them, so every Node or Electron child process aborted at startup.

And in `src/extension/fake_id0/helper_functions.c` and `unlink.c`: the meta file for a path
with a trailing slash (`dir/`) goes next to the directory, not inside it as
`.proot-meta-file..meta`, and `rmdir` removes the meta files left in a directory that holds
nothing else. The app runs PRoot with `-H`, which hides meta files from directory listings
(or `makepkg` packs them and fails), so a program that empties a directory can't see them.

The shipped `libproot.so` is built with `./build.sh` (NDK r28). On macOS, put a
GNU `install` (or a wrapper that handles `install -D`) first in `PATH`, and set
`STRIP` to the NDK's `llvm-strip`, since Apple's `strip` can't read Android binaries.

See https://github.com/green-green-avk/proot for more info.
