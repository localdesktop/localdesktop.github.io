---
title: Installing apps
description: Install, update and remove Linux apps in Local Desktop with pacman, find packages for ARM, and build community packages from the AUR with yay.
---

Local Desktop runs Arch Linux ARM, so you install software the Arch way, with `pacman`, the package manager. There is no app store window to click through: you type one command in the terminal, and pacman downloads the app with everything it needs.

Open the terminal from the dock at the bottom of the screen, and keep reading.

## Install an app

```bash
pacman -Syu gimp
```

This does two things at once: `-Syu` updates the whole system first, then pacman installs GIMP. When it finishes, GIMP is in the **Applications** menu.

Always install with `-Syu`, not just `-S`. Arch moves fast, and the list of packages on your phone goes out of date within days. With a plain `-S`, pacman may try to download a version that the server already deleted, and fail with `404`. Or worse, install a new app against old libraries, and the app won't start.

You can install several apps in one go:

```bash
pacman -Syu gimp libreoffice-fresh chromium
```

:::tip
pacman asks before it does anything. Press **Enter** to accept. Add `--noconfirm` if you don't want to be asked.
:::

## Find an app

```bash
pacman -Ss office
```

This searches the names and descriptions of every package. Results are listed as `repository/name version`, for example `extra/libreoffice-fresh`. Install it with the name after the slash.

You can also browse the [Arch Linux ARM package list](https://archlinuxarm.org/packages) in a browser. Choose **aarch64** as the architecture.

## Update everything

```bash
pacman -Syu
```

The same command without a package name. Run it every week or two. Local Desktop doesn't update Linux by itself.

## Remove an app

```bash
pacman -Rns gimp
```

`-Rns` removes the app, the dependencies that nothing else needs anymore, and its system-wide settings. Your own files and the settings in your home folder stay.

## Free up space

pacman keeps every package it downloads, in case you want to install it again. Over time, that cache can take gigabytes. Clean it with:

```bash
pacman -Scc
```

To see which installed packages are the biggest:

```bash
pacman -Qi | awk '/^Name/{n=$3} /^Installed Size/{print $4$5, n}' | sort -h | tail -15
```

## Why can't I find an app?

Arch Linux ARM builds most of what Arch Linux has, but a few groups of apps are missing:

- **Apps only made for PCs.** Spotify, Steam, Discord and most commercial games only exist for x86_64 processors. Your phone has an ARM processor (aarch64), so they can't run. Look for an alternative, like the web version of Spotify or Discord in Firefox.
- **Apps that are not open source.** The official repositories only carry software that can be shared freely. Many of those are in the AUR instead, see below.
- **Apps that need Flatpak or Snap.** Both need Linux features that Android doesn't give to apps (user namespaces), so they don't work in Local Desktop.

## The AUR

The **AUR** (Arch User Repository) is a collection of build scripts written by the community. Instead of a ready package, you download a script, and your phone builds the package from it. It has thousands of apps that are not in the official repositories, Google Chrome and Visual Studio Code for example.

AUR packages are not checked by anyone. Before you install one, look at its page on [aur.archlinux.org](https://aur.archlinux.org): who maintains it, when it was updated, and what other people say in the comments.

### Set up yay

The usual way to use the AUR is an AUR helper like `yay`. It needs a few things first:

1. **A normal user.** The tools that build AUR packages refuse to run as root, which is Local Desktop's default user. [Create a normal user](/docs/user/creating-a-normal-user) with `sudo` rights, and use it from now on.
2. **The build tools.** As your normal user:

   ```bash
   sudo pacman -Syu --needed git base-devel
   ```

3. **yay itself.** It's in the AUR too, so the first one you build by hand. `yay-bin` is the ready-made version, which is much faster to build on a phone than `yay`:

   ```bash
   git clone https://aur.archlinux.org/yay-bin.git
   cd yay-bin
   makepkg -si
   ```

   `makepkg` builds the package, and `-si` installs it, together with anything it needs.

### Install from the AUR

```bash
yay -S visual-studio-code-bin
```

yay shows you the build script and asks before it builds. When it's done, the app is in the **Applications** menu like any other. `yay -Syu` updates both your official packages and your AUR packages.

Many AUR packages are only made for x86_64. On the package page, check that **Architecture** lists `aarch64` (or `any`) before you try. If it only says `x86_64`, the build fails, even if the app itself is open source.

## If something goes wrong

- **`error: failed retrieving file ... 404`**: your package list is out of date. Run `pacman -Syu` and try again.
- **`could not satisfy dependencies` that mentions `pipewire` or `wireplumber`**: you have an older version of Local Desktop, which held PipeWire back on purpose. Update Local Desktop and open it once, then run `pacman -Syu` again.
- **`error: command failed to execute correctly`** at the end of an install, with lines like `Failed to connect to system scope bus` in `/var/log/pacman.log`: these come from systemd's hooks, which can't reach systemd because Local Desktop doesn't run it. They're harmless, your apps are installed.
- **`unable to lock database`**: another pacman is still running, maybe in another terminal. Wait for it to finish. If you're sure none is running (for example, the app was closed in the middle of an install), delete the lock file with `rm /var/lib/pacman/db.lck`.
- **No space left**: run `pacman -Scc`, and remove apps you don't use. Never use **Clear storage** in Android's App info: it deletes your whole Linux installation.

For anything else, see [Troubleshooting](/docs/user/troubleshooting).
