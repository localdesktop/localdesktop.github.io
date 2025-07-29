---
title: Google just sherlocked us! But we are delighted
authors:
  - name: Mister Teddy
    title: Creator & Maintainer of Local Desktop
    url: https://mister-teddy.github.io
    image_url: https://avatars2.githubusercontent.com/u/29925961
tags: [for-user, android, linux, sherlocked, local-desktop]
---

According to [Android Authority](https://www.androidauthority.com/linux-terminal-graphical-apps-3580905/), **Android Canary 2507 now supports native GUI Linux apps**.

After installing the July 2025 Canary build, a new icon appears in the Linux Terminal app that opens a display activity. Inside it, running `weston` launches a full Wayland-based Linux desktop session. It even has GPU acceleration and audio support 🤯

![Android with Linux GUI apps](https://www.androidauthority.com/wp-content/uploads/2025/07/Running-GEdit-in-July-2025-Android-Canary-build-1000w-625h.jpg.webp)

This is exactly, and **technically**, what we're building. I believe we had the same approach: Wayland, as I haven't checked the code, but the fact that they shipped `weston` says everything.

In some way, we just got sherlocked, since people are less likely to pick a third-party app if there's a built-in alternative (at least that's what I would do). However, as an Android user, I'm actually delighted. It's a win-win situation: this validates what we've believed all along, **Android devices can be more than phones**. With official support, **more people will explore desktop-style workflows, and more manufacturers will build hardware to support them**.

This built-in feature will likely be available starting from Android 16, but **Local Desktop** will continue to do its best to support all devices from Android 5 and beyond. We've always been about unlocking possibilities *before* they go mainstream - and we're not stopping now.

Please star our [GitHub repository](https://github.com/localdesktop/localdesktop) and follow our adventure 🐻‍❄️
