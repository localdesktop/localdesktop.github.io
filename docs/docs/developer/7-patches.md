---
title: The folder `patches`
---

There is a `patches` folder at the root of the repository. If you check it out, it contains source code of other libraries/dependencies that Local Desktop uses.

Local Desktop is built on top of niche, cutting-edge technologies. We frequently face situations where we have to make updates to the code of our libraries/components. Here is our approach: we temporarily clone the component/library and make changes to them. That allows us to move forward without blocking and experiment with features until they are stable enough so that we can create a pull request upstream.

What have we patched so far?

## xbuild
- [Support `use_cleartext_traffic` in `AndroidManifest.xml`](https://github.com/localdesktop/localdesktop/commit/a24091b1bb90ac16e680dcdb142db89a5ab86d88#diff-b65b875cc3637c77b2ef2e894f105babcf46a2fda6c065ba1a306fecd143cefc). During the setup phase, Local Desktop shows the documentation website in a webview, and it reports setup progress via WebSocket. Without this option, the WebSocket won't work.
- [Support `extract_native_libs` in `AndroidManifest.xml`](https://github.com/localdesktop/localdesktop/commit/5f1400b2d4feff70ca47ebc9259113ecb71d6d57). Local Desktop invokes proot binary, which is placed in the native libs folder. In traditional Android applications, these libraries are intended to be loaded, not to be directly executed, thus they can either be put inside the APK, or extracted to the FS. In Local Desktop, we need the extracted native libraries so that we can invoke them directly.
- [Patch `gradle` build process](https://github.com/localdesktop/localdesktop/blob/main/patches/xbuild/xbuild/src/gradle/mod.rs):
  + Pick up `assets` when building with gradle.
  + Support signing if a `release-key.jks` is provided.

## smithay

- Load `libEGL.so` instead of `libEGL.so.1`.
- Create a dummy 1x1 pbuffer surface and use it as both the draw and read surface when calling `eglMakeCurrent` to avoid the `EGL_BAD_MATCH` error. More details [here](/docs/developer/bug-cheat-sheet/egl-context#egl_bad_match).

The content of the patched code can be found [here](https://github.com/localdesktop/localdesktop/commit/58ffc6fc37da2d799db0d68b8549abe57fa2e636).

## build-proot-android & build-libxkbcommon

The patched code and configurations are intended to make cross-compilation work, since these repositories were originally created to build binaries for the host architecture. **Local Desktop does not intend to merge these changes back upstream, as the original repositories are not designed for cross-compilation**.
