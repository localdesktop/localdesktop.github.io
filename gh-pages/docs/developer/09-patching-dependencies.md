---
title: Patching dependencies
description: Which upstream projects Local Desktop patches (xbuild, Smithay, winit, PRoot, libxkbcommon, Mesa), what each patch does, and why.
---

There is a `patches` folder at the root of the repository. If you check it out, it contains source code of other libraries/dependencies that Local Desktop uses.

Local Desktop is built on top of niche, cutting-edge technologies. We frequently face situations where we have to make updates to the code of our libraries/components. Here is our approach: we temporarily clone the component/library and make changes to them. That allows us to move forward without blocking and experiment with features until they are stable enough so that we can create a pull request upstream.

What have we patched so far?

## xbuild
- [Support `use_cleartext_traffic` in `AndroidManifest.xml`](https://github.com/localdesktop/localdesktop.github.io/commit/a24091b1bb90ac16e680dcdb142db89a5ab86d88#diff-b65b875cc3637c77b2ef2e894f105babcf46a2fda6c065ba1a306fecd143cefc). During the setup phase, Local Desktop shows the documentation website in a webview, and it reports setup progress via WebSocket. Without this option, the WebSocket won't work.
- [Support `extract_native_libs` in `AndroidManifest.xml`](https://github.com/localdesktop/localdesktop.github.io/commit/5f1400b2d4feff70ca47ebc9259113ecb71d6d57). Local Desktop invokes proot binary, which is placed in the native libs folder. In traditional Android applications, these libraries are intended to be loaded, not to be directly executed, thus they can either be put inside the APK, or extracted to the FS. In Local Desktop, we need the extracted native libraries so that we can invoke them directly.
- [Patch `gradle` build process](https://github.com/localdesktop/localdesktop.github.io/blob/main/patches/xbuild/xbuild/src/gradle/mod.rs):
  + Pick up `assets` when building with gradle.
  + Support signing if a `release-key.jks` is provided.
  + Compile Java (and Kotlin) sources, Android resources (`res/`) and ProGuard rules, so the app can have a few [Java classes](/docs/developer/reading-the-code#androidjava).
  + Declare services, activities with intent filters, `meta-data` and a separate `process` in `manifest.yaml`. The settings page and the keyboard service need these.
  + Pin the Android Gradle Plugin and Kotlin plugin versions, so builds don't break when a new one comes out.
- Support building on an Android host (Termux), with an `aapt2` override, and NDK r28 for 16 KB page alignment.

The full history is in `git log -- patches/xbuild`.

## smithay

- Load `libEGL.so` instead of `libEGL.so.1`.
- Create a dummy 1x1 pbuffer surface and use it as both the draw and read surface when calling `eglMakeCurrent` to avoid the `EGL_BAD_MATCH` error. More details [here](/docs/developer/bug-cheat-sheet/egl-context#egl_bad_match).
- When a driver rejects the EGL 1.5 context attributes with `EGL_BAD_ATTRIBUTE`, retry with the older `EGL_CONTEXT_CLIENT_VERSION`. This fixed a crash when Android relaunches the app on some devices ([#208](https://github.com/localdesktop/localdesktop.github.io/pull/208)).

The first version of the patched code can be found [here](https://github.com/localdesktop/localdesktop.github.io/commit/58ffc6fc37da2d799db0d68b8549abe57fa2e636).

## winit

[winit](https://github.com/rust-windowing/winit) gives us the Android window and its input events. Our patches:

- Report mouse and touchpad pointer events, not only touches, so a real mouse works.
- Run on Android versions before 13.
- Expose `physical_key()` and make the key code module public, so keys from the [accessibility service](/docs/user/using-a-physical-keyboard) and the trackpad's keyboard can be mapped like real key presses ([#343](https://github.com/localdesktop/localdesktop.github.io/pull/343)).

Both Smithay and winit are wired in with `[patch.crates-io]` in `Cargo.toml`.

## build-proot-android & build-libxkbcommon

The patched code and configurations are intended to make cross-compilation work, since these repositories were originally created to build binaries for the host architecture. **Local Desktop does not intend to merge these changes back upstream, as the original repositories are not designed for cross-compilation**.

PRoot itself is vendored from [termux/proot](https://github.com/termux/proot) (commit `ab2e346`), with a few changes on top. The full list is in `patches/build-proot-android/README.md`:

- **Speed.** Its seccomp filter only stops the guest for the few `ioctl` requests PRoot rewrites (terminal settings and `FICLONE`). It used to stop on every `ioctl`, which is how GPU drivers talk to the kernel, several times per frame.
- **Built for API 23**, so PRoot reads the guest's memory with `process_vm_readv` instead of a fallback that doesn't work on every kernel. This fixed "Device Unsupported" on some phones ([#331](https://github.com/localdesktop/localdesktop.github.io/pull/331)).
- **`chmod` on the app's own files** bound into the guest is let through, so a script written there can be made executable ([#347](https://github.com/localdesktop/localdesktop.github.io/pull/347)).
- **`fstat` on sockets** gets the real answer. Node checks its standard streams with `fstat`, and a child process gets sockets for them, so every Node or Electron child process used to abort at startup ([#353](https://github.com/localdesktop/localdesktop.github.io/pull/353)).
- **Meta files for paths with a trailing slash.** `--root-id` keeps fake owners and modes in `.proot-meta-file.*` files. For `dir/`, it used to write one inside the directory instead of next to it, where nothing removed it. And when a directory holds nothing but meta files, they are removed with it, since `-H` hides them from the program that empties the directory.

## build-mesa

A Docker build of [Mesa](https://mesa3d.org) for the Arch Linux ARM guest, producing `assets/guest-mesa.tar.xz` (run `patches/build-mesa/build.sh`, which needs Docker with `linux/arm64`). It enables the KGSL backend for Turnip, which Arch Linux ARM's Mesa leaves out, and carries one patch: Zink can present through kopper on Wayland compositors that offer no DRM render node, which is how labwc runs under proot. See [Understanding the architecture](/docs/developer/understanding-the-architecture#gpu-acceleration-in-the-guest).
