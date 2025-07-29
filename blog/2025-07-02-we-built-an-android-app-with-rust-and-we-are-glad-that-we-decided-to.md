---
title: We built an Android app with Rust, and we're glad that we decided to
authors:
  - name: Mister Teddy
    title: Creator & Maintainer of Local Desktop
    url: https://mister-teddy.github.io
    image_url: https://avatars2.githubusercontent.com/u/29925961
tags: [for-dev, rust, ndk]
---

*This is not a technical guideline about how to write an Android app in Rust, we might write another article for that. Also: this approach does not fit every application, as onscreen keyboards won't work on such apps.*

## The app

[Local Desktop](/) is an Android app for running a Linux desktop environment, like Xfce4 on your device. Its name is a pun in contrast to Remote Desktop, my personal pain whenever I wish to write some code or inspect some webpage on my big screen tablet.

*Where did the idea come from?*

![This app rises from my personal pain](/img/blog/personal-pain.jpg)

*86% of new product ideas come from personal pain. Source: [rosenfeldmedia.com/books/lean-user-research](https://rosenfeldmedia.com/books/lean-user-research)*

## The rewrite

Our app relies heavily on PRoot for the Linux part and Wayland for the GUI desktop part. The components must be run in NDK, and we used to have an Android app with Kotlin and C++ code. In theory, we can do all the logic in C++, but it was much more complicated and more error-prone, so we tried to push as much logic to Kotlin as possible. And there was the surface handling part, where we had to pass references from JVM to native, native to JVM, chaotically.

Having 2 languages in a code base makes it hard to maintain, and it is a large barrier for someone who would like to contribute to the app. Only the Coroutine section of Kotlin took me days to complete, and it is just a small part of the language. About C++, I found it very difficult to write just correct code, not to mention efficient code. After realising that the object I put into a HashMap silently vanishes as soon as the function returns (even though the HashMap is still being used), I added these 2 books to my wishlist:

![Effective C++ Books](/img/blog/effective-cpp-books.webp)
*ChatGPT recommended me these books, they seem like some good reads, but would take a mountain amount of time. And nothing guarantees that only those who have read the books will work on your project*.

So we decided to do a rewrite. We declared a `NativeActivity` in `AndroidManifest.xml`, and we're done. All the logic happens in NDK now. But this time, we use Rust instead of C++ for NDK development. Why Rust?

The community are showing increasing appreciation for Rust performance, as all the tools I was working with are **either being rewritten in Rust**:

- *"....we've migrated some of the most expensive and parallelizable parts of the framework to Rust, while keeping the core of the framework in TypeScript for extensibility."* - A new engine, built for speed - TailwindCSS.
- *"...there is an ongoing effort to build a Rust-port of Rollup called Rolldown"* - Vite.

**or have a new Rust rival**: Tauri (a lighter Electron), Helix (a more modern Vim), paru (a newer yay), Zed (a faster VSCode),...

Now I sympathise with this appreciation.

## The Good

### Rust enforces correctness

Fun fact:

| The typical Rust code when you jot down your thought | The typical C++ code when you jot down your thought |
| - | - |
| <img src="/img/blog/mini-map-errors-rust.webp" className="block m-auto !max-w-[100px]" alt="Rust source code mini map" /> | <img src="/img/blog/mini-map-errors-cpp.webp" className="block m-auto !max-w-[100px]" alt="C++ source code mini map" /> |

There are a lot of compiler errors to fix, but when a Rust program is compiled, things usually work flawlessly! This contradicts C++, where changes are usually compilable, but when I hit run, waiting for like 5 minutes on my mediocre laptop, the app crashed. I have to trace the whole code with the logic inside my head to figure out why it crashed, fix it, then wait for another 5 minutes to rerun. My app didn't crash immediately anymore, but when I click on the black screen, it crashes. This cycle repeated n times. It took me like 1/4 hour to fix Rust compiler errors, but it saved me hours (or days) to trace what went wrong.

**The Rust Book is all you need to write effective Rust code, as Rust itself is designed with efficiency in mind!**

Rust lang is logically strict. Anyone working with TypeScript knows that its typing is just an annotation layer, there is no guarantee that the variable labelled by the type actually belongs to that type. Runtime errors occur whenever these assumptions are wrong. In Rust, you can rest assured that if it is a duck, it is a duck. Once I tried to cheat the mutex lock, but [the ownership rule makes cheating impossible](https://users.rust-lang.org/t/how-does-read-value-wrapped-inside-arc-mutex-without-acquiring-a-lock/65650/3), no `// IMPORTANT!` blocks, no `CAREFULLY_README.md` files, it's just ownership rules, a part of the language. Whoever invented the ownership rules or designed the Rust smart pointers really needs a raise, to be the CTO at some big tech for real. Now we have a whole ecosystem being enforced under these rules, making the usage of each library (such as Smithay) so logical and secure. You cannot mistakenly add a relative coordinate in place of an absolute coordinate (even though they have the same shape), or you cannot handle touch events if the event source only emits mouse events. In C++, you can end up doing something much more silly, such as placing the keyboard handle into the slot for a mouse handle. Nothing is preventing you from doing so, that's why the Effective C++ books are best-sellers.

### Everything is under your control

Rust libraries, called crates, are mostly (or always?) open source. They are not yet thoroughly documented, nor complete, but the better thing is that whenever things don't go the way you expect, you can always follow a `Go to Definition` from your IDE, or even put breakpoints and see how they work internally. You can easily experiment with changes, which is usually impossible with TypeScript libraries, as the code is usually minified or obfuscated. This allows us to move fast without blocking, and learn more.

![The advantage of the Rust open source ecosystem](/img/blog/rust-open-source-ecosystem-advantage.webp)

### Lighter tools, lighter app

Another good thing: we now use Visual Studio Code to develop the app, so in the future we can continue development directly on Local Desktop (Android Studio does not have a release for ARM64 Linux ). Intellisense and Debugging Rust code in VS Code is a better experience than in Android Studio, in my opinion. Once upon a time, I updated Android Studio, and Dual debugging stopped working. I eventually fixed the issue somehow after a couple of hours. In our new setup, only 1 programming language needs to be debugged.

What's more, the new APK file is ~4Mb in release mode.

## The conclusion

After proofreading this blog, I feel like it is a lengthy criticism of C++. However, I'm not apologising for the hustle I've been through. I encourage everyone to start their new native project with Rust, and I firmly believe Rust has the potential to become the unified programming language of the future, the one that lets you code everything from interactive web sites to server-side, desktop/mobile apps, games,... correctly and efficiently.
