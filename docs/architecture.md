<!--
  This is the SPINE of the generated architecture PDF (see src/bin/build_docs/).
  The prose is curated; the code is not. Each snippet directive (the HTML-comment
  lines beginning with "snippet", expanded by build_docs) is replaced at build
  time with the named function pulled fresh from source, so the walkthrough can
  never drift out of sync with the code it describes.

  The order is deliberate: the program is flattened along its call stack rather
  than scanned file-by-file. We start at the one entry point the OS calls,
  android_main, follow the fork into the two backends, then cross over to the two
  ways the APK that contains all of this gets built.
-->

# `android_main` — the one entry point

Local Desktop is an Android [`NativeActivity`](https://developer.android.com/ndk/reference/group/native-activity): there is no Java `main`, no `onCreate` we write. The NDK glue calls a single exported symbol, `android_main`, on a dedicated thread, and everything in this document hangs off that call.

`android_main` does four things in order: wire up logging and crash reporting, capture the Android handles we need later, build the winit event loop, and hand control to it. The last two lines are the whole program in miniature — **Phase 1: Setup** decides *what* we are (installer or desktop), **Phase 2: Run** drives it forever.

<!--snippet file=src/android/main.rs fn=android_main-->

`PolarBearApp::build` is where the fork is decided. It calls `setup`, which returns a *backend* — and the backend it returns is the entire branch this run will take.

<!--snippet file=src/android/app/build.rs fn=build-->

The two backends are the two halves of this chapter. There is no third option: a run is either still *installing the Linux environment* (WebView) or *running the desktop* (Wayland).

<!--snippet file=src/android/app/build.rs enum=PolarBearBackend-->

`setup` is the dispatcher. It first rejects unsupported devices outright, then runs the install pipeline. The crucial design choice is that `setup` **never blocks**: each stage reports whether its work was already done on a previous launch. If every stage was already done, the device is ready and we return the `Wayland` backend immediately. If any stage still has work to do, that work is spawned onto a background thread and we return the `WebView` backend so the main thread is free to render install progress.

<!--snippet file=src/android/proot/setup.rs fn=setup-->

Once a backend exists, Phase 2 takes over. winit calls `resumed` every time the activity becomes visible, and this is the runtime fork that mirrors the setup fork: the WebView backend shows an HTML progress page; the Wayland backend brings up the GPU renderer and launches the desktop.

<!--snippet file=src/android/app/run.rs fn=resumed-->

## The WebView path — first-run installer

This path runs once in a device's life: the first time the app opens, before the Linux environment exists. Almost all of the *work* lives here — downloading a root filesystem, unpacking it, running `pacman`, and writing dozens of config files — but none of it is the product. It exists only to get the device to the point where the Wayland path can take over.

The user sees a local HTML page (`setup-progress.html`) in an Android WebView. The `resumed` arm above points that WebView at the page and passes it a port; the page opens a WebSocket back to the app to receive live progress.

`setup` builds an ordered list of stages and walks it. Each stage is idempotent and returns `None` if its work was already done, or a `JoinHandle` if it spawned work. The orchestration loop runs the first unfinished stage, then chains the rest on a background thread, pushing a percentage to the progress channel as it goes — which is why the main thread stayed free to draw the page.

The stages, in order:

1. `setup_arch_fs` — download and extract the Arch Linux ARM64 root filesystem.
2. `simulate_linux_sysdata_stage` — fabricate the `/proc` and `/sys` files proot can't provide.
3. `install_dependencies` — `pacman -S` the desktop, retrying through a flaky network.
4. `setup_firefox_config` — pre-seed Firefox prefs so it runs unsandboxed under proot.
5. `setup_fake_bwrap` — replace Bubblewrap with a shim (Android has no user namespaces).
6. `setup_onboard_signal_fix` — wrap the on-screen keyboard around a proot `fstat` quirk.
7. `setup_xfce_wayland` — write the Xfce/labwc session config and HiDPI scaling.
8. `fix_xkb_symlink` — repoint an absolute xkb symlink to a relative one (it's resolved from NDK, not the chroot root).

The first stage is the heaviest and the most illustrative — note that it is one big retry loop: a corrupt download deletes the archive and starts over rather than failing the install.

<!--snippet file=src/android/proot/setup.rs fn=setup_arch_fs-->

Installing the desktop is the other stage worth reading. `pacman` over a phone's network is unreliable, so `install_dependencies` clears any stale lock and retries up to ten times, streaming each line of pacman output to the progress page, and only gives up — loudly — after the last attempt.

<!--snippet file=src/android/proot/setup.rs fn=install_dependencies-->

Behind the progress page is `WebviewBackend::build`. It binds an ephemeral localhost port, then spins up two threads: one forwards `SetupMessage`s from the install pipeline to the connected browser, the other accepts the browser's WebSocket connection. The port it picked is the one handed to the WebView URL up in `resumed`.

<!--snippet file=src/android/backend/webview.rs fn=build-->

When the pipeline reaches 100%, it asks the user to restart. On the next launch every stage reports "already done", `setup` returns the `Wayland` backend, and the device never visits this path again.

## The Wayland path — the product

This is what Local Desktop *is*: a Wayland compositor running inside the Android NDK, with an Xfce desktop running as its client inside proot, rendered back into the native activity. The `Wayland` arm of `resumed` is its entry point. On every resume it (re)creates the GPU renderer, configures the output to match the Android window, marks the runtime active, draws one frame, and launches the desktop session.

The backend struct is the compositor's live state — the smithay `Compositor`, the winit GPU renderer (dropped on suspend, rebuilt on resume), the input clock, and the touch-gesture bookkeeping that turns finger gestures into pointer events.

<!--snippet file=src/android/backend/wayland/mod.rs struct=WaylandBackend-->

`bind` constructs the winit + smithay GLES renderer against the activity's surface. It returns a `Result` because GPU init can fail (notably on resume races), and `resumed` degrades gracefully when it does.

<!--snippet file=src/android/backend/wayland/winit_backend.rs fn=bind-->

`configure_output` reconciles the compositor with the physical Android window every time the surface changes: it sets the compositor size, creates or updates the smithay `Output` (mode, transform, fractional scale), writes the host geometry to a file the in-chroot `wlr-randr` script watches, and resizes any existing toplevel windows to fill the screen.

<!--snippet file=src/android/app/run.rs fn=configure_output-->

With the compositor live, `launch` starts the desktop. It guards against double-launch with an atomic flag, clears stale X11 lock files, then runs `startxfce4 --wayland` as the configured user *inside proot* on a background thread. From here, Xfce is a normal Wayland client of our compositor.

<!--snippet file=src/android/proot/launch.rs fn=launch-->

The other half of the product is input. Android delivers events to winit; `window_event` is the per-frame entry. It funnels every raw event through `centralize` (which normalises winit/touch events into our own `CentralizedEvent`, including two-finger-scroll detection) and then `handle` (which feeds them into the smithay compositor and requests redraws). Physical-keyboard events injected by the accessibility service take a parallel route through `user_event` → `centralize_injected_keyboard`.

<!--snippet file=src/android/app/run.rs fn=window_event-->

That is the whole runtime loop: resume → bind renderer → configure output → launch desktop → translate input → render, suspend tears the renderer down, and the next resume rebuilds it. Everything below this line is about producing the `.apk` that ships all of the above.

# `xbuild` — the cross-compiling build path

The shipped APK is built with [`xbuild`](https://github.com/rust-mobile/xbuild), vendored and patched under `patches/xbuild/` (the patches add Android-*host* support — building on-device in Termux — plus AGP/KGP compatibility). This is the path the desktop pipeline and `scripts/build-termux.sh` use; the canonical invocation is one line:

<!--snippet file=src/bin/build_apk.rs lines=1-1-->

(For reference, that single command is `x build --release --platform android --arch arm64 --format apk`.)

The CLI is a `clap` subcommand enum. `Build` flattens straight into `BuildEnv::new` followed by `command::build`; `Run`, `Test`, and `Lldb` are the same build step plus a device action, which is why they all share `BuildArgs`.

<!--snippet file=patches/xbuild/xbuild/src/main.rs fn=run-->

`command::build` is the engine. It runs as three tasks: fetch any precompiled artifacts, build the Rust crate for each target arch (note `--lib` — for Android we build the `cdylib`, not a binary), then package the result into the requested format. For our platform that final step constructs an `Apk` from the freshly built `lib*.so`. The head of the function shows the shape:

<!--snippet file=patches/xbuild/xbuild/src/command/build.rs fn=build-->

The packaging `xbuild` does here is the same job the next chapter does standalone — which is the point of having both.

# `build_apk` — the no-cross-compile build path

On an arm64 device there is nothing to cross-compile, so the project ships its own APK builder and makes it the default binary (`default-run = "build_apk"` in `Cargo.toml`). A bare `cargo run` on-device builds, packages, and signs the APK with no `xbuild`, no Gradle, and no Android Studio — it is a self-contained reimplementation of the packaging half of the previous chapter.

The whole thing is `apk::build`. It parses `manifest.yaml`, synthesises a complete `AndroidManifest` (filling in sane defaults for SDK levels, the launcher activity, the `android.app.lib_name` meta-data that points Android at our `cdylib`, and the `MAIN`/`LAUNCHER` intent filter), runs `cargo build --lib` to produce the `.so`, then assembles the APK: resources and icon, declared assets, the native library for the host arch, and the prebuilt `classes.dex` — finishing with a signing pass.

<!--snippet file=src/bin/build_apk.rs fn=build-->

The packaging primitives it leans on are small and worth knowing by name:

- `Apk::add_res` compiles `resources.arsc`, scales the icon to every density, and serialises the binary `AndroidManifest.xml`.
- `Apk::add_lib` drops the `cdylib` into `lib/<abi>/`.
- `Apk::finish` closes the zip and hands it to the RSA/SHA-256 `Signer`.

`add_res` is the most involved — it is where the human-readable `manifest.yaml` becomes the binary resource table Android actually reads:

<!--snippet file=src/bin/build_apk.rs fn=add_res-->

Both build paths converge on the same artifact — a signed APK whose `cdylib` exports the `android_main` we started this document with. The call stack closes on itself.
