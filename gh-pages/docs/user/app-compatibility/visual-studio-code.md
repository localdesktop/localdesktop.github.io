---
title: Visual Studio Code
description: Install Visual Studio Code in Local Desktop from the AUR, and how Local Desktop handles the Chromium sandbox for Electron apps.
---

![Visual Studio Code on Local Desktop](/img/vscode.webp)

The real Visual Studio Code runs on Local Desktop, with extensions, the integrated terminal and Git. Together with a physical keyboard, it turns a phone or a tablet into a small development machine.

## Install

VS Code is not in the official Arch Linux repositories, so you install it from the [AUR](https://aur.archlinux.org/). You need a [normal user](/docs/user/creating-a-normal-user) and an AUR helper first. See [Installing apps](/docs/user/installing-apps).

Then, as your normal user:

```bash
yay -S visual-studio-code-bin
```

Use the `-bin` package. It installs Microsoft's ready-made ARM64 build in a minute, instead of building VS Code from source, which takes hours on a phone and may run out of memory.

## Compatibility note

VS Code is built on Electron, which is built on Chromium. Chromium protects itself with a sandbox that needs Linux user namespaces, and Android doesn't let apps use those. So VS Code, and every other Electron or Chromium-based app, has to run with `--no-sandbox`.

Local Desktop does this for you:

- It sets `ELECTRON_DISABLE_SANDBOX=1` for the whole desktop session, so Electron apps started from the terminal add `--no-sandbox` by themselves.
- For apps in the Applications menu, it makes a copy of their menu entry with `--no-sandbox`, in `~/.local/share/applications`. This happens each time the Xfce session starts, so an app you just installed gets its copy after you [restart Local Desktop](/docs/user/changing-settings#restart-local-desktop). Menu entries you edited yourself are left alone.
- A `chromium` command in `/usr/local/bin` adds `--no-sandbox` to Chromium.

So VS Code opens from the menu and from the terminal, with no extra flags. If you use Termux + proot-distro instead, you still need to add the flag by hand.

If you run VS Code as `root`, it also needs `--user-data-dir`. [Why?](https://stackoverflow.com/a/70453798) That's one more reason to use a normal user.

## Tips

- Language servers, `node` and the integrated terminal start their helper processes like on a PC.
- Your Linux home folder is the best place for projects. Projects in your [Android storage](/docs/user/sharing-files-with-android) work, but Git and `npm install` are a lot slower there.
- VS Code is heavy. Keep an eye on memory, and close other big apps (like Firefox with many tabs) on phones with 8 GB of RAM or less.
