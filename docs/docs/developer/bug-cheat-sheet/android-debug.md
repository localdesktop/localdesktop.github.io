---
title: "Error updating android paths: Cannot determine ndk root"
---

## Issue

When debugging your Android app in Visual Studio Code for the first time, you might encounter this error:

```
Error updating android paths: Cannot determine ndk root

Source: Android Debug
```

## Solution

To resolve this issue, you need to configure the Android NDK (Native Development Kit) root path in VS Code:

1. Open VS Code Settings (<kbd>⌘ + ,</kbd> on Mac, <kbd>Ctrl + ,</kbd> on Windows/Linux)
2. Search for `Android-debug: Ndk Root`
3. Set the path to your Android NDK installation directory

Here's how the setting should look:

![NDK Root Setting](/img/setting-ndk-root-for-android-debug.webp#boxed)

Visit the Android official documentation to learn how to set up NDK on your machine.