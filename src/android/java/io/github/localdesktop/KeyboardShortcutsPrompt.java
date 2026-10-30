package io.github.localdesktop;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.provider.Settings;

public final class KeyboardShortcutsPrompt {
    private static final String PREFS = "keyboard_shortcuts";
    private static final String ANSWERED = "answered";

    private KeyboardShortcutsPrompt() {}

    public static void showIfNeeded(final Activity activity) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                show(activity);
            }
        });
    }

    private static void show(final Activity activity) {
        final SharedPreferences prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
        if (prefs.getBoolean(ANSWERED, false)
                || activity.getResources().getConfiguration().keyboard != Configuration.KEYBOARD_QWERTY
                || isServiceEnabled(activity)) {
            return;
        }

        CharSequence app = activity.getApplicationInfo().loadLabel(activity.getPackageManager());
        new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Forward keyboard shortcuts?")
            .setMessage(
                "Android keeps some shortcuts of a physical keyboard for itself, such as Alt+Tab and the Meta key. "
                    + app + " can pass them to the Linux desktop with Android's accessibility service.\n\n"
                    + "When it is on, " + app + " receives the keys you press on a physical keyboard and uses them "
                    + "only while the desktop is on screen. It does not read the screen or other apps, and it does "
                    + "not store or send your keystrokes anywhere.\n\n"
                    + "You can turn it off at any time in Android's accessibility settings.")
            .setCancelable(false)
            .setPositiveButton("Turn on", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    prefs.edit().putBoolean(ANSWERED, true).apply();
                    activity.startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                }
            })
            .setNegativeButton("No thanks", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    prefs.edit().putBoolean(ANSWERED, true).apply();
                }
            })
            .show();
    }

    private static boolean isServiceEnabled(Activity activity) {
        String enabled = Settings.Secure.getString(
            activity.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        String service = new ComponentName(activity, KeyboardAccessibilityService.class).flattenToString();
        return enabled != null && enabled.contains(service);
    }
}
