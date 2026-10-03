# Local Desktop Fold — Galaxy Z Fold 8 fork

This fork of [Local Desktop](https://github.com/localdesktop/localdesktop.github.io) is tuned for the Samsung Galaxy Z Fold 8 / Fold 8 Ultra (Snapdragon 8 Elite Gen 5, Adreno 840, Android 17 / One UI 9). It also runs on any arm64 Android 5+ device.

It installs as **`app.polarbear.fold`** ("Local Desktop Fold"), next to upstream `app.polarbear`. Each app has its own Linux root filesystem, so upstream stays usable while you test this build.

## What is different from upstream

| Area | Change |
|---|---|
| Fold / unfold | The desktop resizes live when you fold, unfold, rotate or change density. The guest gets the new mode, refresh rate and a fractional UI scale through a FIFO, not a 1-second polling loop. |
| Cover screen | Same path as above. The UI scale follows the cover screen's density automatically (`[display] ui_scale = 0`). |
| Laptop (Flex) mode | When half-folded in landscape, the hinge sensor splits the screen: desktop on top, touchpad with click zones on the bottom. |
| DeX / external display | The activity is resizeable and handles every configuration change without restarting. DeX meta-data sits on the activity, plus Samsung keep-alive flags. Mouse button releases and the wheel are fixed. Optional pointer capture gives games and Wine relative motion. |
| Background | A foreground service keeps the session alive. Its notification has a **Stop** action that ends the session. |
| Rendering | Damage-driven redraw instead of a busy loop. Frame callbacks are paced to presentation. The real panel refresh (up to 120 Hz) is requested. `render_scale` lowers guest pixels for speed. |
| Keyboard | The accessibility key filter only captures keys while the desktop window is focused. Upstream also captured keys typed into other apps in split screen and DeX. |
| Telemetry | Sentry is removed. Crash reports, exit reasons and session logs stay on the phone (see below). |
| Security | Rootfs pinned by SHA-256 with bounded retries. HTTPS pacman mirrors and a fresh pacman key per install. Tokenised installer WebSocket. Vendored Vue with a CSP. Cleartext only to loopback. `allowBackup=false`. The on-device builder signs with a per-machine key instead of a committed one. CI is hardened. |
| GPU (opt-in) | Mesa with the KGSL backend (Freedreno GL or Zink on Turnip) in `/opt/localdesktop-mesa`, plus `linux-dmabuf` in the compositor. Off by default. |
| x86 / Windows (opt-in) | Box64 (archlinuxcn package) with GameNative-derived presets, and x86_64 Wine (WoW64) running under Box64. Every download is pinned by SHA-256. |

## Settings

Edit `/etc/localdesktop/localdesktop.toml` inside the desktop: use the **Local Desktop Settings** launcher, which opens it in Mousepad. Settings are read when the app starts, so restart the app after editing. Missing keys use these defaults:

```toml
[display]
render_scale = 1.0      # 0.5..1.0: fraction of physical pixels the guest renders. 0.75 is ~44% fewer pixels.
ui_scale = 0.0          # 0 = follow Android density (cover vs inner screen). Fractional values like 2.5 work.
laptop_mode = "auto"    # auto | on | off. auto = split only while the hinge reports half-open in landscape.
refresh_rate = 0        # Hz hint; 0 = highest the display offers.
keep_screen_on = true

[input]
touch_mode = "direct"   # direct (pointer jumps to finger, upstream) | touchpad (whole screen is a touchpad)
pointer_capture = false # true: capture a physical mouse for relative motion (games, Wine). Ctrl+Alt toggles it.
key_repeat_delay_ms = 400
key_repeat_rate = 30

[gpu]
enabled = false         # experimental Adreno acceleration
driver = "freedreno"    # freedreno | zink

[x86]
box64 = false           # install Box64 for x86_64 Linux programs
wine = false            # install x86_64 Wine under Box64 (implies box64)

[session]
foreground_service = true
```

Per-session environment overrides go in `/etc/localdesktop/session-env.local`. `session-env.sh` is regenerated on every start, so edits there are lost.

### Touchpad gestures (laptop-mode panel and `touch_mode = "touchpad"`)

- One finger moves the pointer.
- Tap = left click; two-finger tap = right click.
- Two-finger drag scrolls; tap-and-drag drags.
- In the laptop-mode panel, the click zones along the bottom edge act as left and right buttons.

### Guest commands

| Command | Purpose |
|---|---|
| `localdesktop-update` | `pacman -Syu`, respecting `IgnorePkg`. Upstream never updated the system after first install. |
| `localdesktop-gpu-probe` | With `[gpu] enabled`: checks `/dev/kgsl-3d0` and `/dev/dma_heap/system`, then runs `vulkaninfo`/EGL probes. Writes `/var/log/localdesktop/gpu-probe.txt`. |
| `box64`, `x64`, `box64-preset <preset> <prog>` | Run x86_64 Linux programs. Presets: stability, compatibility (default), intermediate, performance, denuvo, unity. |
| `wine`, `winecfg`, `wineserver` | x86_64 Wine through Box64. `WINEESYNC`/`WINEFSYNC` are off because proot cannot provide them. |

## Crash reports and logs (local only)

| Where | Path |
|---|---|
| Inside the desktop | `/var/log/localdesktop/` |
| Over adb | `adb pull /sdcard/Android/data/app.polarbear.fold/files/crash-reports/` |
| App-private | `/data/data/app.polarbear.fold/files/crash-reports/` |

The files are:
- `crash-<UTC>.txt`: panic message, backtrace, device info, `/proc/self/maps`, last log lines.
- `exit-reasons.txt`: Android `ApplicationExitInfo`, e.g. LMK, phantom-process kills, Android 17 `MemoryLimiter`.
- `session.log` and `previous-session.log`.

## Build

Use the macOS/Linux cross build (`make build`), or `cargo run` on the device in Termux; see the README. A release build without the CI keystore is signed with your local key. It cannot update an APK signed with another key: uninstall first, or keep the different application id.

## Things that could only be checked on a phone

None of the following has run on a Z Fold 8. Please check them in this order and send the crash-report folder if something fails.

1. **First run**
   - The installer page renders (CSP + vendored Vue).
   - The rootfs download verifies its SHA-256.
   - `pacman` installs over HTTPS mirrors.
   - The desktop appears.
2. **Fold/unfold and rotate mid-session**
   - The desktop resizes without restarting.
   - No black or clipped frame remains.
   - The cover screen gets a smaller UI scale.
3. **Idle cost**
   - `adb shell dumpsys SurfaceFlinger --latency` shows no buffer posts while nothing changes.
   - `adb shell top -p $(pidof app.polarbear.fold)` shows near-zero CPU.
4. **120 Hz**: `adb shell dumpsys SurfaceFlinger | grep -i "refresh"` while scrolling.
5. **Background**
   - Switch apps for 10 minutes and return: the session is still alive and the notification is visible.
   - The **Stop** action ends it.
6. **DeX / external monitor**
   - The window resizes.
   - Right and middle click release correctly.
   - The mouse wheel scrolls.
   - Typing into another DeX window is not captured by Linux.
7. **Laptop mode** (Fold 8 Ultra has Flex mode)
   - Half-fold in landscape: the screen splits and the bottom touchpad works.
   - If it never splits, the hinge sensor is not exposed to apps. Set `laptop_mode = "on"` to force the split in landscape.
8. **Pointer capture** (`pointer_capture = true`)
   - Relative motion works in a game or in `wine`.
   - Ctrl+Alt releases it.
9. **GPU** (`[gpu] enabled = true`)
   - Run `localdesktop-gpu-probe` and read the report.
   - If KGSL or dma-heap is blocked for apps on One UI 9, turn it back off.
10. **x86** (`[x86] box64 = true`, then `wine = true`)
    - `box64 --version`.
    - `wine winecfg`.
11. **Page size**: `adb shell getconf PAGE_SIZE`. If it prints 16384, report it. The bundled `libproot.so` is 4 KB-aligned and relies on the kernel's compatibility mode.

### Known limits

- Phantom-process killer:
  - Android kills child processes past 32 per app unless *Developer options → Disable child process restrictions* is on (if One UI 9 still offers it).
  - A full Xfce session exceeds 32.
  - The foreground service helps with background kills but does not lift this limit.
- The prebuilt PipeWire AAudio sink in `assets/libs` predates the power-saving and idle-stop changes. They take effect only after `scripts/build-pipewire-aaudio-sink.sh` is rerun with an Android PipeWire sysroot.
- `targetSdk` stays at 35:
  - xbuild with NDK r28 cannot target 36+.
  - Targeting 37 would block LAN access for the guest until `ACCESS_LOCAL_NETWORK` is granted.
- The GPU path depends on Adreno KGSL access from an untrusted app under proot, and on dma-buf import into the Adreno vendor EGL. Both are unverified on One UI 9.
