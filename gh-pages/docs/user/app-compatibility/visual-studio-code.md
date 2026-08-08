---
title: Visual Studio Code
---

![Visual Studio Code on Local Desktop](/img/vscode.webp)

You can install it from the [AUR](https://aur.archlinux.org/). See [How to install applications?](/docs/user/getting-started#how-to-install-applications) for instructions.

## Compatibility note

- Chromium's sandbox needs Linux user namespaces, which Android does not allow, so VS Code has to run with `--no-sandbox`. Local Desktop applies that for you: `ELECTRON_DISABLE_SANDBOX` is exported for the whole desktop session, and application entries for Chromium-based apps are shadowed with `--no-sandbox` copies in `~/.local/share/applications`. VS Code launches from the XFCE Application launcher and from the terminal with no extra flags. **Termux + proot-distro still requires the flag by hand.**

- Launching as a root user requires the `--user-data-dir` flag. [Why?](https://stackoverflow.com/a/70453798)

However, it is **recommended to use a non-root user** for running Visual Studio Code. See [Creating a Non-root User](/docs/user/2-creating-a-non-root-user.md) for instructions.
