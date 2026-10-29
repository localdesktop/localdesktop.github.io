package io.github.localdesktop;

import android.app.Activity;
import android.app.Presentation;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.PointerIcon;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

/** Shows the desktop on an external monitor while the phone becomes a trackpad. */
public final class ExternalDisplay {
    static {
        System.loadLibrary("localdesktop");
    }

    private static Activity activity;
    private static DisplayManager displayManager;
    private static DesktopPresentation presentation;
    private static TrackpadControls controls;

    private static final DisplayManager.DisplayListener LISTENER = new DisplayManager.DisplayListener() {
        @Override
        public void onDisplayAdded(int displayId) {
            update();
        }

        @Override
        public void onDisplayRemoved(int displayId) {
            update();
        }

        @Override
        public void onDisplayChanged(int displayId) {}
    };

    private ExternalDisplay() {}

    public static void start(final Activity activity) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (ExternalDisplay.activity == null) {
                    ExternalDisplay.activity = activity;
                    displayManager = (DisplayManager) activity.getSystemService(Context.DISPLAY_SERVICE);
                    displayManager.registerDisplayListener(LISTENER, new Handler(Looper.getMainLooper()));
                }
                update();
                if (presentation != null && controls == null) {
                    controls = new TrackpadControls(activity);
                    controls.show();
                }
            }
        });
    }

    /** The app went to the background: keep the desktop on the monitor, put the phone's controls away. */
    public static void background(Activity activity) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (controls != null) {
                    controls.dismiss();
                    controls = null;
                }
            }
        });
    }

    public static void stop(Activity activity) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (displayManager != null) {
                    displayManager.unregisterDisplayListener(LISTENER);
                }
                dismiss();
                ExternalDisplay.activity = null;
            }
        });
    }

    private static void update() {
        if (activity == null) {
            return;
        }
        Display[] displays = displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION);
        Display display = displays.length > 0 ? displays[0] : null;
        if (presentation != null && presentation.getDisplay().getDisplayId() == (display == null ? -1 : display.getDisplayId())) {
            return;
        }
        dismiss();
        if (display == null) {
            return;
        }
        presentation = new DesktopPresentation(activity, display);
        try {
            presentation.show();
        } catch (WindowManager.InvalidDisplayException e) {
            presentation = null;
            return;
        }
        controls = new TrackpadControls(activity);
        controls.show();
        Toast.makeText(activity, "The desktop is on the external display. Use this screen as a trackpad.",
                Toast.LENGTH_LONG).show();
    }

    private static void dismiss() {
        if (controls != null) {
            controls.dismiss();
            controls = null;
        }
        if (presentation != null) {
            presentation.dismiss();
            presentation = null;
        }
    }

    private static final class DesktopPresentation extends Presentation implements SurfaceHolder.Callback {
        DesktopPresentation(Context context, Display display) {
            super(context, display);
        }

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            setCancelable(false);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            SurfaceView view = new SurfaceView(getContext());
            view.getHolder().addCallback(this);
            // The desktop draws its own cursor where a mouse on this display points.
            view.setPointerIcon(PointerIcon.getSystemIcon(getContext(), PointerIcon.TYPE_NULL));
            view.setOnGenericMotionListener(new View.OnGenericMotionListener() {
                @Override
                public boolean onGenericMotion(View view, MotionEvent event) {
                    return onPointer(event);
                }
            });
            view.setOnTouchListener(new View.OnTouchListener() {
                @Override
                public boolean onTouch(View view, MotionEvent event) {
                    return onPointer(event);
                }
            });
            setContentView(view);
        }

        @Override
        public boolean dispatchKeyEvent(KeyEvent event) {
            // A keyboard typing while the desktop on this display has focus.
            TrackpadControls.forwardKey(event);
            return true;
        }

        private boolean onPointer(MotionEvent event) {
            int buttons = event.getButtonState();
            // A touch screen or pen on the monitor clicks like a mouse.
            if (!event.isFromSource(InputDevice.SOURCE_MOUSE)) {
                int action = event.getActionMasked();
                buttons = action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL
                        ? 0 : MotionEvent.BUTTON_PRIMARY;
            }
            float scrollX = 0;
            float scrollY = 0;
            if (event.getActionMasked() == MotionEvent.ACTION_SCROLL) {
                scrollX = event.getAxisValue(MotionEvent.AXIS_HSCROLL);
                scrollY = event.getAxisValue(MotionEvent.AXIS_VSCROLL);
            }
            nativeOnPointer(event.getX(), event.getY(), buttons, scrollX, scrollY, event.getEventTime());
            return true;
        }

        @Override
        public void surfaceCreated(SurfaceHolder holder) {}

        @Override
        public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            DisplayMetrics metrics = getContext().getResources().getDisplayMetrics();
            nativeSurfaceChanged(holder.getSurface(), width, height, metrics.densityDpi,
                    getDisplay().getRefreshRate());
        }

        @Override
        public void surfaceDestroyed(SurfaceHolder holder) {
            nativeSurfaceDestroyed();
        }
    }

    private static native void nativeSurfaceChanged(
        Surface surface, int width, int height, int densityDpi, float refreshRate);

    private static native void nativeSurfaceDestroyed();

    private static native void nativeOnPointer(
        float x, float y, int buttons, float scrollX, float scrollY, long eventTimeMs);
}
