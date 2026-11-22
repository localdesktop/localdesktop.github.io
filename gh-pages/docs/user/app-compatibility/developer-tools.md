---
title: Developer tools
description: Code on your Android phone or tablet with Local Desktop. Set up Git, SSH, Python, Node.js and C/C++ compilers, and what to expect from running a dev environment under proot.
---

Local Desktop is a real Linux system, so the usual developer tools work the way they do on a PC: the same packages, the same commands, the same config files. With a keyboard and an external monitor, a phone becomes a small but complete development machine.

## Install the basics

```bash
pacman -Syu --needed git openssh base-devel
```

- `git` and `openssh` for your repositories and remote servers.
- `base-devel` brings `gcc`, `make` and the other tools you need to compile C and C++, and to build packages from the [AUR](/docs/user/installing-apps#the-aur).

Then pick what you work with:

| Language | Install | Notes |
|---|---|---|
| Python | `pacman -Syu python python-pip` | Use a virtual environment for project packages: `python -m venv .venv` |
| Node.js | `pacman -Syu nodejs npm` | `pnpm` and `yarn` are packages too |
| Go | `pacman -Syu go` | |
| Rust | `pacman -Syu rustup`, then `rustup default stable` | |
| Java | `pacman -Syu jdk-openjdk` | |

For an editor, see [Visual Studio Code](/docs/user/app-compatibility/visual-studio-code). Terminal editors like `vim`, `neovim` and `nano` are in pacman too.

## Set up Git and SSH

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
ssh-keygen -t ed25519
cat ~/.ssh/id_ed25519.pub
```

Add the printed public key to GitHub (**Settings** > **SSH and GPG keys**) or to your server's `~/.ssh/authorized_keys`, and `git clone git@github.com:...` works like on any computer.

## Keep your projects in your home folder

Your home folder (`/root`, or `/home/<user>` for a [normal user](/docs/user/creating-a-normal-user)) lives inside Local Desktop's private storage. That's the fastest place for code, and the only place where Linux file permissions work fully, which matters for things like executable scripts and `node_modules/.bin`.

Your [Android storage](/docs/user/sharing-files-with-android) in `/android` is fine for moving files in and out, but don't keep a Git repository there: Android's storage doesn't support Linux permissions or symlinks, so Git and package managers misbehave.

## Run a web server

A development server works as usual:

```bash
python -m http.server 8000
```

Open `http://localhost:8000` in Firefox inside Local Desktop. The port is also open to Android itself, so Chrome on your phone can open the same address.

## What doesn't work

Local Desktop runs Linux with proot, without root on the Android side. A few things a PC can do are not possible:

- **Docker and Podman.** Containers need kernel features (namespaces, cgroups, overlay filesystems) that Android doesn't give to apps.
- **systemd services.** There is no systemd in Local Desktop. Start servers and databases from the terminal instead, for example `postgres -D /var/lib/postgres/data`.
- **Debuggers and tracers** (`gdb`, `strace`). proot runs every program with the same kernel feature that debuggers use (`ptrace`), and a program can't be traced twice. Debug with log output instead, or with your language's own debugger: Python's `pdb` and Node's inspector work, because they run inside the program.
- **Everything is a bit slower.** proot checks every file access, so commands that touch thousands of small files, like `npm install` or `git status` in a big repository, take longer than on a PC with the same processor.
