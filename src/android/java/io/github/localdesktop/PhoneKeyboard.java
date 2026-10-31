package io.github.localdesktop;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;

/**
 * The Android keyboard on the phone's own screen, typing into the desktop shown there. While it
 * is up, the desktop fits above it.
 */
final class PhoneKeyboard {
    private static KeyInput input;

    private PhoneKeyboard() {}

    static void show(Activity activity) {
        final KeyInput input = attach(activity);
        input.setFocusableInTouchMode(true);
        input.requestFocus();
        // After the input method has connected to the newly focused view.
        input.post(new Runnable() {
            @Override
            public void run() {
                InputMethodManager imm = (InputMethodManager)
                        input.getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
                imm.showSoftInput(input, 0);
            }
        });
    }

    static void hide() {
        if (input == null) {
            return;
        }
        InputMethodManager imm = (InputMethodManager)
                input.getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
        input.setFocusableInTouchMode(false);
        input.clearFocus();
    }

    private static KeyInput attach(Activity activity) {
        if (input != null && input.getContext() == activity) {
            return input;
        }
        input = new KeyInput(activity);
        activity.addContentView(input, new ViewGroup.LayoutParams(1, 1));
        if (Build.VERSION.SDK_INT >= 30) {
            input.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                    int bottom = insets.isVisible(WindowInsets.Type.ime())
                            ? insets.getInsets(WindowInsets.Type.ime()).bottom : 0;
                    nativeOnInset(bottom);
                    if (bottom == 0) {
                        // Put away with the back gesture: the next tap on a text field asks again.
                        view.setFocusableInTouchMode(false);
                    }
                    return insets;
                }
            });
        }
        return input;
    }

    /** Takes what the Android keyboard types and passes it on as key presses. */
    private static final class KeyInput extends View {
        KeyInput(Context context) {
            super(context);
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
            return new BaseInputConnection(this, false) {
                @Override
                public boolean sendKeyEvent(KeyEvent event) {
                    // Straight to the desktop: the activity's own key events go to native code,
                    // which doesn't see keys the input method makes up.
                    TrackpadControls.forwardKey(event);
                    return true;
                }
            };
        }
    }

    /** How much of the screen's bottom the keyboard covers, in pixels; 0 once it is gone. */
    private static native void nativeOnInset(int bottom);
}
