---
title: Android Storage Access
description: Why Local Desktop requests Android's All files access permission
slug: /android-storage-access
---

# Android Storage Access

_Last updated: April 9, 2026_

This page explains why **Local Desktop** requests Android's special
"All files access" permission (`MANAGE_EXTERNAL_STORAGE`) on Android 11 and
later.

## What this permission enables

Local Desktop runs a full desktop Linux environment inside the app's private
storage. When you explicitly enable Android's **All files access** setting for
Local Desktop, the app binds Android shared storage into the Linux environment.

Inside Linux, your Android shared storage becomes available at:

- `/android`
- `~/Android`

This allows Linux applications running inside Local Desktop to:

- Open files that already exist on the Android device
- Save exported files back to Android shared storage
- Work with non-media files such as source code, archives, logs, documents, and
  build outputs
- Use ordinary filesystem paths instead of app-specific import/export flows

## Why privacy-friendlier alternatives are not enough

Local Desktop is not a single-purpose media viewer. It runs a general desktop
Linux userspace where terminal tools, editors, IDEs, browsers, package
managers, and file managers expect normal path-based filesystem access.

For this use case, the usual Android storage alternatives are not equivalent:

- `WRITE_EXTERNAL_STORAGE` does not grant broad shared-storage access for apps
  targeting Android 11 and above.
- Media-only permissions are not enough because Local Desktop must work with
  non-media files too.
- The Storage Access Framework gives URI-based access to selected files or
  folders, not a normal mounted filesystem that unmodified Linux applications
  can traverse.
- On Android 11 and above, the Storage Access Framework cannot grant access to
  shared-storage roots such as the internal storage root, and it places
  important restrictions on directories like `Download`.

## How Local Desktop uses storage access

- The permission is **optional**. Local Desktop still runs without it.
- Without the permission, the Linux environment remains limited to app-private
  storage and cannot directly access Android shared storage.
- The permission is only used after the user explicitly enables it in Android
  Settings under **Special app access**.
- Local Desktop does not use this permission for advertising, analytics,
  profiling, or background file collection.
- Local Desktop does not automatically upload storage contents off-device.
- File access happens locally on the device in response to the user's actions
  inside the Linux session.

## User flow

1. The user installs Local Desktop.
2. The user opens the Android storage sharing feature.
3. The user explicitly enables **All files access** in Android Settings.
4. Local Desktop binds Android shared storage into the Linux environment.
5. Linux apps can then open and save user files through `/android` or
   `~/Android`.

## Privacy notes

- Local Desktop itself does not continuously scan or index all files in shared
  storage.
- Files remain on-device unless the user chooses to move, sync, or upload them
  using software they run inside Local Desktop.
- For more details, see the [Privacy Policy](/privacy).

## Screenshots

![Enable All files access](/img/storage-setup.webp)

![Android shared storage inside Linux](/img/storage-usage.webp)
