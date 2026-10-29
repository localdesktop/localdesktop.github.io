-keep class io.github.localdesktop.KeyboardShortcutsPrompt {
    public static void showIfNeeded(android.app.Activity);
}

-keep class io.github.localdesktop.ExternalDisplay {
    public static void start(android.app.Activity);
    public static void background(android.app.Activity);
    public static void stop(android.app.Activity);
    native <methods>;
}

-keep class io.github.localdesktop.TrackpadControls {
    native <methods>;
}
