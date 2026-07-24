---
title: Using other Desktop Environments
---

:::warning
This is an advanced topic. A desktop environment that fails to start can leave you on a black or solid-colour screen for that launch. Test changes with the `try_*` settings described below so that Local Desktop can recover on the next restart.
:::

:::info Project scope
Local Desktop targets desktop-style use on Android with a sufficiently large display and a physical keyboard. Mobile shells such as Phosh and Plasma Mobile are not currently supported or planned as defaults. We intentionally do not publish unverified installation or launch commands; confirmed community configurations are welcome.
:::

## Before you begin

Local Desktop reads custom settings from:

```text
/etc/localdesktop/localdesktop.toml
```

The file is optional and might not exist on a fresh installation. From the default root session, create it when needed:

```bash
mkdir -p /etc/localdesktop
touch /etc/localdesktop/localdesktop.toml
```

Each setting must fit on one line. A TOML key may appear only once in a table, so a configuration must contain **exactly one** `launch` or `try_launch` entry. Do not paste the X11 and Wayland alternatives into the same `[command]` table.

## The `[command]` settings

Local Desktop uses three commands to set up a desktop environment:

```toml title="/etc/localdesktop/localdesktop.toml"
[command]
check = "pacman -Q noto-fonts && pacman -Q xfce4-session && pacman -Q xfce4-panel && pacman -Q xfce4-settings && pacman -Q xfce4-terminal && pacman -Q thunar && pacman -Q xfdesktop && pacman -Q xfconf && pacman -Q labwc && pacman -Q wlr-randr && pacman -Q xorg-xwayland && pacman -Q xdg-desktop-portal && pacman -Q xdg-desktop-portal-gtk && pacman -Q onboard"
install = "stdbuf -oL pacman -Syu --needed --noconfirm --noprogressbar noto-fonts xfce4 labwc wlr-randr xorg-xwayland xdg-desktop-portal xdg-desktop-portal-gtk onboard"
launch = "XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=XFCE /usr/local/bin/startxfce4-localdesktop 2>&1"
```

You can replace these commands to install and launch another desktop environment.

