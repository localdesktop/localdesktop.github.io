---
title: Maintainer tools (VS Code extension)
sidebar_position: 10
---

The **Local Desktop Dev** extension brings the whole develop → debug → release loop into VS Code (and Cursor, VSCodium, …). Install it from [Open VSX](https://open-vsx.org/extension/mister-teddy/localdesktop-dev): Cursor, VSCodium and Windsurf find it by searching for "Local Desktop Dev". In VS Code, download the `.vsix` from that page and use **Extensions › … › Install from VSIX**. Then open this repository.

Everything lives in the **Local Desktop** icon on the activity bar.

## Devices

- USB devices show up automatically. For Wi‑Fi, click **Pair over Wi‑Fi (QR code)** and scan it from **Developer options → Wireless debugging → Pair device with QR code**.
- The device in the status bar is the one used by F5, the commands and the agent tools. Click it to switch.
- **Run environment check** (`Local Desktop: Check Environment`) tells you what's missing from the toolchain.

Debugging with F5 is described in [How to develop locally?](4-how-to-dev.md).

## Releases & CI

- See the latest release, its downloads, and whether the Google Play upload succeeded.
- The 🚀 button builds a signed APK on GitHub Actions for the current branch, then offers to install it on your device. Push your branch first.
- For your branch's pull request you can set the `release:*` label (it shows the version it will produce) and edit the release notes, which are the PR description.

## Website

- Browse blog posts and docs, create a post with **New Blog Post**, and preview it live.
- **Publish** opens a pull request with your website changes. Website-only PRs don't need a release label.

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

## Working on the extension

The extension lives in `vscode-extension/` (TypeScript, built with esbuild, tested with vitest).

```sh
cd vscode-extension
pnpm install
pnpm run build      # or `pnpm run watch`
pnpm test           # unit tests, headless
```

To try your changes, open the `vscode-extension/` folder in VS Code and press F5 (**Run Extension**). The Extension Development Host opens the repository root, where the extension does its work.

