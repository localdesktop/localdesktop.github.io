---
title: Plug in a monitor, and your phone becomes the trackpad 🖥️
description: Local Desktop now moves the Linux desktop to an external monitor and turns your phone into a trackpad, like Samsung DeX.
authors: teddy
tags: [for-user, external-display, trackpad, dex]
image: /img/blog/external-display-monitor.webp
---

A phone screen is a small place for a full Linux desktop. So with Local Desktop 3.1, plug your phone into a monitor or a TV, and the desktop moves to the big screen while the phone in your hand becomes its trackpad. If you have used Samsung DeX, it will feel familiar.

![The Xfce desktop of Local Desktop on a 4K monitor](/img/blog/external-display-monitor.webp#boxed)

<!-- truncate -->

## Plug and go

Connect a USB-C to HDMI cable, a USB-C dock, or a wireless display while Local Desktop is open. That's it: the desktop takes the monitor's resolution and scales its UI to the monitor's density. Unplug, and it comes back to the phone screen.

## A trackpad in your hand

![The phone as a trackpad, with the Local Desktop bear at the top](/img/blog/external-display-trackpad.webp#boxed)

The phone screen turns into a trackpad, with a cross in the middle and the Local Desktop bear at the top, so you always know which way is up.

| Gesture | Does |
|---|---|
| Slide one finger | Move the cursor |
| Tap | Left click |
| Tap with two fingers | Right click |
| Tap with three fingers | Middle click |
| Slide two fingers | Scroll |
| Touch and hold, then slide | Drag |

Two buttons sit in the corner:

- **Rotate** turns the phone's screen a quarter at a time. Lay the phone sideways next to your keyboard, even with auto-rotate off, and the trackpad turns with it.
- **Keyboard** opens the Android keyboard on the phone, and what you type goes to the desktop.

## The keyboard comes when you need it

Click into a text field on the desktop, and the Android keyboard opens on your phone by itself. No more touch keyboard covering half of your monitor. Turn the phone sideways first, and you get the wide landscape keyboard.

![The Android keyboard in landscape, typing into the desktop](/img/blog/external-display-keyboard.webp#boxed)

A Bluetooth or USB keyboard works too, of course.

## Keep using your phone

Switch to another app, and the desktop stays on the monitor. Answer a message, check a map, come back: everything is still where you left it. If Android lets your mouse onto the monitor, it works there while Local Desktop is in the background.

## elementary OS too

[elementary mobile](https://github.com/localdesktop/elementary-mobile), our fork that ships elementary OS, gets the same feature in version 1.1. It also fixes the black screen some Snapdragon phones got, where the window manager kept crashing.

![elementary OS on a 4K monitor, driven by a phone](/img/blog/external-display-elementary.webp#boxed)

## Try it

Update to Local Desktop 3.1, plug in a monitor, and read the [External Display](/docs/user/external-display) guide for the details. If something doesn't work with your phone or monitor, please [open an issue](https://github.com/localdesktop/localdesktop.github.io/issues): every phone handles external displays a little differently, and your report helps us cover them all. Happy hacking on the big screen! 👋
