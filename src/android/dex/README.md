This directory stores JVM bytecode artifacts that the on-device `cargo run` APK builder can embed without requiring a Java or Kotlin toolchain in Termux.

`classes.dex` currently contains the `io.github.localdesktop.KeyboardAccessibilityService` implementation from [`../java/io/github/localdesktop/KeyboardAccessibilityService.java`](../java/io/github/localdesktop/KeyboardAccessibilityService.java).

To regenerate it on a machine with `javac`, `d8`, and Android platform `android.jar` available:

```bash
mkdir -p /tmp/localdesktop-a11y/classes /tmp/localdesktop-a11y/dex
javac \
  -source 8 \
  -target 8 \
  -bootclasspath "$ANDROID_SDK_ROOT/platforms/android-35/android.jar" \
  -d /tmp/localdesktop-a11y/classes \
  src/android/java/io/github/localdesktop/KeyboardAccessibilityService.java
"$ANDROID_SDK_ROOT/build-tools/35.0.0/d8" \
  --lib "$ANDROID_SDK_ROOT/platforms/android-35/android.jar" \
  --min-api 21 \
  --output /tmp/localdesktop-a11y/dex \
  /tmp/localdesktop-a11y/classes/io/github/localdesktop/KeyboardAccessibilityService.class
cp /tmp/localdesktop-a11y/dex/classes.dex src/android/dex/classes.dex
```
