---
title: Getting started
description: Install Local Desktop, get through the first run, and learn the few things every new user should know.
---

Welcome to Local Desktop!

{/* hide-in-pdf: shown only inside the in-app installer iframe (setup-progress.html); dropped from the PDF manuals by build_docs */}

If you are reading this inside the app, Local Desktop is setting things up in the background:

1. It downloads Arch Linux ARM (about 150 MB) and extracts it into the app's own storage.
2. It installs the Xfce desktop, Firefox, a PDF viewer, an on-screen keyboard and the audio packages with `pacman`.

The bar at the bottom shows what is happening right now. Tap it to show or hide the full log. This usually takes 5 to 10 minutes, depending on your internet connection and your phone. In the meantime, scroll down and read the few things that will save you some trouble later.

:::info Tips
Keep the app open and the screen on until the installation is complete. When it's done, you will see **"Installation finished, please restart the app!"**. Close Local Desktop (swipe it away from the recent apps) and open it again, and your desktop will be there.
:::

You can always come back to this page at [localdesktop.github.io](/).

{/* /hide-in-pdf */}

## What you need

- An Android phone or tablet with a 64-bit ARM chip (arm64). This is almost every Android device made in the last few years. Android 7 or newer works, but Android 11 or newer gives you the best experience.
- At least 4 GB of free storage for Arch Linux and the desktop, plus whatever you install later.
- An internet connection for the first run. After that, the desktop works offline, unless you want to install more apps.

No root is needed. Local Desktop runs Linux with [PRoot](https://proot-me.github.io/), inside the app's own storage, so it can't touch your Android system.

## Install the app

Download the latest APK from the [GitHub Releases page](https://github.com/localdesktop/localdesktop.github.io/releases) and open it. Android asks you to allow installing apps from your browser or file manager the first time, which is normal for any app outside of Google Play.

Then open Local Desktop. The first run does the setup described at the top of this page, and every run after that goes straight to the desktop in a few seconds.

:::tip Already a Termux user?
Local Desktop doesn't need Termux, proot-distro, Termux:X11 or a VNC viewer. Everything (Linux, the display server and the audio) is inside this one app.
:::

## What you get

After the first run, you have a full Arch Linux ARM system with:

- **Xfce**, a light and familiar desktop with a panel, a file manager (Thunar) and a terminal.
- **Firefox**, a real desktop browser, developer tools included.
- **Evince** to read PDFs. You will find this manual on the desktop as **Local Desktop - User Manual.pdf**, and a **Local Desktop - Online Docs** shortcut next to it.
- **Sound**, through PipeWire. Videos and games play sound on your phone's speaker or headphones with no setup (Android 11 or newer).
- **GPU acceleration** on most Snapdragon phones. See [Using the GPU](/docs/user/using-the-gpu).

The desktop scales itself to your screen's density, so text should be readable without changing anything.

## Install more apps

Local Desktop runs Arch Linux ARM, so you install apps with `pacman` in the terminal. For example, to get GIMP:

```bash
pacman -Syu gimp
```

[Installing apps](/docs/user/installing-apps) explains how to find apps, update and remove them, and how to use the AUR.

## Read this if you use Android 12 or newer

:::warning Important
If Local Desktop sometimes closes by itself, this is probably why.
:::

Android 12 added the "phantom process killer". It stops apps that start more than 32 child processes, or that use a lot of CPU in the background. A Linux desktop easily starts more than 32 processes, so without this change Android may **suddenly shut down** Local Desktop (and Termux has the same problem).

### On Samsung, Pixel and most other phones with Android 14 or newer

1. Turn on **Developer options**: go to **Settings** > **About phone** and tap **Build number** 7 times.
2. In **Settings** > **Developer options**, find **Disable child process restrictions** and turn it on.

![Tap Build number 7 times in About phone](/img/developer-options-step-1.webp#step) ![Turn on Disable child process restrictions in Developer options](/img/developer-options-step-2.webp#step)

### On other phones

If your phone doesn't have that switch, you can turn the limit off with [adb](https://developer.android.com/tools/adb) from a computer (or from another phone with wireless debugging):

```bash
adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
adb shell settings put global settings_enable_monitor_phantom_procs false
```

These settings stay after a reboot. You only need to do this once.

## Where to go next

- [Using the desktop](/docs/user/using-the-desktop): touch gestures, the keyboard, sound and rotation.
- [Installing apps](/docs/user/installing-apps): pacman, the AUR, and why some apps are missing.
- [Changing settings](/docs/user/changing-settings): what you can change, and how to fix a black screen.
- [Sharing files with Android](/docs/user/sharing-files-with-android): your photos, downloads and documents, inside Linux.
- [App guides](/docs/user/app-compatibility/firefox): tips for Firefox, Chromium, LibreOffice, GIMP and more.
- [Troubleshooting](/docs/user/troubleshooting): if something doesn't work.

## What didn't work?

We are still working hard on the app. If you find a bug, please open an issue on [GitHub](https://github.com/localdesktop/localdesktop.github.io/issues) with your phone model and Android version. And if you like Local Desktop, please star the project to show your support, it keeps us motivated 🙏
