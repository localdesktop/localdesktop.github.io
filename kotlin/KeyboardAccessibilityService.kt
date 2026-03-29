package app.polarbear

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

class KeyboardAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        super.onServiceConnected()

        Log.i(TAG, "Keyboard accessibility service connected")
        nativeSetServiceConnected(true)

        serviceInfo = AccessibilityServiceInfo().apply {
            packageNames = arrayOf(packageName)
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
            notificationTimeout = 100
            flags = AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS
            feedbackType = AccessibilityServiceInfo.FEEDBACK_SPOKEN
        }
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        return nativeOnKeyEvent(
            event.action,
            event.keyCode,
            event.scanCode,
            event.eventTime,
        ) || super.onKeyEvent(event)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
    }

    override fun onInterrupt() {
    }

    override fun onDestroy() {
        nativeSetServiceConnected(false)
        super.onDestroy()
    }

    private external fun nativeSetServiceConnected(connected: Boolean)
    private external fun nativeOnKeyEvent(
        action: Int,
        keyCode: Int,
        scanCode: Int,
        eventTime: Long,
    ): Boolean

    companion object {
        private const val TAG = "LocalDesktopA11y"

        init {
            System.loadLibrary("localdesktop")
        }
    }
}
