---
title: Getting Started
---

Welcome to Local Desktop!

If you are seeing this page, the application is performing several tasks in the background:

- It is extracting an Arch Linux ARM64 filesystem.
- It is installing Xfce4 and other important packages.

You can click the progress bar to show/hide the log panel. This process can take up to 10 minutes. In the meantime, let's spend your precious time to understand some important concepts.

You can always revisit this page by going to [localdesktop.github.io](/).

:::info Tips
It is highly recommended that you keep the app open in the foreground until the installation is complete.
:::

## How to install applications?

Local Desktop ships Arch Linux to you. Installing applications is actually easier than on other distros:

```
pacman -S firefox
```

The command above will install Firefox.

```
pacman -Ss chrom
```

The command above will search for applications that contain the word `chrom`. You will find Chromium in the list, but not Google Chrome. Why?

Google Chrome, and many other important software that you might need, are proprietary software and are not conveniently available in the pacman-compatible applications.

But you don't need to go to their website looking for `*.installer` files. There is an important concept that makes Arch so beloved: the AUR (Arch User Repository). The concept is that you install an AUR package manager such as `yay` or `paru`, and then you can install any AUR package you want.

```
yay google-chrome
yay visual-studio-code
yay spotify
```

The hardest part is installing `yay` or `paru`. You have to follow the `README.md` on their GitHub repository. It is not that simple, but it is a great exercise for you to learn how to install software from source code in Linux.

## I don't have a physical keyboard.

After Xfce launches, go to _"Applications"_ > _"Accessories"_ > _"Onboard"_. This is an on-screen keyboard. But you are highly recommended to get a physical keyboard.

![Onboard](/img/onboard.webp#boxed)

## Text are too small

Change the _"Window Scaling"_ setting in _"Applications"_ > _"Settings"_ > _"Appearance"_.

![2x Window Scaling](/img/2x-scaling.webp#boxed)

## Disable phantom process killer

:::warning Important
Must read if you’re using Android 12 or newer!
:::

Android's "phantom process killer," introduced in Android 12, limits child processes (default 32) or high CPU usage. Applications like Local Desktop and Termux spawn many child processes, and if you don't disable this feature, you may experience **sudden shutdowns**.

### Samsung devices

Enable the _"Developer options"_ by going to _"Settings"_ > _"About phone"_ > Tap on _"Build number"_ 7 times.

Then search for _"Disable child process restrictions"_ switch and turn it on.

![Disable phantom process killer on Samsung devices](/img/disable-phantom-process-killer-samsung.webp#boxed)

### Other devices

If your device does not support disabling phantom process killer directly from developer options, you must connect to it via [adb](https://developer.android.com/tools/adb) and run the following command:

```bash
adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
adb shell settings put global settings_enable_monitor_phantom_procs false
```

## What didn’t work?

We are still working on the application. If you find any bugs, feel free to open an issue on [GitHub](https://github.com/localdesktop/localdesktop/issues). Please star the project to show your support and keep us motivated to provide quick updates 🙏
