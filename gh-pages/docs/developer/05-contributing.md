---
title: Contributing
description: How to contribute to Local Desktop, from picking an issue to a merged pull request, and how the release label on your pull request decides the next app version.
---

Local Desktop is open source, and most of what it can do today came from someone who needed it and sent a pull request. You don't need to know Rust or Android to help: the website, the docs, testing on your phone and reporting bugs with a log all count.

## Find something to work on

- **Bugs and ideas** are in [GitHub issues](https://github.com/localdesktop/localdesktop.github.io/issues). Comment on the issue before you start on something big, so two people don't build the same thing.
- **Questions and plans** go to [GitHub Discussions](https://github.com/localdesktop/localdesktop.github.io/discussions).
- **The docs** are in `gh-pages/docs/`. Every page has an **Edit this page** link at the bottom. If something in them was wrong or missing for you, it probably is for others too.

## Make the change

1. Fork the repository, and create a branch from `main`.
2. Build and run the app on your phone, see [Building the app](/docs/developer/building-the-app) and [Running and debugging](/docs/developer/running-and-debugging).
3. Keep the pull request about one thing. A bug fix and a refactor are easier to review, and to revert, as two pull requests.
4. Test it on a real device. Write which phone and Android version you used in the pull request.

## Write the pull request

- **The title** says what changes for the user, in plain words: "Ask before turning on the keyboard shortcuts service", not "refactor accessibility.rs". The title becomes the commit message on `main`.
- **The description** is a short list of what changed, with a link to the issue it fixes. When your pull request makes a release, **the description becomes the release notes** on GitHub, so write it for users.
- **Screenshots or a screen recording** are the fastest way to show a change in the desktop.

## The release label

Every app release is built by GitHub Actions, from the label on the pull request. A pull request to `main` needs exactly one `release:*` label, and the label decides the next version:

| Label | Version bump |
|---|---|
| `release:breaking` | Major |
| `release:feature` | Minor |
| `release:bugfix`, `release:patch`, `release:improvement`, `release:optimisation` | Patch |
| `release:docs` | None, no app release |

Pull requests that only touch the website (`gh-pages/`), the editor extension (`vscode-extension/`), `.vscode/` or the agent config files don't need a label, and never make a release.

A maintainer can set the label for you if you can't.

### What happens after you label it

1. The version is bumped on the pull request branch, and CI builds a signed APK. Download the `.apk` from the Actions run and install it over the version from GitHub Releases: they have the same signature, so your Linux installation stays.
2. When the pull request is merged, a `v*.*.*` tag is pushed. The tag builds the release APK, the AAB for Google Play and the [offline manuals](/docs/developer/building-the-offline-manuals), and creates the GitHub Release with them.
3. The AAB is uploaded to Google Play.

Pull requests labeled `release:docs` don't build an APK.

CI builds with NDK r28, so the native libraries have the 16 KB ELF alignment that Google Play asks for. `scripts/check_elf_alignment.sh` checks it.

## Working with a coding agent

The repository has an `AGENTS.md` for Claude Code, Cursor, Codex and other agents, and an MCP server that lets them build the app, install it, take screenshots, tap and read the logs on your phone. See [Running and debugging](/docs/developer/running-and-debugging#with-a-coding-agent). Review what the agent wrote as carefully as you would review a stranger's pull request, and test it on a device yourself.
