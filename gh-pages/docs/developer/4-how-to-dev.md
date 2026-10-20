---
title: How to develop locally?
---

Recommended setup:

- **IDE**: Visual Studio Code (Cursor and VSCodium work too)

- **Extensions**:

  - [Rust Analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
  - **Local Desktop Dev**, the project's own extension. Its source lives in [`vscode-extension/`](https://github.com/localdesktop/localdesktop.github.io/tree/main/vscode-extension). Install it from [Open VSX](https://open-vsx.org/extension/mister-teddy/localdesktop-dev) (in VS Code, download the `.vsix` and use Install from VSIX), or run it from source: open the `vscode-extension/` folder and press F5 (see [Maintainer tools](maintainer-tools.md#working-on-the-extension)).
  - [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) 1.11.4 or newer, which Local Desktop Dev uses for breakpoints.

Run **Local Desktop: Check Environment** from the Command Palette once. It checks adb, the Android SDK, Gradle, Java, the patched xbuild, the Rust target, lldb-server and scrcpy, and tells you how to fix anything that's missing.

### How to debug

1. Connect a phone with USB debugging enabled, or pair one over Wi‑Fi (see below). The device shows up in the **Local Desktop** sidebar under **Devices**, and in the status bar. Click either to choose a device when several are connected.
2. Press <kbd>F5</kbd> (or launch `Local Desktop: Debug on Android` from the Run and Debug panel). This will:
   - Build the debug APK with xbuild. Compile errors land in the Problems view.
   - Install it on the selected device (skipped when the APK hasn't changed).
   - Launch the app waiting for the debugger, attach LLDB inside the app's sandbox, then let the app continue.
   - Mirror the app's stdout/stderr, warnings and errors into the Debug Console.
3. Set breakpoints anywhere in the Rust code, even in `android_main` in `src/android/main.rs`: they bind as soon as `liblocaldesktop.so` is loaded.

If the session stops with "No arm64 lldb-server found", see [Debugger can't find lldb-server](/docs/developer/bug-cheat-sheet/android-debug).

![Debugging Capability](/img/debugging-capability.webp)

Other ways to run:

- <kbd>Ctrl</kbd> + <kbd>F5</kbd> builds, installs and starts the app without the debugger. Stopping the session stops the app.
- `Local Desktop: Attach to Running App` attaches to a process that's already running: the app itself, or one of its children such as proot or PipeWire.
- In `.vscode/launch.json` you can set `"device": "pick"` to always choose a device, `"build": false` to reuse the last APK, `"stopOnEntry": true`, or `"lldbServerLog": true` to troubleshoot the debugger.

> **Tip**: You can debug the app on a physical device or on an arm64 emulator. Emulators that translate arm64 code on an x86_64 image can only run the app, not debug it.

### Wireless debugging

Android 11 and newer can be debugged over Wi‑Fi, with the phone and computer on the same network:

- **Pair Device over Wi‑Fi (QR Code)**: on the phone, open **Developer options** > **Wireless debugging** > **Pair device with QR code** and scan the code the extension shows.
- **Pair Device over Wi‑Fi (Pairing Code)**: enter the IP address, port and six-digit code from **Pair device with pairing code**.
- **Connect to Device over Wi‑Fi**: reconnect to a phone you've paired before.
- **Switch USB Device to Wi‑Fi**: the classic `adb tcpip 5555` switch for older phones; plug in once, then unplug.

### How to view the logs

The **Local Desktop Logcat** output panel streams everything the app's process logs: Rust stdout/stderr (including panics), `log::` messages, and the proot and PipeWire child processes. Open it with **Local Desktop: Show Logcat**, or from the Devices view. **Local Desktop: Filter Logcat** narrows it by level or regex.

If Local Desktop hangs at launch, stuck on the app icon, the native main thread has likely crashed. The panic shows up in the logcat:

```
05-24 18:10:04.181 13540 13556 I RustStdoutStderr: thread '<unnamed>' panicked at src/utils/logging.rs:17:14:
05-24 18:10:04.181 13540 13556 I RustStdoutStderr:
05-24 18:10:04.181 13540 13556 I RustStdoutStderr: *** *** *** [POLAR BEAR EXPECTATION] *** *** ***
05-24 18:10:04.181 13540 13556 I RustStdoutStderr: Failed to create EGLContext
05-24 18:10:04.181 13540 13556 I RustStdoutStderr: *** *** *** [POLAR BEAR EXPECTATION] *** *** ***
```

Every line is also saved to `.localdesktop/logs/logcat.log` in the repository, which is handy for sharing logs or for coding agents to read.

Without the extension, run the `[Android] Logcat` task, or follow [How to logcat](/docs/developer/how-to-logcat).
