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
  `native/pipewire-aaudio-sink`.
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
