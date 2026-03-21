---
title: Build for unofficially supported platforms
---

Local Desktop only ships binaries for ARM64-v8a. However, you can build APKs for other platforms from source.

:::warning
This is an advanced topic. Prepare to fix cross-compilation issues.
:::

## Build Libraries

First, you need to recompile all the libraries that Local Desktop depends on for your architecture.

### libproot.so & libproot_loader.so

1. Set `$ANDROID_NDK_HOME` to the directory of your Android NDK.
2. In `patches/build-proot-android/config`, update `ARCHS='aarch64'` to the target architecture you want to build for.
3. Build:
   ```bash
   cd patches/build-proot-android/
   ./build.sh
   ```
4. After compilation succeeds, you will have these files:

   ```
   patches/build-proot-android/build/root-aarch64/root/bin/proot
   patches/build-proot-android/build/root-aarch64/root/libexec/proot/loader
   ```

   Copy these files into the assets folder, regarding to your architecture. For example:

   ```
   cp patches/build-proot-android/build/root-aarch64/root/bin/proot assets/libs/arm64-v8a/libproot.so
   cp patches/build-proot-android/build/root-aarch64/root/libexec/proot/loader assets/libs/arm64-v8a/libproot_loader.so
   ```

   Please check Android official documentation for the correct folder name. The binary name must start with `lib` and end with `.so` like above.

### libxkbcommon.so

1. Ensure that you have Docker installed.
2. Run the follow command:

   ```
   cd patches/build-libxkbcommon
   ./build.sh
   ```

3. After compilation succeeds, you will have these files:

   ```
   patches/build-libxkbcommon/output/lib/libxkbcommon.so
   ```

   Copy it to the same `libs/<architecture>` folder as above.

   ```
   cp patches/build-libxkbcommon/output/lib/libxkbcommon.so assets/libs/arm64-v8a/
   ```

### libwayland.so

Thanks to `Smithay`, you don't need to cross-compile `libwayland.so` anymore.

## Build Local Desktop

### libpolar_bear.so

If you extract Local Desktop APK, you would notice a file: `libpolar_bear.so`.

As you recall, Local Desktop is written in pure Rust. Now you know where all the Rust code goes.

Traditionally, you would need to build `libpolar_bear.so` using `cargo`. Then packaging it inside an APK, which technically a Zip file. To tell Android to load the `*.so` from the Native Activity, you would need to compose an `AndroidManifest.xml` file. Local Desktop uses `Xbuild` to do all of this.

After you have put all the required libraries above into `assets/libs/<architecture>`, you can build the APK with this command:

```
x build --release --format=apk --platform=android --arch=<architecture>
```

Then you will find the APK file in `target/x/release/android/localdesktop.apk`.
