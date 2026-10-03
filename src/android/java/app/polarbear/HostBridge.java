package app.polarbear;

import android.Manifest;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.ViewTreeObserver;

import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Static entry points called from Rust through JNI (see src/android/utils/host_bridge.rs).
 *
 * Every method takes the running {@link Activity}. Methods that touch windows or views post to the
 * UI thread and return immediately; methods with a return value run on the calling thread. No
 * method throws: failures are logged and swallowed because the native side cannot recover from a
 * pending Java exception.
 */
public final class HostBridge {
    private static final String TAG = "LocalDesktopHost";
    private static final int EXIT_REASON_LIMIT = 16;

    // Desired state, re-applied when the window regains focus.
    private static volatile boolean pointerCaptureWanted = false;
    private static volatile boolean immersiveWanted = false;
    private static boolean notificationPermissionRequested = false;

    private static WeakReference<Activity> focusActivity = new WeakReference<>(null);
    private static WeakReference<ViewTreeObserver> focusObserver = new WeakReference<>(null);

    private static final ViewTreeObserver.OnWindowFocusChangeListener FOCUS_LISTENER =
        new ViewTreeObserver.OnWindowFocusChangeListener() {
            @Override
            public void onWindowFocusChanged(boolean hasFocus) {
                if (!hasFocus) {
                    return;
                }
                Activity activity = focusActivity.get();
                if (activity == null) {
                    return;
                }
                if (immersiveWanted) {
                    applyImmersiveNow(activity);
                }
                if (pointerCaptureWanted) {
                    requestPointerCaptureNow(activity);
                }
            }
        };

    private HostBridge() {}

    // ---------------------------------------------------------------- pointer capture

    public static void setPointerCapture(final Activity activity, final boolean enabled) {
        pointerCaptureWanted = enabled;
        runOnUi(activity, "setPointerCapture", new Runnable() {
            @Override
            public void run() {
                installFocusListener(activity);
                if (enabled) {
                    requestPointerCaptureNow(activity);
                } else {
                    releasePointerCaptureNow(activity);
                }
            }
        });
    }

    private static void requestPointerCaptureNow(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try {
            View decor = activity.getWindow().getDecorView();
            if (!decor.hasFocus()) {
                decor.requestFocus();
            }
            decor.requestPointerCapture();
        } catch (RuntimeException e) {
            Log.w(TAG, "requestPointerCapture failed", e);
        }
    }

    private static void releasePointerCaptureNow(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try {
            activity.getWindow().getDecorView().releasePointerCapture();
        } catch (RuntimeException e) {
            Log.w(TAG, "releasePointerCapture failed", e);
        }
    }

    // ---------------------------------------------------------------- immersive / cutout

    public static void applyImmersive(final Activity activity) {
        immersiveWanted = true;
        runOnUi(activity, "applyImmersive", new Runnable() {
            @Override
            public void run() {
                installFocusListener(activity);
                applyImmersiveNow(activity);
            }
        });
    }