:::success Test safely with `try_*`
Use `try_check`, `try_install`, and `try_launch` while testing. Each `try_*` entry overrides its normal counterpart for one launch and is then commented out automatically. See [Configurations](/docs/user/configurations#special-try_-configs) for the complete behavior.
:::

### `check`

The `check` command verifies that all required packages are installed. Local Desktop has two operating modes:

- **Webview mode**, which shows installation documentation and progress.
- **Wayland mode**, which hosts the desktop session.

If `check` succeeds, Local Desktop starts in Wayland mode. Otherwise, it enters Webview mode and runs `install`.

:::info Recipe
Use `pacman -Q package` to check an individual package and `pacman -Qg package-group` to check a package group. Join independent checks with `&&` so that any missing requirement causes the command to fail.
:::

### `install`

When `check` fails, Local Desktop runs `install` as root. Important requirements:

- Prefix the command with `stdbuf -oL `. [Why?](/docs/developer/bug-cheat-sheet/pacman-progress)
- Include `--noconfirm`; there is no interactive prompt available during setup.
- Include `--noprogressbar` for readable installation output.

:::info Recipe
Keep the command syntax and place all packages or groups between `pacman -Syu` and the first option. For example: `pacman -Syu package-1 package-group-2 package-3 --noconfirm --noprogressbar`.
:::

### `launch`

When `check` succeeds, Local Desktop runs `launch` as the user configured under `[user]`.

This is the most important and most environment-sensitive command. Important notes:

- Check [logcat](/docs/developer/how-to-logcat) when a session does not start.
- Append `2>&1` when necessary so stderr is included in the captured output.
- The default session is **Xfce on Wayland**. The built-in compositor listens on `/tmp/wayland-0`; the guest runs `startxfce4 --wayland`, which starts labwc as a nested compositor and connects to that socket. Setup installs `/usr/local/bin/startxfce4-localdesktop` as a thin wrapper around `startxfce4 --wayland`.

:::info Recipe
For a native Wayland session, set variables such as `XDG_RUNTIME_DIR=/tmp`, `WAYLAND_DISPLAY=wayland-0`, and `XDG_SESSION_TYPE=wayland`, then start the desktop's Wayland session.

For a legacy X11 session, start Xwayland, wait for its socket, and point the desktop at `DISPLAY=:1`.
:::

## KDE Plasma

Choose **one** of the following templates. Do not combine their `try_launch` entries.

### X11 session via Xwayland

Use this as the fallback when the native Wayland session does not start on a device:

```toml title="/etc/localdesktop/localdesktop.toml"
[command]
try_check = "pacman -Qg plasma"
try_install = "stdbuf -oL pacman -Syu plasma --noconfirm --noprogressbar"
try_launch = "XDG_RUNTIME_DIR=/tmp Xwayland -hidpi :1 2>&1 & while [ ! -e /tmp/.X11-unix/X1 ]; do sleep 0.1; done; XDG_SESSION_TYPE=x11 DISPLAY=:1 dbus-launch startplasma-x11 2>&1"
```

### Native Wayland session

Native Wayland can provide better performance, but compatibility is not uniform. Some users have reported black or purple screens. Test it with the one-shot settings below; after a failed launch, restart Local Desktop and use the X11 template instead.

```toml title="/etc/localdesktop/localdesktop.toml"
[command]
try_check = "pacman -Qg plasma"
try_install = "stdbuf -oL pacman -Syu plasma --noconfirm --noprogressbar"
try_launch = "XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 /usr/lib/plasma-dbus-run-session-if-needed startplasma-wayland 2>&1"
```

![KDE Plasma on Local Desktop](/img/kde.webp)

### Keep a successful configuration

The `try_*` settings are deliberately one-shot. When a template works, remove the `try_` prefix from **all three** settings:

- `try_check` → `check`
- `try_install` → `install`
- `try_launch` → `launch`

If you do not make that change, the test entries are commented out after use and Local Desktop returns to its normal desktop configuration on the next launch.

### Run Plasma as a non-root user

Create and configure the account first by following [Creating a Non-root User](/docs/user/creating-a-non-root-user). Then add the user setting alongside one KDE template:

```toml title="/etc/localdesktop/localdesktop.toml"
[user]
username = "teddy"

[command]
# Add exactly one KDE check/install/launch template here.
```

Replace `teddy` with the account you created. Local Desktop runs `check` and `install` as root, so KDE packages are installed system-wide. It runs only `launch` as the configured user, so the Plasma session and its per-user settings belong to that account. Do not add `sudo` to the `install` command.

### Known limitations

- The time zone is not set automatically; it can be configured through KDE's settings.
- A `Could not enter folder tags:.` error can appear.
- Native Wayland features are still incomplete on some devices. For example, Spectacle screenshots might not work.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Black or purple screen after changing KDE settings | Restart Local Desktop. The one-shot `try_*` values will already be disabled. Then test the X11 template or inspect logcat. |
| KDE works once, then Local Desktop returns to its default desktop | Remove the `try_` prefix from all three successful settings. |
| Local Desktop ignores the custom file | Check for malformed TOML, duplicate keys, multi-line values, or incorrect capitalization. |
| The config file is missing | Create `/etc/localdesktop` and `localdesktop.toml` as shown above. |
| Plasma starts as root | Create a non-root account and set `[user].username` to that exact account name. |

## Other desktop environments

Please contribute only configurations that you have verified on the current Local Desktop release. A useful contribution includes:

- The complete `check`, `install`, and `launch` commands.
- Whether the session uses native Wayland or Xwayland.
- The Local Desktop version and device architecture tested.
- Known limitations and a recovery path when launch fails.
