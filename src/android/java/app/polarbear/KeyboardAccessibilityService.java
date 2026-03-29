package app.polarbear;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.util.Log;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

public class KeyboardAccessibilityService extends AccessibilityService {
    private static final String TAG = "LocalDesktopA11y";

    static {
        System.loadLibrary("localdesktop");
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();

        Log.i(TAG, "Keyboard accessibility service connected");
        nativeSetServiceConnected(true);

        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.packageNames = new String[] {getPackageName()};
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
        info.notificationTimeout = 50;
        info.flags = AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        setServiceInfo(info);
    }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        return nativeOnKeyEvent(
                event.getAction(),
                event.getKeyCode(),
                event.getScanCode(),
                event.getEventTime())
            || super.onKeyEvent(event);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}

    @Override
    public void onDestroy() {
        nativeSetServiceConnected(false);
        super.onDestroy();
    }

    private static native void nativeSetServiceConnected(boolean connected);

    private static native boolean nativeOnKeyEvent(
        int action,
        int keyCode,
        int scanCode,
        long eventTime
    );
}
