---
title: Using an external display
description: Connect your phone to a monitor or TV, and use the Linux desktop on the big screen with your phone as a trackpad, like Samsung DeX.
---

Connect your phone to a monitor or a TV while Local Desktop is open, and the Linux desktop moves to the big screen. Your phone's screen becomes a trackpad, like Samsung DeX. This works on any phone that can send video out, not only on phones with a desktop mode.

![The Linux desktop on an external monitor](/img/external-display-monitor.jpg#boxed)

## What you need

- A phone that supports video output over USB-C (DisplayPort Alt Mode). Most flagship phones do, but many budget and mid-range phones don't. If your phone shows its own screen on the monitor when you plug it in, it works.
- A USB-C to HDMI cable or adapter, a USB-C dock, or a USB-C monitor. A wireless display (Miracast) also works.
- A keyboard and a mouse are optional, but they make a big difference. A USB dock lets you plug in both, and charge the phone at the same time.

## Connect

1. Open Local Desktop on your phone.
2. Plug in the monitor.

The desktop appears on the monitor, at the monitor's resolution, and you will see **"The desktop is on the external display. Use this screen as a trackpad."** on your phone. Unplug the monitor, and the desktop comes back to the phone screen.

The desktop also scales its text and buttons to the monitor's density, so a 4K monitor doesn't give you tiny text.

:::tip Samsung DeX
On Samsung phones, DeX may start instead. Pull down the notification shade and choose **Screen mirroring** instead of DeX, or turn off **Auto start when HDMI is connected** in the DeX settings.
:::

## Trackpad gestures

![The phone as a trackpad, with the Rotate screen and Keyboard buttons](/img/external-display-trackpad.png#boxed)

| Gesture | Does |
|---|---|
| Slide one finger | Move the cursor |
| Tap | Left click |
| Tap with two fingers | Right click |
| Tap with three fingers | Middle click (paste on Linux) |
| Slide two fingers | Scroll |
| Touch and hold, then slide | Drag (hold the left button) |
| Touch and hold, then lift | Right click |

The Local Desktop bear in the top left corner shows which way is up, so you can hold the phone however you like.

## Buttons

Two buttons sit in the top right corner of the trackpad:

- **Rotate screen** turns the trackpad (and the Android keyboard) a quarter turn clockwise. It's useful when you lay the phone sideways on the desk and auto-rotate keeps it upright.
- **Keyboard** opens the Android keyboard on the phone, and what you type goes to the desktop. It also opens by itself when you click a text field on the desktop.

![The Android keyboard on the phone, typing into the desktop on the monitor](/img/external-display-keyboard.png#boxed)

## Mouse, keyboard and touch screen monitors

- A mouse connected to the phone moves the cursor on the monitor, and its buttons and wheel work there.
- A physical keyboard types into the desktop. To get `Alt+Tab` and the `Meta` key, see [Using a physical keyboard](/docs/user/using-a-physical-keyboard).
- If your monitor has a touch screen, or you use a pen on it, touching it clicks where you touch.

## In the background

You can switch to another app on the phone, and the desktop stays on the monitor. Sound keeps playing too. A mouse or keyboard keeps working on the monitor, if Android lets the mouse pointer onto it. Come back to Local Desktop to use the trackpad again.

This makes a nice setup: watch a video or reply to a message on the phone, while a long build runs on the big screen.
