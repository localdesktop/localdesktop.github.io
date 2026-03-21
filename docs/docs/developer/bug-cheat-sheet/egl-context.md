---
title: Failed to create EGLContext
---

## Issue

You would likely (and hopefully only) encounter this problem when using an emulator. Local Desktop will crash immediately, and the log will show `Failed to create EGLContext` with an error variant, such as `EGL_BAD_MATCH` or `EGL_BAD_ATTRIBUTE`.

[Khronos EGL documentation](https://registry.khronos.org/EGL/sdk/docs/man/html/eglMakeCurrent.xhtml#errors) points out these errors very clearly. It seems like the cause of our specific case is:

> If context does not support being bound without read and draw surfaces, and both draw and read are EGL_NO_SURFACE, an EGL_BAD_MATCH error is generated.

:::info
It's hard to find these documentations on your own, that's why this Bug Cheat Sheet will prove to be very useful.

So remember: **whenever you get stuck, come back here!** And don't just read - please contribute whatever you find.
:::

## Solution

### EGL_BAD_MATCH

Local Desktop patched this [portion of Smithay](https://github.com/localdesktop/localdesktop/commit/58ffc6fc37da2d799db0d68b8549abe57fa2e636) to create a dummy 1x1 pbuffer surface and use it as both the draw and read surface when calling `eglMakeCurrent` to avoid the `EGL_BAD_MATCH` error.

Dear EGL experts, does the above hack make sense?

### EGL_BAD_ATTRIBUTE

If the error variant is `EGL_BAD_ATTRIBUTE`, you must toggle the `Experimental: Enable ANGLE` setting in Developer options:

![ANGLE](/img/angle-setting.webp)

Hint: Initially, this setting appears greyed out (the reason is unclear). To enable toggling, first turn off the `Use developer options` toggle, then turn it back on. Note that the device will reboot when the ANGLE setting is changed.
