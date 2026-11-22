---
title: "Device unsupported"
sidebar_label: Device unsupported
description: Why Local Desktop shows "Device Unsupported", how its PRoot support check works, and how a PRoot build flag caused it on phones that should work.
---

## Issue

Instead of the installer, Local Desktop shows the **Device Unsupported!** page on a phone that should work, often a recent one, while Termux with `proot-distro` works fine on the same phone.

## How the check works

Before anything else, `setup()` in `src/android/proot/setup.rs` calls `ArchProcess::is_supported()` (`src/android/proot/process.rs`). It extracts a tiny test rootfs, and runs a binary in it with `--help` through PRoot. If that fails, there's no point in downloading anything, so the app shows `assets/unsupported.html` instead, and logs:

```
PRoot support check failed, showing Device Unsupported page
```

The lines just before it in the logcat show PRoot's own error, which is where the real cause is.

## Known cause: PRoot built without `process_vm_readv`

PRoot used to be built with `API=21`. Bionic only declares `process_vm_readv()` from API 23, so PRoot's build-time feature check failed silently, and it was built without it (`libproot.so -V` printed `process_vm = no`).

Without `process_vm_readv`, PRoot reads the traced program's memory one word at a time with `ptrace(PTRACE_PEEKDATA)`. On recent Android kernels, that fails for the tagged heap pointers (`0xb4...`) that Bionic hands out. So the very first `execve()` couldn't read its own path, and the check failed with:

```
execve(...): Function not implemented
```

or `Bad address`.

## Solution

Build PRoot for API 23, so it uses `process_vm_readv` ([#331](https://github.com/localdesktop/localdesktop.github.io/pull/331)). See `patches/build-proot-android/config`. To check a build:

```sh
adb shell run-as io.github.localdesktop sh -c '$(dirname $(pm path io.github.localdesktop | head -1 | cut -d: -f2))/lib/arm64/libproot.so -V'
```

If you still see "Device Unsupported" with a current version, the other usual reasons are the app installed on an SD card (adoptable storage), or a rooted ROM or kernel that blocks `ptrace`. If neither applies, please [open an issue](https://github.com/localdesktop/localdesktop.github.io/issues) with the PRoot error from the logcat.
