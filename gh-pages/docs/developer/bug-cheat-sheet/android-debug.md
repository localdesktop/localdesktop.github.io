---
title: "Debugger can't find lldb-server (Cannot determine ndk root)"
---

## Issue

When you press <kbd>F5</kbd> for the first time, the debug session stops with:

```
No arm64 lldb-server found in any Android NDK.
```

Older setups that used the third-party **Android Debug** extension showed a similar error, `Error updating android paths: Cannot determine ndk root`. That extension is no longer needed: the Local Desktop Dev extension handles building, installing and attaching by itself (see [How to develop locally?](/docs/developer/how-to-dev)). You can uninstall Android Debug.

## Solution

Breakpoints need `lldb-server` from an Android NDK, which runs on the phone. Do one of the following:

1. Install an NDK: Android Studio > **Settings** > **Languages & Frameworks** > **Android SDK** > **SDK Tools** > **NDK (Side by side)**, or run `sdkmanager "ndk;27.0.12077973"`. The extension finds NDKs in `$ANDROID_HOME/ndk/` and through `ANDROID_NDK_HOME`.
2. Or point the `localdesktop.lldbServerPath` setting at an existing arm64 `lldb-server`, for example `<ndk>/toolchains/llvm/prebuilt/<host>/lib/clang/<version>/lib/linux/aarch64/lldb-server`.

Run **Local Desktop: Check Environment** afterwards to confirm that lldb-server is found. If you don't need breakpoints, <kbd>Ctrl</kbd> + <kbd>F5</kbd> runs the app without the debugger.
