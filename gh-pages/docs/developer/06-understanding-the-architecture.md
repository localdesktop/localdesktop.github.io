---
title: Understanding the architecture
description: How Local Desktop runs Arch Linux on Android without root, with PRoot, a Wayland compositor written in Rust, GPU drivers for Adreno, and PipeWire for sound.
---

In one paragraph:

1. An Arch Linux ARM64 filesystem is downloaded and set up inside the app's internal storage.
2. PRoot runs it in a chroot-like environment, without root.
3. A small Wayland compositor, written in Rust with Smithay, runs inside the Android app.
4. Xfce launches inside the chroot as a Wayland client of that compositor, and its pixels end up in the Android window.

The rest of this page explains each part, and why it's built that way.

## Proot

### How much Linux is Android?

You must have heard somewhere that Android is actually Linux. How true is that?

Android has a Linux kernel, and that's it.

What does it mean to have a Linux kernel? It means that Android uses the same core that is responsible for processes, memory, files and devices. But beyond that, Android is a completely different operating system. It does not have the same file system layout, and not the same libraries (Android uses its own C library, Bionic, instead of glibc). Many system calls are also blocked for apps by Android's security rules (seccomp and SELinux). What's more, it does not even have the same graphical technology stack.

### Two problems to tackle

As explained, in order to make Android run (shell) Linux applications, we need to provide a similar environment, that is, the same file system, the same libraries, and the same system calls.

And in order to run GUI applications, we need to provide a similar graphical technology stack.

### Chroot

You might have heard of docker, it is all over the place nowadays. You can think of `chroot` as a simplified version of docker which you don't ever need to install because it is part of every Linux distribution.

`chroot` is a Linux command that changes the root directory of the current process and its children. If you are running Ubuntu, and you `chroot` into an Arch Linux filesystem, then you are actually running Arch Linux.

### Proot

So the same concept can apply to Android, right? We can setup an Arch Linux filesystem inside Android, and then `chroot` into it. Unfortunately, `chroot` requires root access, that means you must root your Android device. It is not only inconvenient, but also dangerous. There is another option, and that is `proot`.

Now you might get the idea of what `proot` is. It is a tool that allows you to run Linux in a chroot-like environment without root access. It works like a debugger: it uses `ptrace` to stop each system call of the Linux programs, and rewrites the file paths in them, so `/usr/bin/firefox` becomes `/data/data/io.github.localdesktop/files/arch/usr/bin/firefox` before the kernel sees it. The programs never notice. PRoot can also fake a few things that Android doesn't allow, like bind mounts (`--bind`) and being root (`--root-id`). To fake owners and permissions, `--root-id` writes a small `.proot-meta-file.<name>.meta` next to each file it changes. Local Desktop also passes `-H`, which hides those files from directory listings, so tools like `makepkg` and `tar` never see them.

### Wrapping it up

The magic behind Local Desktop is that:

- It scaffolds an Arch Linux filesystem inside the app's internal storage.
- It `proot`s into the filesystem, so that Linux programs see the file system and the libraries they expect. Together with the Linux kernel that Android already has, they just run.

Before anything else, Local Desktop checks that PRoot works on the device at all. If it doesn't (for example, the app is on an SD card, or a rooted ROM blocks `ptrace`), you get the **Device Unsupported** page instead of the installer.

How about the magic behind GUI applications?

## The first run

The first time the app starts, there is no Linux yet, so instead of the compositor it shows a WebView with `setup-progress.html`: these docs in an iframe, with a progress bar under them. The Rust side reports its progress to the page over a local WebSocket (`ws://127.0.0.1:<port>`).

The setup is a list of 13 stages in `src/android/proot/setup.rs`. Each one checks whether its work is already done, so they all run on every start, and the second start is fast:

