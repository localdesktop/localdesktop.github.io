---
title: Google Play storage review
---

Use this page when updating the Google Play declaration for
`MANAGE_EXTERNAL_STORAGE`.

## Public URLs to provide

- Privacy policy: `https://localdesktop.github.io/privacy`
- Storage access explanation: `https://localdesktop.github.io/android-storage-access`
- User documentation: `https://localdesktop.github.io/docs/user/android-storage`

## Short product summary

Local Desktop runs a desktop Linux environment on Android. When the user
explicitly enables Android's "All files access" setting, Local Desktop binds
shared Android storage into the Linux environment so unmodified Linux desktop
apps can open, edit, import, and export user files through normal filesystem
paths.

## Copy-ready declaration text

### Why the permission is needed

Local Desktop runs a general desktop Linux environment on Android. The app uses
`MANAGE_EXTERNAL_STORAGE` only for the optional feature that exposes Android
shared storage inside Linux at `/android` and `~/Android`.

This is required so unmodified Linux applications such as terminals, editors,
file managers, IDEs, browsers, and build tools can open and save user-owned
files through ordinary filesystem paths. The app needs access to non-media files
such as source trees, archives, logs, build outputs, and documents, not only
photos or videos.

### Why Storage Access Framework is not sufficient

The Storage Access Framework provides URI-based access to user-selected files or
folders, not a normal mounted filesystem that unmodified Linux applications can
traverse. Local Desktop runs a full Linux userspace whose applications expect
path-based access across many tools and processes.

In addition, Android 11 and above restrict Storage Access Framework access to
shared-storage roots and important directories such as `Download`, so it cannot
provide an equivalent `/sdcard`-style mount for the Linux environment.

### What happens without the permission

The app still launches without the permission, but the Linux environment is then
limited to app-private storage and cannot directly access user files already
stored in Android shared storage. This breaks the Android-to-Linux file-sharing
feature and prevents common workflows such as opening downloads, editing source
trees, exporting built artifacts, and accessing user documents from Linux apps.

### How the app handles user data

Local Desktop does not use this permission for advertising, analytics,
profiling, or background file collection. The permission is used locally on the
device, after explicit user action, to bind Android shared storage into the
Linux environment. Files remain on-device unless the user chooses to move or
upload them using software they run inside Local Desktop.

## Reviewer checklist

- Confirm the app still declares `android.permission.MANAGE_EXTERNAL_STORAGE` in
  `manifest.yaml`.
- Confirm the permission gates the Android shared-storage bind in
  `src/android/proot/process.rs`.
- Use these screenshots in the declaration if requested:
  - `gh-pages/static/img/storage-setup.webp`
  - `gh-pages/static/img/storage-usage.webp`
- Make sure the privacy policy and support URLs above are live before
  submitting the review.
