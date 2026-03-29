This directory stores JVM bytecode artifacts that the on-device `cargo run` APK builder can embed without requiring a Java or Kotlin toolchain in Termux.

`classes.dex` currently contains the `app.polarbear.KeyboardAccessibilityService` implementation from [`../java/app/polarbear/KeyboardAccessibilityService.java`](../java/app/polarbear/KeyboardAccessibilityService.java).

To regenerate it on a machine with `javac`, `d8`, and Android platform `android.jar` available:

```bash
mkdir -p /tmp/localdesktop-a11y/classes /tmp/localdesktop-a11y/dex
javac \
  -source 8 \
  -target 8 \
  -bootclasspath "$ANDROID_SDK_ROOT/platforms/android-33/android.jar" \
  -d /tmp/localdesktop-a11y/classes \
  src/android/java/app/polarbear/KeyboardAccessibilityService.java
"$ANDROID_SDK_ROOT/build-tools/35.0.0/d8" \
  --lib "$ANDROID_SDK_ROOT/platforms/android-33/android.jar" \
  --min-api 21 \
  --output /tmp/localdesktop-a11y/dex \
  /tmp/localdesktop-a11y/classes/app/polarbear/KeyboardAccessibilityService.class
cp /tmp/localdesktop-a11y/dex/classes.dex src/android/dex/classes.dex
```
