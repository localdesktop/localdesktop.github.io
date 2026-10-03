This directory stores JVM bytecode artifacts that the on-device `cargo run` APK builder can embed without requiring a Java or Kotlin toolchain in Termux.

`classes.dex` contains every class under [`../java`](../java) (package `app.polarbear`): `KeyboardAccessibilityService`, `HostBridge` (called from Rust through `src/android/utils/host_bridge.rs`) and `SessionService` (foreground service), including their nested/anonymous classes.

Regenerate it whenever a Java source changes, on a machine with a JDK (`javac`), Android build-tools (`d8`) and the platform `android.jar`:

```bash
rm -rf /tmp/localdesktop-dex && mkdir -p /tmp/localdesktop-dex/classes /tmp/localdesktop-dex/dex
javac \
  -source 8 \
  -target 8 \
  -bootclasspath "$ANDROID_SDK_ROOT/platforms/android-35/android.jar" \
  -d /tmp/localdesktop-dex/classes \
  $(find src/android/java -name '*.java')
"$ANDROID_SDK_ROOT/build-tools/35.0.0/d8" \
  --lib "$ANDROID_SDK_ROOT/platforms/android-35/android.jar" \
  --min-api 21 \
  --output /tmp/localdesktop-dex/dex \
  $(find /tmp/localdesktop-dex/classes -name '*.class')
cp /tmp/localdesktop-dex/dex/classes.dex src/android/dex/classes.dex
```

Check the result with `"$ANDROID_SDK_ROOT/build-tools/35.0.0/dexdump" -f src/android/dex/classes.dex | grep 'Class descriptor'`.

The Gradle build path (`gradle: true` in `manifest.yaml`) compiles `../java` itself and does not use this file.
