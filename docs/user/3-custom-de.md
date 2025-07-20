---
title: Using other Desktop Environments
---

:::warning
This is an advanced topic. Proceed with your own risk.
:::

## The `[command]` configs

Local Desktop uses 3 commands to set up your desktop environment:

```toml
[command]
check="pacman -Q xorg-xwayland && pacman -Qg xfce4 && pacman -Q onboard"
install="stdbuf -oL pacman -Syu xorg-xwayland xfce4 onboard --noconfirm --noprogressbar"
launch="XDG_RUNTIME_DIR=/tmp Xwayland -hidpi :1 2>&1 & while [ ! -e /tmp/.X11-unix/X1 ]; do sleep 0.1; done; XDG_SESSION_TYPE=x11 DISPLAY=:1 dbus-launch startxfce4 2>&1"
```

You can change these 3 commands to install and launch your custom desktop environment. Please share your successful setups with us and we can put them here to help others.

:::success Tips
The `try_*` configs are very handy to try different config values **without breaking anything**. Check out the [Configurations](/docs/user/configuration-reference#special-try_-configs) section for more details.
:::

### check

The `check` command is used to verify if the required packages are installed and Local Desktop is ready to boot in Wayland mode. In case you are wondering, there are 2 modes in Local Desktop:
- Webview mode (the mode with the official website for documentation on top of a progress bar during installation)
- Wayland mode

If the command in `check` returns success, Local Desktop will boot in Wayland mode. Otherwise, it will enter Webview mode and proceed with the `install` command.

:::info Recipe
You can use `pacman -Q package` to check for a package and `pacman -Qg package-group` to check for a group. Use the `&&` operator to combine multiple checks.
:::

### install

When `check` fails, this command will be executed next. This is exactly the command that Local Desktop runs during the installation process. Some important notes:
- Always put `stdbuf -oL ` in front of the command. [Why?](/docs/developer/bug-cheat-sheet/pacman-progress)
- Always include the `--noconfirm` flag, otherwise, it will get stuck because it is waiting for a confirmation that never comes.
- For a clear output, include `--noprogressbar`.

stdbuf -oL pacman -Syu xorg-xwayland xfce4 onboard --noconfirm --noprogressbar

:::info Recipe
Just keep all the syntax and put all the packages/groups between `pacman -Syu` and the first `--`. For example: `pacman -Syu package-1 package-group-2 package-3 --noconfirm`.
:::

### launch

When `check` returns success, this command will be executed next. This is exactly the command that Local Desktop runs to launch the desktop environment.

This is the most important command to set up your preferred desktop environment. It is also the most complicated command, as it requires a good understanding of display server components. Some important notes:
- When things go wrong, you must check the [logcat](/docs/developer/how-to-logcat) to view the logs.
- If you don't see any error logs, try appending `2>&1` to redirect stderr to stdout.
- It is possible to start a Wayland session instead of using Xwayland, but many important protocol objects are **incomplete**.

:::info Recipe
Put important environment variables at the beginning of the command like `XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 ...`, then start Xwayland + an X11 session like this: `Xwayland -hidpi :1 2>&1 & startxfce4`, or a Wayland session like this: `startplasma-wayland`.
:::

## Config templates

```toml
[command]
Waiting for your contribution...
```
