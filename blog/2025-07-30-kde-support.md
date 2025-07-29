---
title: KDE Plasma 🌌🎆
authors:
  - name: Mister Teddy
    title: Creator & Maintainer of Polar Bear
    url: https://mister-teddy.github.io
    image_url: https://avatars2.githubusercontent.com/u/29925961
tags: [for-user, kde, plasma, desktop-environment, wayland, x11]
---

We're excited to announce that our experiments with **KDE Plasma** have yielded positive results, both the X11 session via XWayland and the Wayland session.

![KDE Plasma on Local Desktop](/img/kde.webp)

## How to

Please visit [this document](/docs/user/custom-de) for detailed instructions.
In simpler terms, just add the following configuration to your `localdesktop.toml` file:

```toml title="/etc/localdesktop/localdesktop.toml"
[command]
try_check = "pacman -Qg plasma"
try_install = "stdbuf -oL pacman -Syu plasma --noconfirm --noprogressbar"
# X11 session via Xwayland
try_launch = "XDG_RUNTIME_DIR=/tmp Xwayland -hidpi :1 2>&1 & while [ ! -e /tmp/.X11-unix/X1 ]; do sleep 0.1; done; XDG_SESSION_TYPE=x11 DISPLAY=:1 dbus-launch startplasma-x11 2>&1"
# Wayland session
try_launch = "XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 /usr/lib/plasma-dbus-run-session-if-needed startplasma-wayland 2>&1"
```


The outcome has been so promising that we're considering setting KDE Plasma as the default desktop environment in Local Desktop. This aligns with our long-term goal: replacing XWayland with a native Wayland session for better performance. We'd love to hear your thoughts on our [GitHub repository](https://github.com/localdesktop/localdesktop), and toss us a ⭐️ to help keep us motivated to improve KDE Plasma compatibility!
