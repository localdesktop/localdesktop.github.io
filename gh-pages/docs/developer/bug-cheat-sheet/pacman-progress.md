---
title: "Why stdbuf -oL pacman -S --noprogressbar?"
sidebar_label: pacman and stdbuf
description: Why Local Desktop runs pacman with stdbuf -oL and --noprogressbar, so the installer log updates line by line instead of getting stuck.
---

## Issue

When running `pacman` commands in non-interactive environments, you might notice that the progress output appears to be stuck or delayed. This happens because:

1. The progress bar is not visible in non-interactive shells
2. With `--noprogressbar` flag, `pacman` skip the progress bar and append logs into stdout. However, it did **not flush the buffer frequent enough**.

**Result**: Output buffering causes progress updates to be delayed and then truncated.

## Solution

Use `stdbuf -oL` before the `pacman` command to force line buffering. The `-oL` flag tells `stdbuf` to use line buffering for stdout, which means each line of output will be flushed immediately.

```bash
stdbuf -oL pacman -S --noprogressbar
```
