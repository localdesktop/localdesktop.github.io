---
title: KDE Plasma 🌌🎆
authors: teddy
tags: [for-user, kde, plasma, desktop-environment, wayland, x11]
---

:::caution Current guidance
This post records early KDE experiments. Use the maintained [custom desktop environment guide](/docs/user/custom-de#kde-plasma) for current instructions. A TOML table may contain only one `try_launch` key, and native Wayland does not start reliably on every device.
:::

Our initial experiments with **KDE Plasma** produced working X11 sessions through Xwayland and working native Wayland sessions on the tested setup.

![KDE Plasma on Local Desktop](/img/kde.webp)

## How to

Create or edit `/etc/localdesktop/localdesktop.toml`, then choose **one** session template.

### X11 via Xwayland

```toml title="/etc/localdesktop/localdesktop.toml"
[command]
try_check = "pacman -Qg plasma"
try_install = "stdbuf -oL pacman -Syu plasma --noconfirm --noprogressbar"
try_launch = "XDG_RUNTIME_DIR=/tmp Xwayland -hidpi :1 2>&1 & while [ ! -e /tmp/.X11-unix/X1 ]; do sleep 0.1; done; XDG_SESSION_TYPE=x11 DISPLAY=:1 dbus-launch startplasma-x11 2>&1"
```

### Native Wayland

```toml title="/etc/localdesktop/localdesktop.toml"
[command]
try_check = "pacman -Qg plasma"
try_install = "stdbuf -oL pacman -Syu plasma --noconfirm --noprogressbar"
try_launch = "XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 /usr/lib/plasma-dbus-run-session-if-needed startplasma-wayland 2>&1"
```

Do not paste both `try_launch` alternatives into the same table. If native Wayland produces a black or purple screen, restart Local Desktop and test the X11 template. When a template succeeds, remove the `try_` prefix from all three settings to keep it for later launches.

Local Desktop currently defaults to Xfce; KDE remains an advanced custom configuration. Compatibility details and non-root user instructions are maintained in the [user guide](/docs/user/custom-de#kde-plasma).
