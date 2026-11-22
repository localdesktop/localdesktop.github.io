---
title: Using the desktop
description: How touch, the keyboard, a mouse, sound, rotation and the clipboard work in Local Desktop on a phone or tablet.
---

Local Desktop gives you a real desktop, made for a mouse and a keyboard, on a touch screen. This page explains how your fingers, your keyboard and your phone's other features map to it.

## Touch gestures

Your finger works like a mouse pointer that jumps to wherever you touch.

| Gesture | Does |
|---|---|
| Tap | Left click |
| Slide one or two fingers | Scroll |
| Touch and hold, then lift | Right click (opens context menus) |
| Touch and hold, then slide | Drag: move a window, select text, drag a file |

A slide is a scroll and not a drag on purpose, so that you can scroll long pages and menus like on Android. To move a window, touch and hold its title bar for about half a second (the same as a long press on Android), then slide.

## Mouse and touchpad

Plug in a USB mouse or pair a Bluetooth one, and it works as a normal mouse: the cursor follows it, and the left, right and middle buttons and the wheel all work. This is the most comfortable way to use apps with small buttons, like GIMP.

## Keyboard

### The Android keyboard

When you tap a text field, your phone's own keyboard comes up, and the desktop shrinks to fit above it (on Android 11 or newer). Swipe back or press the back button to put it away. The next tap on a text field brings it back.

The keyboard types directly into Linux apps, with suggestions and autocorrect turned off, since those don't make sense in a terminal.

### Squeekboard, the desktop's keyboard

If you prefer a keyboard that looks like a PC keyboard, with `Ctrl`, `Alt`, `Tab` and arrow keys, turn off **Use the Android keyboard** in [Changing settings](/docs/user/changing-settings). Local Desktop then uses Squeekboard, an on-screen keyboard made for Linux phones.

Some older apps (the ones that run through Xwayland) don't ask for a keyboard on their own. For those, open **Applications** > **Accessories** > **On-screen keyboard**.

### A physical keyboard

A USB or Bluetooth keyboard works out of the box, and it's by far the best way to type for a long time. Android keeps a few shortcuts for itself, such as `Alt+Tab` and the `Meta` (Windows) key. If you need those on the desktop, see [Using a physical keyboard](/docs/user/using-a-physical-keyboard).

## Screen size and rotation

The desktop always fills the screen, and follows the phone when you rotate it. On a foldable, it resizes when you unfold.

Local Desktop also picks a scale from your screen's density, the same way Android does, rounded to a whole number (3× on most phones, 2× on most tablets). That way, text and buttons are about the same size as in your Android apps. If you change the scale yourself in Xfce's **Display** settings, it will be reset the next time the screen changes size, for example when you rotate.

## Sound

Sound works with no setup on Android 11 or newer. Linux apps play through PipeWire, and Local Desktop passes it to Android, so it comes out of your speaker, headphones or Bluetooth headset like any other app. Use Android's volume buttons, or the volume control in Linux.

The microphone is not supported yet.

## Copy and paste

Copy and paste work between Linux apps, as on any desktop. The Linux clipboard is not shared with Android yet, so you can't copy a link in Chrome on Android and paste it in Firefox on the desktop. To move text between the two, save it to a file in your [Android storage](/docs/user/sharing-files-with-android).

## When you switch to another app

The screen stays on while Local Desktop is open. When you switch to another app, the desktop stops drawing and the sound pauses, to save battery, but your Linux apps keep running. Come back and everything is where you left it.

Android can still close Local Desktop if it needs the memory, or because of the phantom process killer on Android 12 and newer. See [Read this if you use Android 12 or newer](/docs/user/getting-started#read-this-if-you-use-android-12-or-newer).

If you connect a monitor, the desktop stays on it when you switch apps on the phone. See [Using an external display](/docs/user/using-an-external-display).
