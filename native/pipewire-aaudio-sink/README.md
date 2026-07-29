# PipeWire Standalone-Client AAudio Sink POC

This directory contains the native part of the standalone-client PipeWire/AAudio
proof of concept: run PipeWire as an Android-side service and expose its socket
to the guest, then bridge audio with a separate standalone PipeWire client
process that registers an AAudio-backed sink.

It is the simpler alternative to writing a Local Desktop PipeWire/SPA plugin or
PipeWire module.

```text
guest PipeWire clients
  -> exposed /tmp/pipewire-0 socket
  -> PipeWire daemon in Android app context
  -> standalone Local Desktop PipeWire client Audio/Sink
  -> Android AAudio output stream
```

The process connects to PipeWire like a normal client, registers a virtual
`Audio/Sink`, and writes incoming F32 interleaved audio into AAudio.

## Expected APK Artifacts

The `pipewire` branch currently includes prebuilt `arm64-v8a` PipeWire assets
generated from the Termux `pipewire` package. The PipeWire path is disabled at
runtime below Android API 30 because those Termux binaries reference Android
libc symbols that are not available on older releases.

The Rust supervisor in
`src/android/backend/pipewire_standalone_aaudio.rs` starts only when these files
exist in Android `nativeLibraryDir`:

- `libpipewire_exec.so`: a renamed Android/Termux-built `pipewire` executable.
- `liblocaldesktop_pipewire_aaudio_sink.so`: this POC sink executable.

Optional:

- `libwireplumber_exec.so`: a renamed Android/Termux-built `wireplumber`
  executable. If absent, the generated PipeWire config tries the built-in
  `libpipewire-module-session-manager` module with `nofail`.

The supervisor also points PipeWire at Android `nativeLibraryDir` for both:

- `PIPEWIRE_MODULE_DIR`
- `SPA_PLUGIN_DIR`

Keep the PipeWire modules and SPA plugins flat in `assets/libs/arm64-v8a`, for
example `libpipewire-module-protocol-native.so`, `libspa-support.so`, and
`libspa-audioconvert.so`. The current APK packagers extract top-level `.so`
files from that directory into `nativeLibraryDir`.

## Build Sketch

Set `ANDROID_NDK_HOME` and `PIPEWIRE_PREFIX` to an Android/Termux sysroot that
contains `libpipewire-0.3`, PipeWire headers, and SPA headers, then run:

```sh
./native/pipewire-aaudio-sink/build-android.sh
```

The default build API is 30 to match the currently bundled Termux PipeWire
binary. Override `API` only if the PipeWire sysroot you link against has a
different Android API floor.

The script writes:

```text
assets/libs/arm64-v8a/liblocaldesktop_pipewire_aaudio_sink.so
```

The filename uses `.so` because Android reliably extracts native libraries from
the APK. It is still an executable, following the existing `libproot.so`
packaging pattern.

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
