---
title: Using the maintainer tools
description: The Local Desktop Dev editor extension, its device tools for coding agents, and the command-line version of the same tools.
---

The **Local Desktop Dev** extension brings the whole develop → debug → release loop into VS Code (and Cursor, VSCodium, …). Install it from [Open VSX](https://open-vsx.org/extension/mister-teddy/localdesktop-dev): Cursor, VSCodium and Windsurf find it by searching for "Local Desktop Dev". In VS Code, download the `.vsix` from that page and use **Extensions › … › Install from VSIX**. Then open this repository.

Everything lives in the **Local Desktop** icon on the activity bar.

## Devices

- USB devices show up automatically. For Wi‑Fi, click **Pair over Wi‑Fi (QR code)** and scan it from **Developer options → Wireless debugging → Pair device with QR code**.
- The device in the status bar is the one used by F5, the commands and the agent tools. Click it to switch.
- **Run environment check** (`Local Desktop: Check Environment`) tells you what's missing from the toolchain.
- **Take Screenshot**, **Mirror Screen (scrcpy)**, **Start App**, **Stop App** and **Restart App** are one click away, so you rarely need to touch the phone.
- **Build Debug APK**, **Build Release APK** and **Install APK on Device…** build and install without starting a debug session. **Install Patched xbuild** reinstalls `x` after a change in `patches/xbuild`.

Debugging with F5 is described in [Running and debugging](/docs/developer/running-and-debugging).

## Releases & CI

- See the latest release, its downloads, and whether the Google Play upload succeeded.
- The 🚀 button builds a signed APK on GitHub Actions for the current branch, then offers to install it on your device. Push your branch first. **Build APK on CI (Options)…** also lets you build a debug APK or an AAB.
- **Upload to Google Play (alpha)…** sends a release's AAB to the Google Play closed testing track.
- For your branch's pull request you can set the `release:*` label (it shows the version it will produce) and edit the release notes, which are the PR description.

## Website

- Browse blog posts and docs, create a post with **New Blog Post**, a page with **New Doc Page**, and preview it live. **Add Image to Post…** adds a picture to the page you're editing.
- **Build Website (Check Links)** runs a full build, which fails on broken links. Run it before you publish.
- **Publish** opens a pull request with your website changes. Website-only PRs don't need a release label. Maintainers can also **Deploy Website Now** without waiting for a merge.

## Chat

A lightweight maintainer chat built on GitHub Discussions in this repository, so everyone already has an account.

- Channels marked 🔒 **private** are encrypted on GitHub, so they aren't readable on github.com. Anyone with the extension can read and post in them: this keeps casual readers out, it isn't secret. Who posted and when is public.
- Channels marked 🌐 **public** are ordinary discussion comments that anyone can read.
- A message posted from github.com into a private channel is shown with an "Unencrypted" badge.

### One-time setup (admins)

1. Run **Local Desktop: Set Up Maintainer Chat…** and follow the steps. It enables Discussions, asks you to create the "Chat" category (GitHub has no API for that), and creates the first channel.
2. Run **Local Desktop: Set Up Realtime Updates (Webhook)…**. It creates a repository webhook that pings an [ntfy](https://ntfy.sh) topic, so chat and CI updates arrive within seconds instead of on the next poll. You can subscribe to the same topic in the ntfy phone app for push notifications.

## Forks

The extension works in forks of Local Desktop (for example [elementary-mobile](https://github.com/localdesktop/elementary-mobile)): it reads the package name and build setup from the fork. Releases & CI and Website use the repository of your `origin` remote (set `localdesktop.repository` to override), and actions whose workflow the fork doesn't have are hidden. Chat always uses the main Local Desktop repository, so there is one team chat.

## Coding agents

The extension ships an MCP server and a CLI that let coding agents use the device: read logs, get crash reports, take screenshots, tap and type, and record and analyse audio. Claude Code and Cursor pick it up from `.mcp.json` / `.cursor/mcp.json` in this repository. For other agents, run **Local Desktop: Set Up Agent Tools (MCP)…**. See [AGENTS.md](https://github.com/localdesktop/localdesktop.github.io/blob/main/AGENTS.md) for the tool list.

The same tools work from a shell, without an editor or an agent:

```sh
node vscode-extension/bin/localdesktop.cjs help                        # every command and its options
node vscode-extension/bin/localdesktop.cjs app_start --restart
node vscode-extension/bin/localdesktop.cjs logcat --since launch --level W
node vscode-extension/bin/localdesktop.cjs screenshot
node vscode-extension/bin/localdesktop.cjs tap --x 300 --y 500
```

Add `--json` for machine-readable output. They need either the extension installed, or `pnpm -C vscode-extension install && pnpm -C vscode-extension run build`. The device is chosen from `--serial`, then `$ANDROID_SERIAL`, then the device selected in the editor, then the only connected device.

## Working on the extension

The extension lives in `vscode-extension/` (TypeScript, built with esbuild, tested with vitest).

```sh
cd vscode-extension
pnpm install
pnpm run build      # or `pnpm run watch`
pnpm test           # unit tests, headless
pnpm run typecheck
pnpm run lint
```

The `vscode-extension.yml` workflow checks every pull request that touches `vscode-extension/`, and publishes to Open VSX when such a change lands on `main`.

To try your changes, open the `vscode-extension/` folder in VS Code and press F5 (**Run Extension**). The Extension Development Host opens the repository root, where the extension does its work.

