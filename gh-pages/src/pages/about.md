---
title: About Local Desktop
description: Who builds Local Desktop, why it exists, and how the project is run.
---

# About Local Desktop

Local Desktop is a free and open-source Android app that runs a full Linux desktop on phones and tablets without root. It installs Arch Linux ARM inside the app's own storage, starts it with proot, and shows the desktop through a Wayland compositor written in Rust.

## Why we build it

Android devices are now powerful enough for desktop work. Tablets ship with keyboards, phones can drive external monitors, and Android itself is gaining a desktop mode. What is missing is desktop software: a real browser with developer tools, a code editor, an image editor, a terminal with a full package manager.

Linux already has all of that. Local Desktop brings it to Android in a way that anyone can install from a single APK, without unlocking the bootloader, rooting the device or wiring several apps together.

## Who we are

The project was started at the end of 2024 by [Mister Teddy](https://mister-teddy.github.io), who still maintains it. With help from contributors, it has since gained GPU acceleration, external display support, audio, better keyboard support and much more documentation. You can see everyone who has contributed on the [GitHub contributors page](https://github.com/localdesktop/localdesktop.github.io/graphs/contributors).

## How the project is run

- **Open source.** All of the app's code, its patches to upstream projects and this website live in one [public repository](https://github.com/localdesktop/localdesktop.github.io).
- **Free.** The app costs nothing. Development is supported by [donations and sponsors](/support-us).
- **Private by default.** The app does not ask for personal information. Crash reports are used only to fix bugs, as described in the [privacy policy](/privacy).

## What this website covers

- The [User Manual](/docs/user/getting-started) explains how to install software, configure the desktop, use a keyboard, mouse or external display, and enable GPU acceleration.
- The [Developer Manual](/docs/developer/how-to-build) explains how to build the app, how its parts fit together, and how to debug it.
- The [News](/blog) section has release notes, technical deep dives and community milestones.

## Get in touch

Questions, bug reports and partnership requests are welcome. See the [contact page](/contact).
