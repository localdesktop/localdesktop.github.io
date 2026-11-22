---
title: Using the GPU
description: Which phones get GPU acceleration in Local Desktop, how to check that it works, and how to turn it off.
---

On devices with a Qualcomm Snapdragon chip (most Adreno 6xx and newer GPUs), Linux apps render with the GPU:

- **Vulkan** runs on [Turnip](https://docs.mesa3d.org/drivers/freedreno.html), Mesa's open-source Adreno driver, talking to the GPU through Qualcomm's KGSL device.
- **OpenGL and OpenGL ES** run on [Zink](https://docs.mesa3d.org/drivers/zink.html), which translates them to Vulkan.

Firefox renders pages and WebGL on the GPU, and games and 3D apps run many times faster than on the CPU.

Other devices (Mali, PowerVR, Xclipse and older Adreno GPUs) use software rendering (llvmpipe) instead. Everything still works, just slower for 3D. When the app starts, it only sets up the GPU drivers if it can open the Adreno GPU (`/dev/kgsl-3d0`), and the desktop only switches to them if the Turnip driver says it supports your GPU, so there's nothing to configure either way.

## Check that it works

```bash
pacman -S --needed mesa-utils
eglinfo -B -p wayland | grep renderer
```

On a supported device this prints a renderer like `zink Vulkan 1.4(Turnip Adreno (TM) 740 (MESA_TURNIP))`. In Firefox, `about:support` shows the same renderer under **Graphics**.

## Turn it off

If apps misbehave with the GPU, add `LOCALDESKTOP_GPU=0` to the `export` at the start of the **Launch** command in [Local Desktop settings](/docs/user/changing-settings), like this:

```bash
export LOCALDESKTOP_GPU=0 PIPEWIRE_RUNTIME_DIR=/tmp PULSE_SERVER=unix:/tmp/pulse/native; XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=XFCE /usr/local/bin/startxfce4-localdesktop 2>&1
```

To turn it off for a single app, start it with the distro's Mesa instead:

```bash
env -u MESA_LOADER_DRIVER_OVERRIDE -u __EGL_VENDOR_LIBRARY_FILENAMES -u __GLX_VENDOR_LIBRARY_NAME firefox
```

## Custom desktop environments

The GPU drivers live in `/opt/localdesktop-mesa`, next to (not instead of) the distro's `mesa` package, so `pacman -Syu` never overwrites them. The default Xfce session enables them by sourcing `/opt/localdesktop-mesa/env.sh`. If you [use another desktop environment](/docs/user/changing-the-desktop-environment), source it at the start of your `launch` command:

```bash
. /opt/localdesktop-mesa/env.sh; startplasma-wayland
```
