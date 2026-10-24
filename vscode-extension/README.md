# Local Desktop Dev

Maintainer tooling for [Local Desktop](https://localdesktop.github.io), the Android app that runs a full Linux desktop. Open the [repository](https://github.com/localdesktop/localdesktop.github.io) in VS Code (or Cursor, VSCodium, …) and you get:

- **F5 debugging on Android.** Builds the APK with the patched xbuild, installs it on the selected phone (USB or Wi‑Fi), launches it waiting for the debugger, and attaches LLDB through [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb). Breakpoints in Rust work from `android_main` onwards.
- **Devices view.** USB, Wi‑Fi (QR or code pairing) and emulators; the selected device is shared with the agent tools.
- **Logcat that actually shows the app.** Filtered by the app's uid, so it includes proot and PipeWire child processes. Also written to `.localdesktop/logs/logcat.log`.
- **Agent tools (MCP + CLI).** Coding agents can read logs and crash reports, take screenshots, tap, swipe and type on the device, and record and analyse audio. See [AGENTS.md](https://github.com/localdesktop/localdesktop.github.io/blob/main/AGENTS.md).
- **Releases & CI.** Release status, one-click signed APK builds on GitHub Actions, release labels and notes, and Google Play uploads.
- **Website.** Blog and docs trees, new-post wizard, live preview, and publishing as a pull request.
- **Maintainer chat.** Channels backed by GitHub Discussions; private channels are encrypted on GitHub and readable with the extension, with realtime updates.

## Requirements

- The Local Desktop repository open as a workspace folder.
- Android platform-tools (`adb`), the Android SDK, Gradle 8, JDK 17 and the patched xbuild (`Local Desktop: Install Patched xbuild`). Run **Local Desktop: Check Environment** to see what's missing.
- [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) 1.11.4 or newer for breakpoints.
- Optional: [scrcpy](https://github.com/Genymobile/scrcpy) for screen mirroring and audio capture.

## License

GPL-3.0, like Local Desktop itself.
