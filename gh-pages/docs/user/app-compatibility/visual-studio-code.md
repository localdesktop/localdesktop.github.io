---
title: Visual Studio Code
---

:::info

Visual Studio Code must be launched from the command line as follows:

```bash
code --no-sandbox
```

:::

![Visual Studio Code on Local Desktop](/img/vscode.webp)

You can install it from the [AUR](https://aur.archlinux.org/). See [How to install applications?](/docs/user/getting-started#how-to-install-applications) for instructions.

## Compatibility note

- VS Code **won't** launch from the XFCE Application launcher, you have to launch it from the terminal with an additional flag `--no-sandbox`. **It is an issue that persists with Termux + proot-distro.**

- Launching as a root user requires the `--user-data-dir` flag. [Why?](https://stackoverflow.com/a/70453798)

However, it is **recommended to use a non-root user** for running Visual Studio Code. See [Creating a Non-root User](/docs/user/2-creating-a-non-root-user.md) for instructions.