    @SuppressWarnings("deprecation")
    private static void applyImmersiveNow(Activity activity) {
        try {
            Window window = activity.getWindow();

            WindowManager.LayoutParams params = window.getAttributes();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
                window.setAttributes(params);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(params);
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.setDecorFitsSystemWindows(false);
                WindowInsetsController controller = window.getInsetsController();
                if (controller != null) {
                    controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    controller.hide(WindowInsets.Type.systemBars());
                    return;
                }
            }

            // API < 30, or the decor view is not attached yet.
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            window.getDecorView().setSystemUiVisibility(flags);
        } catch (RuntimeException e) {
            Log.w(TAG, "applyImmersive failed", e);
        }
    }

    // ---------------------------------------------------------------- keep screen on

    public static void setKeepScreenOn(final Activity activity, final boolean on) {
        runOnUi(activity, "setKeepScreenOn", new Runnable() {
            @Override
            public void run() {
                try {
                    Window window = activity.getWindow();
                    if (on) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                } catch (RuntimeException e) {
                    Log.w(TAG, "setKeepScreenOn failed", e);
                }
            }
        });
    }

    // ---------------------------------------------------------------- session service

    public static void startSessionService(final Activity activity) {
        runOnUi(activity, "startSessionService", new Runnable() {
            @Override
            public void run() {
                requestNotificationPermissionOnce(activity);
                try {
                    Intent intent = new Intent(activity, SessionService.class);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        activity.startForegroundService(intent);
                    } else {
                        activity.startService(intent);
                    }
                } catch (RuntimeException e) {
                    Log.w(TAG, "Cannot start session service", e);
                }
            }
        });
    }

    public static void stopSessionService(final Activity activity) {
        runOnUi(activity, "stopSessionService", new Runnable() {
            @Override
            public void run() {
                try {
                    activity.stopService(new Intent(activity, SessionService.class));
                } catch (RuntimeException e) {
                    Log.w(TAG, "Cannot stop session service", e);
                }
            }
        });
    }

    private static void requestNotificationPermissionOnce(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || notificationPermissionRequested) {
            return;
        }
        notificationPermissionRequested = true;
        try {
            if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(
                    new String[] {Manifest.permission.POST_NOTIFICATIONS}, 0x4c44);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Cannot request notification permission", e);
        }
    }

    // ---------------------------------------------------------------- display

    /** Refresh rates (Hz) of the activity's current display, ascending, no duplicates. */
    @SuppressWarnings("deprecation")
    public static float[] displayRefreshRates(Activity activity) {
        try {
            Display display = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                try {
                    display = activity.getDisplay();
                } catch (UnsupportedOperationException ignored) {
                    // Not associated with a display yet.
                }
            }
            if (display == null) {
                display = activity.getWindowManager().getDefaultDisplay();
            }

            List<Float> rates = new ArrayList<>();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Display.Mode current = display.getMode();
                Display.Mode[] modes = display.getSupportedModes();
                // Only modes at the resolution currently in use: switching resolution is not
                // something the app wants to trigger by choosing a refresh rate.
                for (Display.Mode mode : modes) {
                    if (mode.getPhysicalWidth() == current.getPhysicalWidth()
                        && mode.getPhysicalHeight() == current.getPhysicalHeight()) {
                        addRate(rates, mode.getRefreshRate());
                    }
                }
                if (rates.isEmpty()) {
                    for (Display.Mode mode : modes) {
                        addRate(rates, mode.getRefreshRate());
                    }
                }
            } else {
                for (float rate : display.getSupportedRefreshRates()) {
                    addRate(rates, rate);
                }
            }
            if (rates.isEmpty()) {
                addRate(rates, display.getRefreshRate());
            }

            float[] out = new float[rates.size()];
            for (int i = 0; i < out.length; i++) {
                out[i] = rates.get(i);
            }
            Arrays.sort(out);
            return out;
        } catch (RuntimeException e) {
            Log.w(TAG, "displayRefreshRates failed", e);
            return new float[0];
        }
    }

    private static void addRate(List<Float> rates, float rate) {
        if (rate <= 0f) {
            return;
        }
        for (Float existing : rates) {
            if (Math.abs(existing - rate) < 0.01f) {
                return;
            }
        }
        rates.add(rate);
    }

    // ---------------------------------------------------------------- exit reasons

    /** One line per recorded process exit of this package, most recent first (API 30+). */
    public static String[] collectExitReasons(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return new String[0];
        }
        try {
            return ExitReasons.collect(activity);
        } catch (RuntimeException e) {
            Log.w(TAG, "collectExitReasons failed", e);
            return new String[0];
        }
    }

    /** Separate class so older devices never load ApplicationExitInfo through HostBridge. */
    @TargetApi(Build.VERSION_CODES.R)
    private static final class ExitReasons {
        static String[] collect(Activity activity) {
            ActivityManager manager =
                (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
            if (manager == null) {
                return new String[0];
            }
            List<ApplicationExitInfo> infos =
                manager.getHistoricalProcessExitReasons(
                    activity.getPackageName(), 0, EXIT_REASON_LIMIT);
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));

            List<ApplicationExitInfo> sorted = new ArrayList<>(infos);
            java.util.Collections.sort(sorted, new java.util.Comparator<ApplicationExitInfo>() {
                @Override
                public int compare(ApplicationExitInfo a, ApplicationExitInfo b) {
                    return Long.compare(b.getTimestamp(), a.getTimestamp());
                }
            });

            String[] lines = new String[sorted.size()];
            for (int i = 0; i < lines.length; i++) {
                ApplicationExitInfo info = sorted.get(i);
                String description = info.getDescription();
                lines[i] = format.format(new Date(info.getTimestamp()))
                    + " process=" + info.getProcessName()
                    + " pid=" + info.getPid()
                    + " reason=" + reasonName(info.getReason())
                    + " status=" + info.getStatus()
                    + " importance=" + importanceName(info.getImportance())
                    + " pss=" + info.getPss() + "KB"
                    + " rss=" + info.getRss() + "KB"
                    + " description="
                    + (description == null ? "" : description.replace('\n', ' ').replace('\r', ' '));
            }
            return lines;
        }

        static String reasonName(int reason) {
            switch (reason) {
                case ApplicationExitInfo.REASON_EXIT_SELF: return "EXIT_SELF";
                case ApplicationExitInfo.REASON_SIGNALED: return "SIGNALED";
                case ApplicationExitInfo.REASON_LOW_MEMORY: return "LOW_MEMORY";
                case ApplicationExitInfo.REASON_CRASH: return "CRASH";
                case ApplicationExitInfo.REASON_CRASH_NATIVE: return "CRASH_NATIVE";
                case ApplicationExitInfo.REASON_ANR: return "ANR";
                case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "INITIALIZATION_FAILURE";
                case ApplicationExitInfo.REASON_PERMISSION_CHANGE: return "PERMISSION_CHANGE";
                case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "EXCESSIVE_RESOURCE_USAGE";
                case ApplicationExitInfo.REASON_USER_REQUESTED: return "USER_REQUESTED";
                case ApplicationExitInfo.REASON_USER_STOPPED: return "USER_STOPPED";
                case ApplicationExitInfo.REASON_DEPENDENCY_DIED: return "DEPENDENCY_DIED";
                case ApplicationExitInfo.REASON_OTHER: return "OTHER";
                case ApplicationExitInfo.REASON_FREEZER: return "FREEZER";
                case ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE: return "PACKAGE_STATE_CHANGE";
                case ApplicationExitInfo.REASON_PACKAGE_UPDATED: return "PACKAGE_UPDATED";
                case ApplicationExitInfo.REASON_UNKNOWN: return "UNKNOWN";
                default: return "REASON_" + reason;
            }
        }

        static String importanceName(int importance) {
            switch (importance) {
                case 100: return "FOREGROUND";
                case 125: return "FOREGROUND_SERVICE";
                case 150: return "TOP_SLEEPING_PRE_28";
                case 200: return "VISIBLE";
                case 230: return "PERCEPTIBLE";
                case 300: return "SERVICE";
                case 325: return "TOP_SLEEPING";
                case 350: return "CANT_SAVE_STATE";
                case 400: return "CACHED";
                case 1000: return "GONE";
                default: return "IMPORTANCE_" + importance;
            }
        }
    }

    // ---------------------------------------------------------------- helpers

    private static void installFocusListener(Activity activity) {
        try {
            focusActivity = new WeakReference<>(activity);
            ViewTreeObserver observer = activity.getWindow().getDecorView().getViewTreeObserver();
            if (observer == focusObserver.get() || !observer.isAlive()) {
                return;
            }
            ViewTreeObserver previous = focusObserver.get();
            if (previous != null && previous.isAlive()) {
                previous.removeOnWindowFocusChangeListener(FOCUS_LISTENER);
            }
            observer.addOnWindowFocusChangeListener(FOCUS_LISTENER);
            focusObserver = new WeakReference<>(observer);
        } catch (RuntimeException e) {
            Log.w(TAG, "Cannot install focus listener", e);
        }
    }

    private static void runOnUi(Activity activity, final String what, final Runnable action) {
        Runnable guarded = new Runnable() {
            @Override
            public void run() {
                try {
                    action.run();
                } catch (RuntimeException e) {
                    Log.w(TAG, what + " failed", e);
                }
            }
        };
        try {
            activity.runOnUiThread(guarded);
        } catch (RuntimeException e) {
            Log.w(TAG, what + ": cannot post to UI thread", e);
        }
    }
}
