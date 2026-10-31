package io.github.localdesktop;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.provider.Settings;
import android.view.InputDevice;

public final class KeyboardShortcutsPrompt {
    private static final String PREFS = "keyboard_shortcuts";
    private static final String ANSWERED = "answered";
    /** "Not now" for as long as the app runs. */
    private static boolean notNow;

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
                || notNow
                || !hasPhysicalKeyboard()
                || isServiceEnabled(activity)) {
            return;
        }

        CharSequence app = activity.getApplicationInfo().loadLabel(activity.getPackageManager());
        new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Use Alt+Tab on the desktop?")
            .setMessage(
                "Android keeps Alt+Tab and the Meta key for itself. The " + app
                    + " keyboard service passes them to the desktop.\n\n"
                    + "In the settings that open:\n"
                    + "1. Tap Downloaded apps (or Installed apps)\n"
                    + "2. Tap " + app + " and switch it on\n"
                    + "3. Tap Allow")
            .setCancelable(false)
            .setPositiveButton("Turn on", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    prefs.edit().putBoolean(ANSWERED, true).apply();
                    activity.startActivity(accessibilitySettings(activity));
                }
            })
            .setNegativeButton("Not now", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    notNow = true;
                }
            })
            .show();
    }

    /** Unlike the configuration, this already knows about a keyboard that just connected. */
    private static boolean hasPhysicalKeyboard() {
        for (int id : InputDevice.getDeviceIds()) {
            InputDevice device = InputDevice.getDevice(id);
            if (device != null && !device.isVirtual()
                    && device.getKeyboardType() == InputDevice.KEYBOARD_TYPE_ALPHABETIC) {
                return true;
            }
        }
        return false;
    }

    /**
     * Android's accessibility settings, asked to highlight our service. Apps cannot open the
     * service's own page; Settings apps that don't know the highlight extras just ignore them.
     */
    private static Intent accessibilitySettings(Activity activity) {
        String key = new ComponentName(activity, KeyboardAccessibilityService.class).flattenToString();
        Bundle args = new Bundle();
        args.putString(":settings:fragment_args_key", key);
        return new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            .putExtra(":settings:fragment_args_key", key)
            .putExtra(":settings:show_fragment_args", args);
    }

    private static boolean isServiceEnabled(Activity activity) {
        String enabled = Settings.Secure.getString(
            activity.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        String service = new ComponentName(activity, KeyboardAccessibilityService.class).flattenToString();
        return enabled != null && enabled.contains(service);
    }
}
