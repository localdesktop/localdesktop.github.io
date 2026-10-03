# Classes in app.polarbear are reached by name from native code (JNI RegisterNatives/Java_* symbols,
# ClassLoader.loadClass("app.polarbear.HostBridge")) and from the manifest, so R8 must keep them intact.
-keep class app.polarbear.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}
