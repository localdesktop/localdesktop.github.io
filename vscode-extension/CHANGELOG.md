# Changelog

## 0.2.1

- Show your avatar on messages while they are sending.

## 0.2.0

- Anyone with the extension can read and post in the chat; no more chat keys.

## 0.1.3

- Wake the device before screenshots and starting the app.
- Fix screenshots on foldables.

## 0.1.2

- Chat setup no longer opens duplicate config pull requests.

## 0.1.1

- Fix chat encryption after key records were deleted.

## 0.1.0

First pre-release.

- **F5 debugging on Android**: build with xbuild, install, launch waiting for the debugger and attach LLDB through CodeLLDB (no android-debug extension, no CodeLLDB pin). Ctrl+F5 runs without debugging; an Attach configuration picks a running process.
- **Devices**: USB, Wi‑Fi (QR or code pairing, `adb tcpip`) and emulators; the selection is shared with agent tools. Logcat filtered by the app's uid, mirrored to `.localdesktop/logs/logcat.log`. Screenshots, scrcpy mirroring, environment check.
- **Agent tools**: MCP server and CLI with 23 tools (logs, crash reports, screenshot, tap/swipe/type/keys, audio status and recording with analysis, build/install/start). Offered to the editor's built-in agent; `.mcp.json` / `.cursor/mcp.json` for Claude Code and Cursor.
- **Releases & CI**: latest release and Play upload status, one-click signed CI builds with download/install, release labels with the predicted version, release notes editing, Play uploads, website deploys.
- **Website**: blog and docs trees, new post/doc/category wizards, live preview, publishing as a pull request via the Git Data API.
- **Realtime**: repository webhook → ntfy (or smee) doorbell with polling fallback.
- **Maintainer chat** on GitHub Discussions: public channels, and end-to-end encrypted private channels with automatic key sharing between maintainers' devices.
