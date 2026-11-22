---
title: GIMP
description: Install GIMP in Local Desktop, open photos from your phone's camera, and use it comfortably with a mouse, a pen or touch.
---

GIMP works great on Local Desktop. It's the full desktop version, with layers, masks, curves, plug-ins and support for every common image format, on your phone or tablet.

![GIMP on Local Desktop](/img/gimp.webp#boxed)

## Install

```bash
pacman -S gimp
```

Then open it from **Applications** > **Graphics** > **GNU Image Manipulation Program**.

The first start takes a little longer, because GIMP looks for fonts and plug-ins. It's faster after that.

## Open photos from your phone

Give Local Desktop [access to your Android storage](/docs/user/sharing-files-with-android) first. Then, in **File** > **Open**, type `/android/DCIM/Camera/` (or press `Ctrl+L` and paste it) to see your camera photos. Screenshots are usually in `/android/Pictures/Screenshots/` or `/android/DCIM/Screenshots/`, depending on the phone.

To save your work back to the phone, use **File** > **Export As** and choose a folder under `/android`, such as `/android/Pictures`. **Save** writes GIMP's own `.xcf` format, which keeps your layers, but only GIMP can open it.

## Tips

- **Use a mouse or a pen.** GIMP has a lot of small buttons. A Bluetooth mouse, or a stylus on a tablet, makes it much more comfortable than a finger.
- **Use a big screen.** On an [external display](/docs/user/using-an-external-display), GIMP feels like it does on a PC.
- **Single-window mode** keeps all the panels in one window, which works better on a small screen. Turn it on in **Windows** > **Single-Window Mode**.
- **Hide the panels** with `Tab` to get more room for the image, and press `Tab` again to bring them back.
- **Right click** (touch and hold, then lift) on the image opens GIMP's full menu, which is handy when the menu bar is hard to reach.
- **Big images** use a lot of memory. If GIMP or Local Desktop closes while you edit a very large photo, scale it down first with **Image** > **Scale Image**.
