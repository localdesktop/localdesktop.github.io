# Notes for coding agents

Local Desktop is an Android app, written in Rust, that runs Arch Linux ARM in proot and shows its desktop through a Smithay Wayland compositor. The developer manual lives in `gh-pages/docs/developer/`.

## Layout

| Path | What |
|---|---|
| `src/android/` | The app: `main.rs` (`android_main`), compositor backend, proot, PipeWire/AAudio, accessibility keyboard (Java under `src/android/java/`) |
| `src/bin/` | `build_apk` (on-device builder), `build_docs` (PDF manuals), the PipeWire AAudio sink |
| `manifest.yaml` | Android manifest/config for xbuild. **The package name comes from here**; don't hard-code it |
| `patches/` | Vendored, patched xbuild, smithay, winit, proot and libxkbcommon builds |
| `gh-pages/` | Docusaurus website: `blog/`, `docs/user/`, `docs/developer/` |
| `vscode-extension/` | The "Local Desktop Dev" editor extension and the device tools described below |

## Build and run

- Build: `x build --platform android --arch arm64 --format apk` (debug) or add `--release`. `x` is the patched xbuild: `cargo install --path patches/xbuild/xbuild --force`.
- Debug APK: `target/x/debug/android/gradle/app/build/outputs/apk/debug/app-debug.apk`. Unstripped `.so` files for symbols: `target/x/debug/android/gradle/app/src/main/jniLibs/arm64-v8a/`.
- Only arm64 devices are supported.
- **Never uninstall the app to fix a signature mismatch without asking.** Uninstalling deletes the Arch Linux rootfs in the app's data.

## Device tools (MCP server and CLI)

The repository ships an MCP server with tools for the connected Android device. Claude Code reads `.mcp.json`, Cursor reads `.cursor/mcp.json`, and Codex needs `codex mcp add localdesktop -- node "$PWD/vscode-extension/bin/localdesktop-mcp.cjs"`. The same tools work from a shell: `node vscode-extension/bin/localdesktop.cjs <tool> --option value [--json]`. Both need either the Local Desktop Dev extension installed or `pnpm -C vscode-extension install && pnpm -C vscode-extension run build`.

| Tool | Use it to |
|---|---|
| `devices`, `select_device`, `connect_device`, `doctor` | See devices (USB, Wi‑Fi, emulator), choose one, connect over Wi‑Fi, check the toolchain |
| `build_apk`, `install_apk`, `app_start`, `app_stop`, `app_status` | Build, deploy, (re)start and inspect the app |
| `logcat` | Read the app's logs only (filtered by uid, so proot and PipeWire children are included). `since: "launch"` returns everything since the last start |
| `crash_report` | Native crashes (symbolicated), Java crashes, ANRs and Rust panics |
| `screenshot` | See the screen. Returns an image; the full PNG is saved in `.localdesktop/screenshots/` |
| `tap`, `swipe`, `mouse`, `type_text`, `press_key` | Interact. Coordinates default to the **last screenshot's** pixel space. `type_text` is ASCII only; chords like `ctrl+alt+t` need Android 13+ |
| `audio_status`, `audio_record` | Is PipeWire/AAudio running? Record N seconds (needs scrcpy) and get levels, silence, dropouts, clipping and the dominant frequency |
| `screen_record`, `shell`, `pull_file` | MP4 capture, `adb shell` (optionally `runAs` the app to read `files/arch/...`), copy files off the device |

Typical loop: `screenshot` → decide → `tap` / `type_text` / `press_key` → `screenshot` to confirm. For bugs: `app_start` (or `install_apk` first) → reproduce → `logcat since=launch level=W` → `crash_report`.

Log tags: `RustStdoutStderr` (stdout/stderr, panics, guest output), `localdesktop::…` (Rust `log` crate, module path truncated to 23 characters), `LocalDesktopA11y` (keyboard service). Debug builds log at Trace.

The device is chosen in this order: the tool's `serial`, then `$ANDROID_SERIAL`, then the device selected in the editor (`.localdesktop/state.json`), then the only connected device. Everything under `.localdesktop/` is local scratch and gitignored.

## Pull requests

PRs to `main` need exactly one `release:*` label (`breaking`, `feature`, `bugfix`, `patch`, `improvement`, `optimisation`, or `docs` for no release). PRs that only touch `gh-pages/`, `vscode-extension/`, `.vscode/` or the agent config files are exempt. See `gh-pages/docs/developer/1-how-to-build.md`.
