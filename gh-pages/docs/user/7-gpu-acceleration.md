---
title: GPU acceleration
---

On devices with a Qualcomm Snapdragon chip (most Adreno 6xx and newer GPUs), Linux apps render with the GPU:

- **Vulkan** runs on [Turnip](https://docs.mesa3d.org/drivers/freedreno.html), Mesa's open-source Adreno driver, talking to the GPU through Qualcomm's KGSL device.
- **OpenGL and OpenGL ES** run on [Zink](https://docs.mesa3d.org/drivers/zink.html), which translates them to Vulkan.

Firefox renders pages and WebGL on the GPU, and games and 3D apps run many times faster than on the CPU.

Other devices (Mali, PowerVR, Xclipse and older Adreno GPUs) keep using software rendering (llvmpipe), as before.

## Check that it works

```bash
pacman -S --needed mesa-utils
eglinfo -B -p wayland | grep renderer
```

On a supported device this prints a renderer like `zink Vulkan 1.4(Turnip Adreno (TM) 740 (MESA_TURNIP))`. In Firefox, `about:support` shows the same renderer under **Graphics**.

## Turn it off

If an app misbehaves with the GPU, prefix your [`launch` command](/docs/user/custom-de#launch) with `LOCALDESKTOP_GPU=0`:

```toml title="/etc/localdesktop/localdesktop.toml"
[command]
try_launch="LOCALDESKTOP_GPU=0 XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=XFCE /usr/local/bin/startxfce4-localdesktop 2>&1"
```

To turn it off for a single app, start it with the distro's Mesa instead:

```bash
env -u MESA_LOADER_DRIVER_OVERRIDE -u __EGL_VENDOR_LIBRARY_FILENAMES -u __GLX_VENDOR_LIBRARY_NAME firefox
```

## Custom desktop environments

The GPU drivers live in `/opt/localdesktop-mesa`, next to (not instead of) the distro's `mesa` package, so `pacman -Syu` never overwrites them. The default Xfce session enables them by sourcing `/opt/localdesktop-mesa/env.sh`. If you [use another desktop environment](/docs/user/custom-de), source it at the start of your `launch` command:

```bash
. /opt/localdesktop-mesa/env.sh; startplasma-wayland
```
