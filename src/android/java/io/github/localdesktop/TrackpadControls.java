package io.github.localdesktop;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.LinearLayout;

/** Buttons on the phone while it is a trackpad: turn the trackpad, and type with the Android keyboard. */
final class TrackpadControls extends Dialog {
    private static final String PREFS = "trackpad";
    private static final String QUARTER_TURNS = "quarter_turns";

    private final Activity activity;
    private IconButton rotate;
    private KeyboardButton keyboard;
    private boolean keyboardShown;
    /** Waiting for the window to take focus before the keyboard can come up. */
    private boolean keyboardPending;
    /** The keyboard has been on screen since it was asked for. */
    private boolean keyboardSeen;

    TrackpadControls(Activity activity) {
        super(activity);
        this.activity = activity;
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
        window.setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.y = dp(48);
        window.setAttributes(attributes);

        LinearLayout bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        rotate = new IconButton(getContext(), IconButton.ROTATE);
        style(rotate, "Rotate trackpad");
        rotate.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                setQuarterTurns(quarterTurns() + 1);
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
        setQuarterTurns(quarterTurns());
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
        super.dismiss();
    }

    private int quarterTurns() {
        return activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(QUARTER_TURNS, 0);
    }

    private void setQuarterTurns(int quarterTurns) {
        quarterTurns %= 4;
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit().putInt(QUARTER_TURNS, quarterTurns).apply();
        nativeSetQuarterTurns(quarterTurns);
        // Keep the icons upright for someone holding the phone that way.
        rotate.setRotation(-quarterTurns * 90);
        keyboard.setRotation(-quarterTurns * 90);
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
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(56), dp(56));
        params.setMargins(dp(8), 0, dp(8), 0);
        view.setLayoutParams(params);
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
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
            paint.setColor(isSelected() ? 0x77FFFFFF : 0x33FFFFFF);
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

    private static native void nativeSetQuarterTurns(int quarterTurns);

    private static native void nativeOnKey(boolean down, int keyCode, long eventTimeMs);
}
