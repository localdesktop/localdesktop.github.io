---
title: Random crashes
sidebar_label: Random crashes
description: How to tell whether Android killed Local Desktop or it really crashed, and the real causes of "random" crashes we have found and fixed so far.
---

## Issue

Local Desktop, or an app inside it, closes without an explainable reason. Sometimes after a few minutes, sometimes only when you open a heavy app, and never in the same place twice.

## First: killed, or crashed?

Most "random crashes" are not crashes at all. Android **killed** the app. The two look the same on screen, but not in the logs:

```sh
node vscode-extension/bin/localdesktop.cjs logcat --since launch --level W
node vscode-extension/bin/localdesktop.cjs crash_report
```

(or `adb logcat`, see [Reading the logs](/docs/developer/reading-the-logs))

- **Killed by Android**: you'll see `ActivityManager` lines like `Killing <pid>:io.github.localdesktop ... excessive cpu` or `phantom process`, and `crash_report` finds nothing. Or the system ran out of memory (`lowmemorykiller`, `lmkd`).
- **Crashed**: `crash_report` shows a native crash (tombstone) with a stack trace, a Java exception, or a Rust panic (`panicked at` in `RustStdoutStderr`).
- **Only the sound stopped**: one of the PipeWire child processes exited. The logcat has a `[PipeWireAAudio]` line that says which one, and why.

## Solution

### When Android killed it

On Android 12 and newer, it's almost always the **phantom process killer**: Android stops apps that have more than 32 child processes, and a Linux desktop has many more than that. [Disable the phantom process killer](/docs/user/getting-started#read-this-if-you-use-android-12-or-newer).

Some brands (Xiaomi, Oppo, OnePlus, Huawei and others) also have their own battery savers that kill apps in the background. Set Local Desktop's battery usage to **Unrestricted** in App info.

### When it really crashed

Search the stack trace or the last log lines in [GitHub issues](https://github.com/localdesktop/localdesktop.github.io/issues?q=is%3Aissue). These are the ones we have found so far, which may give you a hint where to look:

| What you see | Cause | Fixed in |
|---|---|---|
| Node, Electron or VS Code helper processes abort at start | PRoot answered `fstat` on a socket with a `stat` of its `/proc/self/fd` link, which fails | [#353](https://github.com/localdesktop/localdesktop.github.io/pull/353) |
| The app crashes when Android relaunches it | The EGL context wasn't created again after a relaunch | [#208](https://github.com/localdesktop/localdesktop.github.io/pull/208) |
| The on-screen keyboard (Onboard) crashes | `bwrap` needs user namespaces, which Android blocks, so its image loader failed | [#227](https://github.com/localdesktop/localdesktop.github.io/pull/227), see `setup_fake_bwrap` |
| The terminal doesn't start, or arrow keys stop working | `/dev/pts` was bound twice, so PRoot translated PTY ioctls twice | [#225](https://github.com/localdesktop/localdesktop.github.io/pull/225) |
| The installer page crashes | A WebView crash during setup | [#264](https://github.com/localdesktop/localdesktop.github.io/pull/264) |
| "Device Unsupported" on a phone that should work | PRoot was built for API 21, without `process_vm_readv` | [#331](https://github.com/localdesktop/localdesktop.github.io/pull/331), see [Device unsupported](/docs/developer/bug-cheat-sheet/device-unsupported) |

A pattern you'll notice: most of them are a Linux feature that Android blocks for apps (user namespaces, some `ptrace` reads, `/dev` details), and that PRoot or a shim has to fake. When a program crashes only in Local Desktop and works on a PC, look for that first: run the program from the terminal, and look for `Operation not permitted`, `Function not implemented` or `Bad address` in the last lines it prints.

If you find a new one, please add it to this table.
