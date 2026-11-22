---
title: Firefox
description: Firefox comes preinstalled in Local Desktop. What works, which settings Local Desktop changes and why, and what that means for security.
---

Firefox works well on Local Desktop, and it comes preinstalled. It's the real desktop Firefox, not the Android one, so you get the full developer tools, desktop extensions and desktop websites. It's one of the easiest ways to use browser DevTools on your phone.

![Firefox on Local Desktop](/img/firefox.webp)

Open it from the panel, or from **Applications** > **Internet** > **Firefox**. To update it with the rest of the system:

```bash
pacman -Syu
```

## What works

- Websites, extensions, developer tools and responsive design mode.
- Video and audio, including YouTube. Sound goes to your phone's speaker or headphones.
- WebGL and GPU rendering, on phones with [Using the GPU](/docs/user/using-the-gpu). On other phones, Firefox renders on the CPU, which is fine for most websites but slower for 3D.
- Files you download go to `~/Downloads`. To save them to your phone instead, use your [Android storage](/docs/user/sharing-files-with-android), for example `/android/Download`.

## Compatibility note

Firefox runs each website in a separate, locked-down process (a "sandbox"), and plays audio in another one. Both sandboxes use Linux kernel features that Android doesn't give to apps, and that PRoot can't fake. With the sandboxes on, tabs crash and there's no sound (see [termux/proot#139](https://github.com/termux/proot/issues/139)).

So, following [@ZhymabekRoman's solution](https://github.com/termux/proot/issues/139#issuecomment-751988264), Local Desktop sets these defaults:

| Setting | Value | Why |
|---|---|---|
| `security.sandbox.content.level` | `0` | Turns off the content sandbox, so tabs don't crash |
| `media.cubeb.sandbox` | `false` | Plays audio outside of the sandbox, so you get sound |
| `media.allow-audio-non-utility` | `true` | Lets audio play outside of Firefox's utility process, so you get sound |
| `media.rdd-process.enabled` | `false` | Decodes video without the separate media process, which can't start in PRoot, so videos play |

They are applied with [Firefox AutoConfig](https://support.mozilla.org/en-US/kb/customizing-firefox-using-autoconfig), through `/usr/lib/firefox/localdesktop.cfg`. Local Desktop writes that file again each time it starts, so the settings survive Firefox updates. Local Desktop also hides the "content sandbox disabled" warning, since there's nothing you can do about it.

These are defaults, not locked settings, so you can change any of them in `about:config`, though tabs may crash if you do.

## What this means for security

A sandbox is a second wall. If a malicious website found a bug in Firefox, the sandbox would stop it from reaching the rest of the system. Without it, that bug could reach everything Firefox can reach.

In Local Desktop, "everything" is still limited. It's your Linux files, and your Android storage if you gave Local Desktop [access to it](/docs/user/sharing-files-with-android), but not your other Android apps, which Android keeps separate. Still, a few habits are a good idea:

- Keep Firefox up to date with `pacman -Syu`. Security fixes matter more without a sandbox.
- Use Local Desktop's Firefox for development and normal browsing, and your Android browser for banking and other sensitive accounts.
- Install extensions only from [addons.mozilla.org](https://addons.mozilla.org/).
- Run Firefox as a [normal user](/docs/user/creating-a-normal-user) instead of root, so a bad website can't change system files.
