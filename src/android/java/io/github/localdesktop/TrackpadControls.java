package io.github.localdesktop;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.RectF;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.hardware.input.InputManager;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.LinearLayout;

/**
 * Buttons on the phone while it is a trackpad: turn the screen, and type with the Android
 * keyboard. A mouse plugged into the phone moves the cursor on the external display.
 */
final class TrackpadControls extends Dialog implements InputManager.InputDeviceListener {
    private final Activity activity;
    private final Pad pad;
    private final Badge badge;
    private LinearLayout bar;
    private KeyboardButton keyboard;
    /** A mouse is plugged in, so this window keeps focus to capture it. */
    private boolean mouseAttached;
    private boolean keyboardShown;
    /** Waiting for the window to take focus before the keyboard can come up. */
    private boolean keyboardPending;
    /** The keyboard has been on screen since it was asked for. */
    private boolean keyboardSeen;

    TrackpadControls(Activity activity) {
        super(activity);
        this.activity = activity;
        pad = new Pad(activity);
        badge = new Badge(activity);
    }

    @Override
    public void show() {
        // Under the buttons.
        pad.show();
        badge.show();
        super.show();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        super.onCreate(savedInstanceState);
        setCancelable(false);

        Window window = getWindow();
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        // Touches elsewhere reach the trackpad, and keys the activity, until the keyboard is up.
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        placeInCorner(window, Gravity.RIGHT);

        bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        IconButton rotate = new IconButton(getContext(), IconButton.ROTATE);
        style(rotate, "Rotate screen");
        rotate.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                rotateScreen();
            }
        });
        keyboard = new KeyboardButton(getContext());
        style(keyboard, "Keyboard");
        keyboard.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                setKeyboardShown(!keyboardShown);
            }
        });
        bar.addView(rotate);
        bar.addView(keyboard);
        setContentView(bar);

        if (Build.VERSION.SDK_INT >= 26) {
            View.OnCapturedPointerListener mouse = new View.OnCapturedPointerListener() {
                @Override
                public boolean onCapturedPointer(View view, MotionEvent event) {
                    return onMouse(event);
                }
            };
            // Captured events go to whichever of these has focus.
            bar.setOnCapturedPointerListener(mouse);
            keyboard.setOnCapturedPointerListener(mouse);
            InputManager inputManager = (InputManager) getContext().getSystemService(Context.INPUT_SERVICE);
            inputManager.registerInputDeviceListener(this, null);
            updateMouse();
        }

        if (Build.VERSION.SDK_INT >= 30) {
            // The keyboard can also go away with the back gesture.
            bar.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                    boolean visible = insets.isVisible(WindowInsets.Type.ime());
                    if (keyboardShown && visible) {
                        keyboardSeen = true;
                    } else if (keyboardShown && keyboardSeen) {
                        setKeyboardShown(false);
                    }
                    return insets;
                }
            });
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Capture ends whenever the window loses focus, e.g. to the notification shade.
        if (hasFocus && mouseAttached && Build.VERSION.SDK_INT >= 26) {
            View focused = getWindow().getDecorView().findFocus();
            (focused != null ? focused : bar).requestPointerCapture();
        }
        if (hasFocus && keyboardPending) {
            keyboardPending = false;
            // After the input method has connected to the newly focused button.
            keyboard.post(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT >= 30) {
                        getWindow().getInsetsController().show(WindowInsets.Type.ime());
                    }
                    InputMethodManager imm = (InputMethodManager)
                            getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
                    imm.showSoftInput(keyboard, 0);
                }
            });
        }
    }

    @Override
    public void dismiss() {
        if (Build.VERSION.SDK_INT >= 26) {
            ((InputManager) getContext().getSystemService(Context.INPUT_SERVICE)).unregisterInputDeviceListener(this);
        }
        setKeyboardShown(false);
        pad.dismiss();
        badge.dismiss();
        super.dismiss();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Keys from the Android keyboard, and from a physical one while this window has focus.
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            return super.dispatchKeyEvent(event);
        }
        forwardKey(event);
        return true;
    }

    @Override
    public void onInputDeviceAdded(int deviceId) {
        updateMouse();
    }

    @Override
    public void onInputDeviceRemoved(int deviceId) {
        updateMouse();
    }

    @Override
    public void onInputDeviceChanged(int deviceId) {
        updateMouse();
    }

    /**
     * With a mouse plugged in, take focus and capture it: Android hides its pointer on the phone,
     * and the mouse moves the cursor on the external display instead.
     */
    private void updateMouse() {
        boolean attached = false;
        for (int id : InputDevice.getDeviceIds()) {
            InputDevice device = InputDevice.getDevice(id);
            // A captured mouse reports itself as relative only, so both count.
            if (device != null && !device.isVirtual()
                    && (device.supportsSource(InputDevice.SOURCE_MOUSE)
                        || device.supportsSource(InputDevice.SOURCE_MOUSE_RELATIVE))) {
                attached = true;
            }
        }
        if (attached == mouseAttached) {
            return;
        }
        mouseAttached = attached;
        if (attached) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
            bar.setFocusableInTouchMode(true);
            bar.requestFocus();
        } else if (!keyboardShown) {
            bar.setFocusableInTouchMode(false);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        }
    }

    private boolean onMouse(MotionEvent event) {
        // A captured mouse reports how far it moved, batched since the last event.
        float dx = event.getX();
        float dy = event.getY();
        for (int i = 0; i < event.getHistorySize(); i++) {
            dx += event.getHistoricalX(i);
            dy += event.getHistoricalY(i);
        }
        float scrollX = 0;
        float scrollY = 0;
        if (event.getActionMasked() == MotionEvent.ACTION_SCROLL) {
            dx = 0;
            dy = 0;
            scrollX = event.getAxisValue(MotionEvent.AXIS_HSCROLL);
            scrollY = event.getAxisValue(MotionEvent.AXIS_VSCROLL);
        }
        nativeOnMouse(dx, dy, event.getButtonState(), scrollX, scrollY, event.getEventTime());
        return true;
    }

    /** A text field on the desktop took focus. */
    void showKeyboard() {
        setKeyboardShown(true);
    }

    /**
     * Turns the whole screen a quarter clockwise, Android keyboard included, for a phone lying
     * sideways while auto-rotate keeps it upright.
     */
    private void rotateScreen() {
        int rotation = activity.getWindowManager().getDefaultDisplay().getRotation();
        boolean portrait = getContext().getResources().getConfiguration().orientation
                == android.content.res.Configuration.ORIENTATION_PORTRAIT;
        boolean naturallyPortrait = portrait == (rotation == Surface.ROTATION_0 || rotation == Surface.ROTATION_180);
        // Orientations for ROTATION_0, 90, 180 and 270 of the display.
        int[] orientations = naturallyPortrait
                ? new int[] {
                    ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                    ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                    ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT,
                    ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE}
                : new int[] {
                    ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                    ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT,
                    ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE,
                    ActivityInfo.SCREEN_ORIENTATION_PORTRAIT};
        // The display turns the other way from the content: a quarter clockwise is ROTATION_270.
        activity.setRequestedOrientation(orientations[(rotation + 3) % 4]);
    }

    private void setKeyboardShown(boolean shown) {
        if (keyboard == null || shown == keyboardShown) {
            return;
        }
        keyboardShown = shown;
        Window window = getWindow();
        InputMethodManager imm =
                (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (shown) {
            keyboardSeen = false;
            keyboardPending = true;
            window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
            // Only now: a view focusable in touch mode takes the first tap as focus, not a click.
            keyboard.setFocusableInTouchMode(true);
            keyboard.requestFocus();
        } else {
            keyboardPending = false;
            imm.hideSoftInputFromWindow(keyboard.getWindowToken(), 0);
            keyboard.setFocusableInTouchMode(false);
            if (mouseAttached) {
                bar.requestFocus();
            } else {
                window.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
            }
        }
        keyboard.setSelected(shown);
        keyboard.invalidate();
    }

    /** The buttons' corner of the trackpad, mirrored by the badge's. */
    private static void placeInCorner(Window window, int side) {
        window.setGravity(Gravity.TOP | side);
        WindowManager.LayoutParams attributes = window.getAttributes();
        float density = window.getContext().getResources().getDisplayMetrics().density;
        attributes.x = Math.round((Pad.INSET + 8) * density);
        attributes.y = Math.round((Pad.INSET + 8) * density);
        window.setAttributes(attributes);
    }

    private void style(View view, String label) {
        view.setContentDescription(label);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(44), dp(44));
        params.setMargins(dp(4), 0, dp(4), 0);
        view.setLayoutParams(params);
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    /**
     * The trackpad itself, drawn like Samsung DeX: a border and a cross through the middle.
     * Touches go through it to the activity.
     */
    private static final class Pad extends Dialog {
        static final int INSET = 12;

        Pad(Activity activity) {
            // Not a floating dialog, which would keep margins around it.
            super(activity, android.R.style.Theme_Translucent_NoTitleBar_Fullscreen);
        }

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            requestWindowFeature(Window.FEATURE_NO_TITLE);
            super.onCreate(savedInstanceState);
            setCancelable(false);
            Window window = getWindow();
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                    | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN);
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
            if (Build.VERSION.SDK_INT >= 28) {
                WindowManager.LayoutParams attributes = window.getAttributes();
                attributes.layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(attributes);
            }
            setContentView(new PadView(getContext()));
        }
    }

    private static final class PadView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        PadView(Context context) {
            super(context);
            paint.setStyle(Paint.Style.STROKE);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float density = getResources().getDisplayMetrics().density;
            float inset = Pad.INSET * density;
            RectF border = new RectF(inset, inset, getWidth() - inset, getHeight() - inset);
            float centerX = getWidth() / 2f;
            float centerY = getHeight() / 2f;

            paint.setStrokeWidth(density);
            paint.setColor(0xFF2E2E2E);
            canvas.drawLine(centerX, border.top, centerX, border.bottom, paint);
            canvas.drawLine(border.left, centerY, border.right, centerY, paint);
            paint.setStrokeWidth(1.5f * density);
            paint.setColor(0xFF4A4A4A);
            canvas.drawRoundRect(border, 16 * density, 16 * density, paint);
        }
    }

    /**
     * The app's logo in the top left corner, across from the buttons, so the right way up is
     * clear. Touches go through it to the activity.
     */
    private final class Badge extends Dialog {
        Badge(Activity activity) {
            super(activity);
        }

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            requestWindowFeature(Window.FEATURE_NO_TITLE);
            super.onCreate(savedInstanceState);
            setCancelable(false);
            Window window = getWindow();
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                    | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
            placeInCorner(window, Gravity.LEFT);
            LinearLayout frame = new LinearLayout(getContext());
            View logo = new LogoView(getContext());
            style(logo, null);
            frame.addView(logo);
            setContentView(frame);
        }
    }

    private static final class LogoView extends View {
        private final Drawable logo;
        /** `logo` is an adaptive icon layer, with the art in its middle two thirds. */
        private final boolean logoIsLayer;

        LogoView(Context context) {
            super(context);
            Drawable icon = context.getApplicationInfo().loadIcon(context.getPackageManager());
            if (Build.VERSION.SDK_INT >= 33 && icon instanceof AdaptiveIconDrawable
                    && ((AdaptiveIconDrawable) icon).getMonochrome() != null) {
                // The silhouette, in the pad's grey.
                logo = ((AdaptiveIconDrawable) icon).getMonochrome().mutate();
                logo.setColorFilter(0xFF8A8A8A, PorterDuff.Mode.SRC_IN);
                logoIsLayer = true;
            } else {
                // An icon without one (a full-bleed picture) as the launcher shows it.
                logo = icon;
                logoIsLayer = false;
            }
        }

        @Override
        protected void onDraw(Canvas canvas) {
            int size = Math.min(getWidth(), getHeight());
            int left = (getWidth() - size) / 2;
            int top = (getHeight() - size) / 2;
            int bleed = logoIsLayer ? size / 4 : 0;
            logo.setBounds(left - bleed, top - bleed, left + size + bleed, top + size + bleed);
            logo.draw(canvas);
        }
    }

    /** A round button with a line icon drawn on a 24-unit grid, like Material icons. */
    private static class IconButton extends View {
        static final int ROTATE = 0;
        static final int KEYBOARD = 1;

        private final int icon;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        IconButton(Context context, int icon) {
            super(context);
            this.icon = icon;
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float size = Math.min(getWidth(), getHeight());
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(isSelected() ? 0x77FFFFFF : 0x26FFFFFF);
            canvas.drawCircle(getWidth() / 2f, getHeight() / 2f, size / 2f, paint);

            // The icon takes the middle half of the button.
            float unit = size / 48f;
            canvas.save();
            canvas.translate((getWidth() - size) / 2f + 12 * unit, (getHeight() - size) / 2f + 12 * unit);
            canvas.scale(unit, unit);
            paint.setColor(Color.WHITE);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(2);
            if (icon == ROTATE) {
                // A phone with arrows turning it clockwise.
                canvas.drawRoundRect(new RectF(8.5f, 5, 15.5f, 19), 1.5f, 1.5f, paint);
                RectF orbit = new RectF(2, 2, 22, 22);
                canvas.drawArc(orbit, -80, 60, false, paint);
                canvas.drawLine(21.4f, 8.6f, 22.3f, 5.1f, paint);
                canvas.drawLine(21.4f, 8.6f, 18.5f, 6.5f, paint);
                canvas.drawArc(orbit, 100, 60, false, paint);
                canvas.drawLine(2.6f, 15.4f, 1.7f, 18.9f, paint);
                canvas.drawLine(2.6f, 15.4f, 5.5f, 17.5f, paint);
            } else {
                canvas.drawRoundRect(new RectF(2, 6, 22, 18), 2, 2, paint);
                paint.setStyle(Paint.Style.FILL);
                for (int x = 6; x <= 18; x += 4) {
                    canvas.drawCircle(x, 10, 1, paint);
                    canvas.drawCircle(x, 13, 1, paint);
                }
                paint.setStyle(Paint.Style.STROKE);
                canvas.drawLine(8, 15.5f, 16, 15.5f, paint);
            }
            canvas.restore();
        }
    }

    /** Takes what the Android keyboard types and passes it on as key presses. */
    private static final class KeyboardButton extends IconButton {
        KeyboardButton(Context context) {
            super(context, KEYBOARD);
        }

        @Override
        public boolean onCheckIsTextEditor() {
            return true;
        }

        @Override
        public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
            // No suggestions, so each character arrives as soon as it is typed.
            outAttrs.inputType = InputType.TYPE_CLASS_TEXT
                    | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
            outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN
                    | EditorInfo.IME_FLAG_NO_EXTRACT_UI
                    | EditorInfo.IME_ACTION_NONE;
            return new BaseInputConnection(this, false);
        }
    }

    /** Passes a key on to the desktop, from the Android keyboard or one typing on the monitor. */
    static void forwardKey(KeyEvent event) {
        // Apps on the desktop repeat held keys themselves.
        if (event.getRepeatCount() > 0) {
            return;
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN || event.getAction() == KeyEvent.ACTION_UP) {
            nativeOnKey(event.getAction() == KeyEvent.ACTION_DOWN, event.getKeyCode(), event.getEventTime());
        }
    }

    private static native void nativeOnKey(boolean down, int keyCode, long eventTimeMs);

    private static native void nativeOnMouse(
        float dx, float dy, int buttons, float scrollX, float scrollY, long eventTimeMs);
}
