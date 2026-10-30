This directory stores JVM bytecode artifacts that the on-device `cargo run` APK builder can embed without requiring a Java or Kotlin toolchain in Termux.

`classes.dex` currently contains the Java classes in [`../java/io/github/localdesktop/`](../java/io/github/localdesktop/): the keyboard accessibility service and the prompt that asks before turning it on.

To regenerate it on a machine with `javac`, `d8`, and Android platform `android.jar` available:

```bash
mkdir -p /tmp/localdesktop-a11y/classes /tmp/localdesktop-a11y/dex
javac \
  -source 8 \
  -target 8 \
  -bootclasspath "$ANDROID_SDK_ROOT/platforms/android-35/android.jar" \
  -d /tmp/localdesktop-a11y/classes \
  src/android/java/io/github/localdesktop/*.java
"$ANDROID_SDK_ROOT/build-tools/35.0.0/d8" \
  --lib "$ANDROID_SDK_ROOT/platforms/android-35/android.jar" \
  --min-api 21 \
  --output /tmp/localdesktop-a11y/dex \
  /tmp/localdesktop-a11y/classes/io/github/localdesktop/*.class
cp /tmp/localdesktop-a11y/dex/classes.dex src/android/dex/classes.dex
```