1. Download and extract the Arch Linux ARM rootfs (from proot-distro's releases).
2. Fake the parts of `/proc` and `/sys` that Android hides from apps.
3. Run the **Check** command, and if it fails, the **Install** command (`pacman -Syu ...`), up to 10 times.
4. Write `/etc/machine-id` for D-Bus.
5. Remove the PipeWire package hold that older versions put in `/etc/pacman.conf`, so `pacman -Syu` can upgrade everything together.
6. Install a pacman hook that keeps `/etc/passwd` and `/etc/group` readable for normal users (`systemd-sysusers` leaves them at `600` under PRoot).
7. Write Firefox's AutoConfig (see [Firefox](/docs/user/app-compatibility/firefox)).
8. Replace `bwrap` with a shim, since Android has no user namespaces for a real sandbox.
9. Add `--no-sandbox` menu entries for Chromium and Electron apps.
10. Wrap Onboard so it survives a PRoot limitation.
11. Unpack the Turnip and Zink GPU drivers, on Qualcomm devices.
12. Write the Xfce and labwc configuration: the Wayland launch script, HiDPI scaling and the keyboard relay.
13. Fix the XKB data symlink (see [the XKB bug](/docs/developer/bug-cheat-sheet/xkb-error)).

When the install finishes, the page asks you to restart the app. On the next start, **Check** succeeds, and the app goes straight to the compositor.

## Wayland

### Display Server

You may be surprised that to display some pixels from your application, say, Firefox, to your screen, Linux implement a client-server protocol. In this model, Firefox is the client and the display server is the server (obviously).

Not all operating systems use a display server. Windows uses a monolithic graphics architecture where the windowing system, input handling, and rendering are all tightly integrated into the operating system.

### X11 and Xorg

If you have used Linux for a while, you must have seen the word X11 or Xorg. X11 is the original protocol for the display server. Xorg is a display server that implements the X11 protocol.

:::note
Remember, X11 is a protocol, Xorg is a display server. Although they are often used interchangeably, they are not the same thing.
:::

### Wayland

Wayland is a modern display server protocol that is designed to replace X11. Local Desktop follows this trend. This approach has some advantages:

- Wayland servers, more frequently called **compositors**, are much more efficient than X11 servers.
- By implementing a minimal Wayland compositor, guest Wayland sessions can connect as clients. Legacy X11 applications can still run via Xwayland when a nested compositor (such as labwc) provides it.

### Xwayland

Xwayland, just like Xorg, is a display server that implements the X11 protocol.

Xwayland, different from Xorg, in that it runs **on top of another Wayland compositor**, while Xorg runs on top of the Linux kernel.

How does Xwayland do this, you may ask? It is more obvious than you think: it acts as a Wayland client. In other words, it is a Wayland client that takes the responsibility of an X11 display server.

### Wrapping it up

The magic behind Local Desktop is that:

- It implements a minimal Wayland compositor that runs on an Android native activity and listens on `/tmp/wayland-0`.
- The default **Launch** command runs `/usr/local/bin/startxfce4-localdesktop`, a small script that sets up sound, the GPU drivers and the Electron sandbox flag, then runs `startxfce4 --wayland`. That brings up labwc as a nested compositor, connected to our socket.
- Applications (Firefox, Thunar, the Xfce panel, and so on) render through that nested Wayland stack back to the Android window. Xwayland remains available for legacy X11-only apps when needed.

Fun fact: [Termux:X11](https://github.com/termux/termux-x11) also implements a display server, but it is based on X11. Just like how Xwayland is an X11 server running on top of Wayland, Termux:X11 is an X11 server running on top of an Android activity. (And Xorg is an X11 server running on top of the Linux kernel, remember that?)

## Rendering

### The frame loop

The compositor only works when something happens. A `wayland-watcher` thread polls the client sockets and wakes the winit event loop (`AppUserEvent::WaylandReady`) when a client connects or sends requests. When a client attaches a new buffer, the compositor draws it right away, at most once per display refresh. Frame callbacks, which tell clients to draw their next frame, are released on the next vsync (`AChoreographer`, delivered as `AppUserEvent::Vsync`). With nothing changing on screen, the compositor sleeps and presents no frames.

labwc hands over its frames as shared memory (`wl_shm`). Uploading them with `glTexSubImage2D` makes Adreno's driver re-tile every damaged pixel on the CPU, so `hardware_buffer.rs` copies the damaged rows into one of two `AHardwareBuffer`s instead, and the GPU samples that linear memory directly. Other buffers, and devices without `AHardwareBuffer` (Android 7 and older) or GLES 3, keep Smithay's upload path.

### GPU acceleration in the guest

Android lets apps open exactly one GPU device: Qualcomm's KGSL (`/dev/kgsl-3d0`). The DRM nodes under `/dev/dri` are off limits. Arch Linux ARM's Mesa only talks to DRM, so on its own every guest app renders on the CPU (llvmpipe).

Local Desktop ships its own Mesa build (`patches/build-mesa`, unpacked to `/opt/localdesktop-mesa`):

- **Turnip** (Vulkan) built with the KGSL backend.
- **Zink** (OpenGL on top of Vulkan), selected through glvnd (`__EGL_VENDOR_LIBRARY_FILENAMES`, `__GLX_VENDOR_LIBRARY_NAME`) so the distro's Mesa stays installed and untouched.

labwc renders with pixman and offers no dma-buf, so GPU apps present through shared memory. Vulkan swapchains use `MESA_VK_WSI_DEBUG=sw`, and Zink presents through kopper, its Vulkan WSI path. Upstream Mesa can only force that path on X11 (`LIBGL_KOPPER_DRI2`); our patch adds the same for Wayland. The session sources `/opt/localdesktop-mesa/env.sh`, which only switches drivers when `vkprobe` finds a Turnip device, so unsupported GPUs fall back to llvmpipe.


## Sound

Linux apps expect a sound server, and on Arch that's PipeWire. Android apps play sound with AAudio. So Local Desktop runs **PipeWire on the Android side**, as child processes of the app (built from Termux's packages, see `assets/libs/arm64-v8a/`), with WirePlumber and `pipewire-pulse` for apps that speak PulseAudio. A small PipeWire sink module plays everything it receives through AAudio.

The guest connects to it through the socket in the shared `/tmp` (`PIPEWIRE_RUNTIME_DIR=/tmp`, `PULSE_SERVER=unix:/tmp/pulse/native`). The guest's own PipeWire packages are only there for their client libraries, and are held at the same version. See [Bridging sound to Android](/docs/developer/bridging-sound-to-android) for the details.

## Input

- **Touch** on the phone is turned into pointer events by the compositor (`event_centralizer.rs`, `event_handler.rs`): tap to click, slide to scroll, long press for right click or drag.
- **The Android keyboard** is opened by `PhoneKeyboard.java`. Inside the guest, Squeekboard tells when a text field gets focus, and a small relay script asks the app to show the Android keyboard instead.
- **Physical keyboards** come through winit. Shortcuts that Android keeps for itself (`Alt+Tab`, `Meta`) come through an optional accessibility service (`KeyboardAccessibilityService.java`, `accessibility.rs`).
- **External displays** use Android's Presentation API (`ExternalDisplay.java`, `external_display.rs`). The compositor draws to the monitor's surface, and the phone shows `TrackpadControls`.

## Settings

The settings are a plain Android `Activity` (`SettingsActivity.java`) in its own process, reached from App info. It stores only the values that differ from the defaults, in SharedPreferences, and the Rust side reads them at start (`src/android/utils/settings.rs`). Because it's a separate process, it opens even when the compositor or the guest is stuck.
