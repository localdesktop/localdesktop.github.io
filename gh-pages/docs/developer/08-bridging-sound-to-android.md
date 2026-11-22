---
title: Bridging sound to Android
description: How Local Desktop plays Linux sound on Android, by running PipeWire on the Android side and bridging it to AAudio with a standalone sink client.
---

Sound in Local Desktop works by running **PipeWire on the Android side**, as child processes of the app, and sharing its socket with the guest through `/tmp`, the same way we share the Wayland socket. A small standalone PipeWire client, the **AAudio sink**, plays everything it receives through Android's AAudio API.

It started as a proof of concept, and shipped as the built-in audio path in [#306](https://github.com/localdesktop/localdesktop.github.io/pull/306).

## Why not run PipeWire in the guest?

PipeWire in the guest would need a way to reach Android's audio hardware, and there isn't one: ALSA devices don't exist for apps, and AAudio is an Android library, which a glibc program in PRoot can't load. So the PipeWire daemon runs on the Android side, built against Android's libc (from Termux's packages), where it can use AAudio. The guest only needs the PipeWire client libraries, which talk to the daemon over a Unix socket.

It is intentionally not a PipeWire/SPA plugin or module. The sink is a separate client process, which keeps the Android-specific code in one small Rust binary.

## Runtime shape

```text
guest app (PipeWire, PulseAudio or ALSA client)
  -> /tmp/pipewire-0 or /tmp/pulse/native
  -> PipeWire daemon (+ WirePlumber, pipewire-pulse) in the Android app's context
  -> localdesktop-aaudio-sink client
  -> AAudio
```

The sockets are under the guest's `/tmp`, matching the Wayland socket:

```text
host path:  <arch fs root>/tmp/pipewire-0     (for example /data/data/io.github.localdesktop/files/arch/tmp/pipewire-0)
guest path: /tmp/pipewire-0
```

The Arch filesystem root is different for secondary Android users and Private Space (see `src/core/config.rs`), so don't hard-code the host path.

The default Launch command, and `startxfce4-localdesktop`, export:

```sh
PIPEWIRE_RUNTIME_DIR=/tmp
PULSE_SERVER=unix:/tmp/pulse/native
XDG_RUNTIME_DIR=/tmp
```

`src/android/backend/pipewire_standalone_aaudio.rs` starts the daemon, WirePlumber, `pipewire-pulse` and the sink once the compositor is ready, and watches them. If one of them exits, it stops the others and removes the socket, and the logcat says which one exited and why. Sound then stays off until the app restarts. Their logs go to the logcat with a `[PipeWireAAudio]` prefix. It only runs on Android 11 (API 30) and newer, because Termux's PipeWire uses libc symbols such as `memfd_create` that older Android versions don't have.

## Android-side artifacts

Everything is prebuilt for `arm64-v8a` from Termux's packages (PipeWire 1.4.9, WirePlumber 0.5.13). `assets/libs/arm64-v8a/PIPEWIRE_ASSETS_MANIFEST.txt` records the package versions and every generated file.

| File | What |
|---|---|
| `libpipewire_exec.so` | The `pipewire` executable, renamed |
| `libpipewire_pulse_exec.so` | `pipewire-pulse`, for PulseAudio clients |
| `libwireplumber_exec.so` | The `wireplumber` session manager, plus its module `.so` files |
| `assets/wireplumber-share.tar` | WirePlumber's scripts and config |
| `liblocaldesktop_pipewire_aaudio_sink.so` | The sink, built from `src/bin/localdesktop_pipewire_aaudio_sink.rs` |
| `libpipewire-module-*.so`, `libspa-*.so` | PipeWire modules and SPA plugins |

Executables are named `lib*.so` because Android only extracts native libraries from the APK, the same trick as `libproot.so`. Keep the modules and plugins flat in `assets/libs/arm64-v8a`: the packagers extract top-level `.so` files into Android's `nativeLibraryDir`, and the supervisor points `PIPEWIRE_MODULE_DIR` and `SPA_PLUGIN_DIR` there.

## Keeping both sides in sync

The guest's PipeWire client libraries talk to the Android-side daemon over PipeWire's native protocol, which stays compatible across versions: a 1.6 client in the guest works with the 1.4 daemon we ship. So the guest's PipeWire packages are upgraded with the rest of the system.

Older versions held them back with `IgnorePkg`. That turned every `pacman -Syu` into a partial upgrade, which broke as soon as Arch updated a library they depend on (`libwireplumber`, `spandsp`). The setup now removes that hold on every start.

When you update the Android-side PipeWire, test it with the guest's current packages too.

## Building the sink

The sink is a normal Cargo binary, but it links `libpipewire-0.3`, so it sits behind the `pipewire-sink` feature and is left out of the default APK build. Point `PIPEWIRE_PREFIX` at an Android/Termux sysroot that has `libpipewire-0.3` and the PipeWire and SPA headers, then run:

```sh
ANDROID_NDK_HOME=... PIPEWIRE_PREFIX=... ./scripts/build-pipewire-aaudio-sink.sh
```

The script cross-compiles for `aarch64-linux-android` (API 30 by default, to match the bundled Termux PipeWire) and writes `assets/libs/arm64-v8a/liblocaldesktop_pipewire_aaudio_sink.so`.

The ring buffer and argument parsing compile on any host, so they can be tested without an Android sysroot:

```sh
cargo test --features pipewire-sink --bin localdesktop_pipewire_aaudio_sink
```

## Testing in the guest

In the Local Desktop terminal:

```sh
export XDG_RUNTIME_DIR=/tmp PIPEWIRE_RUNTIME_DIR=/tmp
pw-cli info 0
pw-play /usr/share/sounds/freedesktop/stereo/bell.oga
```

WirePlumber links new streams to the sink by itself. If it doesn't, inspect and link by hand:

```sh
pw-link -o
pw-link -i
pw-link <playback-output-port> localdesktop-aaudio-sink:input_FL
pw-link <playback-output-port> localdesktop-aaudio-sink:input_FR
```

From your computer, `node vscode-extension/bin/localdesktop.cjs audio_status` shows which processes are running and what AAudio is doing, and `audio_record --seconds 5` records the phone's output and checks it for silence, dropouts and clipping. See [Using the maintainer tools](/docs/developer/using-the-maintainer-tools).

## Current limits

- Playback only. There is no microphone yet (the app doesn't ask for `RECORD_AUDIO`).
- F32 interleaved output, 48 kHz stereo.
- No Android audio focus handling yet, so Linux sound mixes with other apps.
- Sound stops when the app goes to the background, unless the desktop is on an external display.
- The daemons are child processes of the app, so they count towards Android 12's phantom process limit. See [the user guide](/docs/user/getting-started#read-this-if-you-use-android-12-or-newer).
