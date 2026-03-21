---
title: How it works
---

1. An Arch Linux ARM64 filesystem is set up inside the app's internal storage.
2. Proot mounts the filesystem and provides a chroot-like environment.
3. A minimal built-in Wayland compositor runs in Android NDK.
4. Rootful Xwayland & a desktop environment launches inside the chroot and renders back to the Android native activity.

## Proot

### How much Linux is Android?

You must have heard somewhere that Android are actually Linux. How true is that?

Android has a Linux kernel, and that's it.

What does that mean to have a Linux kernel? It means that Android uses the same core system responsible for process management, memory handling, and actually more than that but that's not important for us. But beyond that, Android is a completely different operating system. It does not have the same file system, the same libraries, and the same system calls. What's more, it does not even have the same graphical technology stack.

### Two problems to tackle

As explained, in order to make Android run (shell) Linux applications, we need to provide a similar environment, that is, the same file system, the same libraries, and the same system calls.

And in order to run GUI applications, we need to provide a similar graphical technology stack.

### Chroot

You might have heard of docker, it is all over the place nowadays. You can think of `chroot` as a simplified version of docker which you don't ever need to install because it is part of every Linux distribution.

`chroot` is a Linux command that changes the root directory of the current process and its children. If you are running Ubuntu, and you `chroot` into an Arch Linux filesystem, then you are actually running Arch Linux.

### Proot

So the same concept can apply to Android, right? We can setup an Arch Linux filesystem inside Android, and then `chroot` into it. Unfortunately, `chroot` requires root access, that means you must root your Android device. It is not only inconvenient, but also dangerous. There is another option, and that is `proot`.

Now you might got the idea of what `proot` is. It is a tool that allows you to run Linux in a chroot-like environment without root access.

### Wrapping it up

The magic behind Local Desktop is that:

- It scaffolds an Arch Linux filesystem inside the app's internal storage.
- It `proot` into the filesystem, so that you can have the same file system, the same libraries, and the same system calls. And with the already Linux Kernel that Android has, you can run Linux applications.

How about the magic behind GUI applications?

## Wayland

### Display Server

You may be surprise that to display some pixels from your application, say, Firefox, to your screen, Linux implement a client-server protocol. In this model, Firefox is the client and the display server is the server (obviously).

Not all operating systems use a display server. Windows uses a monolithic graphics architecture where the windowing system, input handling, and rendering are all tightly integrated into the operating system.

### X11 and Xorg

If you have used Linux for a while, you must have seen the word X11 or Xorg. X11 is the original protocol for the display server. Xorg is a display server that implements the X11 protocol.

:::note
Remember, X11 is a protocol, Xorg is a display server. Although they are often used interchangeably, they are not the same thing.
:::

### Wayland

Wayland is a modern display server protocol that is designed to replace X11. And Local Desktop follows this trend. This approach has some advantages:

- Wayland servers, more frequently called **compositors**, are much more efficient than X11 servers.
- By implementing a minimal Wayland compositor, we can run Xwayland on top of it.

### Xwayland

Xwayland, just like Xorg, is a display server that implements the X11 protocol.

Xwayland, different from Xorg, in that it runs **on top of another Wayland compositor**, while Xorg runs on top of the Linux kernel.

How Xwayland did this, you may ask? It is more obvious than you think: it acts as a Wayland client. In other words, it is a Wayland client that takes the responsibility of an X11 display server.

### Wrapping it up

The magic behind Local Desktop is that:

- It implements a minimal Wayland compositor that runs on an Android native activity.
- That minimal Wayland compositor runs Xwayland.
- Xwayland displays the UI of other applications, such as Firefox or Xfce.

Fun fact: [Termux:X11](https://github.com/termux/termux-x11) also implements a display server, but it is based on X11. Just like how Xwayland is an X11 server running on top of Wayland, Termux:X11 is an X11 server running on top of an Android activity. (And Xorg is an X11 server running on top of the Linux kernel, remember that?)
