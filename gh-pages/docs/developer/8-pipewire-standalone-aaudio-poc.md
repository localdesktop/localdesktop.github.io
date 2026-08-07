# PipeWire Standalone-Client AAudio Sink POC

This branch adds a proof-of-concept backend for standalone-client
PipeWire/AAudio playback: run PipeWire on the Android side, expose its native
socket to the proot guest, and bridge playback with a separate standalone
PipeWire client that registers an AAudio-backed `Audio/Sink`.

It is intentionally not a PipeWire/SPA plugin or PipeWire module. The runtime is
a host-side PipeWire daemon plus a host-side AAudio sink client.

This is now the built-in Local Desktop audio path. The supervisor is disabled on
Android below API 30 and otherwise starts when the native artifacts are bundled
in the APK.

## Runtime Shape

```text
guest PipeWire client
  -> /tmp/pipewire-0
  -> host PipeWire daemon in Android app context
  -> localdesktop-aaudio-sink client
  -> AAudio
```

The socket path is intentionally under the proot-visible `/tmp`, matching the
Wayland strategy:

```text
host path:  /data/data/app.polarbear/files/arch/tmp/pipewire-0
guest path: /tmp/pipewire-0
```

The default guest launch now exports:

```sh
PIPEWIRE_RUNTIME_DIR=/tmp
XDG_RUNTIME_DIR=/tmp
```

## Android-Side Artifacts

The branch includes prebuilt `arm64-v8a` PipeWire assets generated from Termux's
`pipewire` package. `assets/libs/arm64-v8a/PIPEWIRE_ASSETS_MANIFEST.txt` records
the package source and generated files.

Place these in `assets/libs/arm64-v8a` before building the APK:

- `libpipewire_exec.so`: renamed `pipewire` executable.
- `liblocaldesktop_pipewire_aaudio_sink.so`: built from
  `src/bin/localdesktop_pipewire_aaudio_sink.rs`.
- PipeWire module `.so` files, for example
  `libpipewire-module-protocol-native.so`.
- SPA plugin `.so` files, for example `libspa-support.so` and
  `libspa-audioconvert.so`.

Keep the module and plugin files flat in `assets/libs/arm64-v8a`. The current
APK packagers extract top-level `.so` files from that directory into Android
`nativeLibraryDir`.

Optional:

- `libwireplumber_exec.so`: renamed `wireplumber` executable. Without it, the
  generated config tries `libpipewire-module-session-manager` with `nofail`.

The supervisor also points PipeWire at Android `nativeLibraryDir` through both
`PIPEWIRE_MODULE_DIR` and `SPA_PLUGIN_DIR`.

## Building the Sink

The sink is a normal Cargo binary, but it links `libpipewire-0.3`, so it sits
behind the `pipewire-sink` feature and is excluded from the default APK build.
Point `PIPEWIRE_PREFIX` at an Android/Termux sysroot that has `libpipewire-0.3`
plus the PipeWire and SPA headers, then run:

```sh
ANDROID_NDK_HOME=... PIPEWIRE_PREFIX=... ./scripts/build-pipewire-aaudio-sink.sh
```

The script cross-compiles for `aarch64-linux-android` (API 30 by default, to
match the bundled Termux PipeWire) and writes:

```text
assets/libs/arm64-v8a/liblocaldesktop_pipewire_aaudio_sink.so
```

The filename uses `.so` because Android reliably extracts native libraries from
the APK. It is still an executable, following the existing `libproot.so`
packaging pattern.

The ring buffer and argument parsing compile on any host, so they can be tested
without an Android sysroot:

```sh
cargo test --features pipewire-sink --bin localdesktop_pipewire_aaudio_sink
```

## Guest Smoke Test

Once the APK includes the PipeWire daemon, modules, SPA plugins, and sink:

```sh
export XDG_RUNTIME_DIR=/tmp
export PIPEWIRE_RUNTIME_DIR=/tmp
pw-cli info 0
pw-play /path/to/test.wav
```

If policy auto-linking is not active, inspect and link manually:

```sh
pw-link -o
pw-link -i
pw-link <playback-output-port> localdesktop-aaudio-sink:input_FL
pw-link <playback-output-port> localdesktop-aaudio-sink:input_FR
```

## Current Limits

- Playback only.
- F32 interleaved output only.
- Fixed default request of 48 kHz stereo.
- No Android audio focus handling yet.
- No capture/microphone path.
- Policy is experimental; use WirePlumber if available, otherwise manual
  `pw-link` may be needed.
- The POC starts PipeWire as Android app child processes. On Android 12+ test
  devices and AVDs, disable phantom-process trimming while testing:
  `adb shell settings put global settings_enable_monitor_phantom_procs false`
  and
  `adb shell device_config put activity_manager max_phantom_processes 2147483647`.
- The setup path writes a guest pacman `IgnorePkg` hold for the PipeWire package
  family (`libpipewire`, `pipewire`, `pipewire-audio`, `pipewire-alsa`,
  `pipewire-jack`, `pipewire-pulse`, `pipewire-v4l2`, `pipewire-zeroconf`,
  `gst-plugin-pipewire`, and `wireplumber`). This holds an installed compatible
  guest PipeWire version; it does not downgrade an already newer guest install.

This is meant to prove the architecture and timing path, not to become the final
audio backend as-is.
