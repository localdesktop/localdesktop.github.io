---
title: "xkbcommon: ERROR: failed to add default include path"
---

## Issue

You may encounter this issue while doing a cross build. This error is related to cross build issues with xkbcommon specifically:

```
xkbcommon: ERROR: failed to add default include path /usr/share/X11/xkb
```

This error occurs because by default, xkbcommon will look for configuration files in `/usr/share/X11/xkb`. And of course, they are not found in the expected location, so you have to specify otherwise during cross compilation.

## Solution

To resolve this issue, you need to re-cross-compile `libxkbcommon.so` for Android with the right `xkb-config-root`. Please check this [working example](https://github.com/localdesktop/localdesktop/blob/40fb83cfbe588f1fc23f4bf14e733297a0e64473/patches/build-libxkbcommon/Dockerfile#L48-L49) on how to specify the correct config root (and other important parameters such as locale root).
