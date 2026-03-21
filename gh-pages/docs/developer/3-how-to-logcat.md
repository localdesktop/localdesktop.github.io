---
title: How to logcat
---

When Local Desktop fails to start or crashes, we need the logs to trace the cause. Please help us gather the logs using one of the following methods:

## Via ADB

### Setup

ADB is a **command-line tool** that can do many things when an Android device is connected to the computer via a USB cable. It can, for example, install and uninstall apps, copy files, grant special permissions, and capture logcat. You can download it from [Android Developers official website](https://developer.android.com/tools/adb) or by using your package manager:

```
# Arch Linux
sudo pacman -S android-tools

# Ubuntu
sudo apt-get install android-tools-adb

# macOS
brew install android-platform-tools

# Windows
choco install android-platform-tools
```

Then connect your phone to your PC using a USB cable. The result of running `adb devices` should be like this:

```sh
~ adb devices
List of devices attached
RFCRC1S76SH	device
```

Common issues:
- Device not shown: You must also enable **"USB debugging"** on your phone. Please go to **"Settings"** > **"Developer options"** > **"USB debugging"** and turn it on. If **"Developer options"** is not visible, go to **"Settings"** > **"About phone"** > **"Build number"** and tap it 7 times.
- `command not found: adb`: Make sure that you have set up the *environment variables* correctly so that your terminal can find the `adb` command.

### Logcat

Run the following command to capture logcat output:

```
adb logcat -e app.polarbear
```

- The command above will keep waiting for new logcat entries in real-time. You can stop watching by pressing `Ctrl + C`.
- You can run `adb logcat -c` to clear old logcat entries so that you can start fresh.
- To automatically save logcat output to a file so that you can share it with us, use the `>` operator:

```
adb logcat -e app.polarbear > logcat.txt
```

## Via Logcat Reader

### Setup

Logcat Reader is an Android app that can capture logcat directly from your phone. You can download it from [Google Play](https://play.google.com/store/apps/details?id=com.dp.logcatapp).

:::info
You still need to connect your phone to your PC **one time** initially to enable the app to capture logcat output. The app will show you instructions on how to do this on first launch.
:::

Click on the **3 dots menu** > **"Filters"** > **"+"** > and set `app.polarbear` as the **"Package name"**.

![Filter logcat](/img/logcat-filter.webp#boxed)

### Logcat

Please follow these steps to start capturing logcat:

1. Launch **Logcat Reader**, (optionally) clear the current logcat output to start fresh. Then click the **circle icon** to start capturing.

  ![Start Capture](/img/logcat-start-capturing.webp#boxed)

2. Exit **Logcat Reader**, then launch **Local Desktop**. Start reproducing the issue.

3. Exit **Local Desktop** (if it hasn't crashed already), then open **Logcat Reader** again. Click the **square icon** to stop capturing, and share the logcat with us.

  ![Share Logcat](/img/logcat-share.webp#boxed)

## How to share

Please share the gathered logcat output along with your GitHub issue. You can either upload it as an attachment or paste the contents directly into the issue description.
