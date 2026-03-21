---
title: How to develop locally?
---

Recommended setup:

- **IDE**: Visual Studio Code

- **Extensions**:

  - [Rust Analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
  - [Android Debug](https://marketplace.visualstudio.com/items?itemName=nisargjhaveri.android-debug)
  - [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb)

    > **Note**: CodeLLDB v1.11.2 has a bug when launching with Android Debug ([issue link](https://github.com/vadimcn/codelldb/issues/1220)). Please downgrade to v1.11.1 via Extensions tab > CodeLLDB > Install Specific Version... > v1.11.1 to work around the issue.

### How to debug

1. Open Visual Studio Code.
2. Launch the `[Android] Debug` configuration from the debug panel. This will:
   - Build the Rust code into an APK.
   - Install the APK on a selectable device, and launch the app in debug mode.
   - Redirect stdout/stderr output to the terminal.

![Debugging Capability](/img/debugging-capability.webp)

> **Tip**: You can debug the app on either a physical device or a virtual device.

### How to view the error logs

If Local Desktop hangs at launch, stuck on the app icon, it is likely that the native main thread has crashed. To check:

1. Search for `> Tasks: Run Task` in the Command Palette.
2. Run the `[Android] Logcat` task. Then you will see the log:
   ```
   05-24 18:10:04.181 13540 13556 I RustStdoutStderr: thread '<unnamed>' panicked at src/utils/logging.rs:17:14:
   05-24 18:10:04.181 13540 13556 I RustStdoutStderr:
   05-24 18:10:04.181 13540 13556 I RustStdoutStderr: *** *** *** [POLAR BEAR EXPECTATION] *** *** ***
   05-24 18:10:04.181 13540 13556 I RustStdoutStderr: Failed to create EGLContext
   05-24 18:10:04.181 13540 13556 I RustStdoutStderr: *** *** *** [POLAR BEAR EXPECTATION] *** *** ***
   ```

> You can also assign a shortcut to quickly view the log. To do so:
>
> 1. Search for `> Preferences: Open Keyboard Shortcuts (JSON)` in the Command Palette.
> 2. Add this entry to the opened `keybindings.json` file:
>
> ```json
> {
>   "key": "shift+cmd+l",
>   "command": "workbench.action.tasks.runTask",
>   "args": "[Android] Logcat"
> }
> ```
