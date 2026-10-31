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
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
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

/** Buttons on the phone while it is a trackpad: turn the screen, and type with the Android keyboard. */
final class TrackpadControls extends Dialog {
    private final Activity activity;
    private final Pad pad;
    private KeyboardButton keyboard;
    private boolean keyboardShown;
    /** Waiting for the window to take focus before the keyboard can come up. */
    private boolean keyboardPending;
    /** The keyboard has been on screen since it was asked for. */
    private boolean keyboardSeen;

    TrackpadControls(Activity activity) {
        super(activity);
        this.activity = activity;
        pad = new Pad(activity);
    }

    @Override
    public void show() {
        // Under the buttons.
        pad.show();
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
        window.setGravity(Gravity.TOP | Gravity.RIGHT);
        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.x = dp(Pad.INSET + 8);
        attributes.y = dp(Pad.INSET + 8);
        window.setAttributes(attributes);

        LinearLayout bar = new LinearLayout(getContext());
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
        setKeyboardShown(false);
        pad.dismiss();
        super.dismiss();
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
            window.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        }
        keyboard.setSelected(shown);
        keyboard.invalidate();
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
     * The trackpad itself, drawn like Samsung DeX: a border, a cross through the middle, and the
     * app's logo on top so the right way up is clear. Touches go through it to the activity.
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
        private final Drawable logo;
        /** `logo` is an adaptive icon layer, with the art in its middle two thirds. */
        private final boolean logoIsLayer;

        PadView(Context context) {
            super(context);
            paint.setStyle(Paint.Style.STROKE);
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

            // Over the top of the cross, on a patch of the pad's black.
            int size = Math.round(48 * density);
            int left = Math.round(centerX - size / 2f);
            int top = Math.round(border.top + 12 * density);
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(Color.BLACK);
            canvas.drawRect(left, top, left + size, top + size, paint);
            paint.setStyle(Paint.Style.STROKE);
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

        @Override
        public boolean dispatchKeyEvent(KeyEvent event) {
            if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                return super.dispatchKeyEvent(event);
            }
            forwardKey(event);
            return true;
        }
    }

    /** Passes a key on to the desktop, from the Android keyboard or one typing on the monitor. */
    static void forwardKey(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN || event.getAction() == KeyEvent.ACTION_UP) {
            nativeOnKey(event.getAction() == KeyEvent.ACTION_DOWN, event.getKeyCode(), event.getEventTime());
        }
    }

    private static native void nativeOnKey(boolean down, int keyCode, long eventTimeMs);
}
