---
title: "xkbcommon: ERROR: failed to add default include path"
sidebar_label: xkbcommon include path
description: Why libxkbcommon cannot find its keyboard data on Android, and how Local Desktop builds it with the right XKB config root.
---

## Issue

You may encounter this issue while doing a cross build. This error is related to cross build issues with xkbcommon specifically:

```
xkbcommon: ERROR: failed to add default include path /usr/share/X11/xkb
```

This error occurs because by default, xkbcommon will look for configuration files in `/usr/share/X11/xkb`. And of course, they are not found in the expected location, so you have to specify otherwise during cross compilation.

## Solution

To resolve this issue, you need to re-cross-compile `libxkbcommon.so` for Android with the right `xkb-config-root`. See `patches/build-libxkbcommon/Dockerfile` (the `xkb-config-root` and `x-locale-root` options) for how we point it at the guest's `/usr/share/X11/xkb`, inside the app's data folder (`/data/data/io.github.localdesktop/files/arch/...`).

That path is different for secondary Android users and Private Space, so at runtime Local Desktop also sets `XKB_CONFIG_ROOT` and `XLOCALEDIR` to the real location (`src/android/utils/application_context.rs`). And the last setup stage, `fix_xkb_symlink`, makes sure the XKB data in the guest is where libxkbcommon expects it.
