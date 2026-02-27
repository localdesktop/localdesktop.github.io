use jni::objects::{JObject, JValue};
use jni::sys::_jobject;
use jni::JNIEnv;
use winit::platform::android::activity::AndroidApp;

/// A function that can be passed into `run_in_jvm` to show a WebView popup.
pub fn show_webview_popup(env: &mut JNIEnv, android_app: &AndroidApp, url: &str) {
    fn log_and_clear_exception(env: &mut JNIEnv, context: &str) {
        match env.exception_check() {
            Ok(true) => {
                log::error!("{context}: Java exception pending");
                if let Err(e) = env.exception_describe() {
                    log::error!("{context}: failed to describe Java exception: {:?}", e);
                }
                if let Err(e) = env.exception_clear() {
                    log::error!("{context}: failed to clear Java exception: {:?}", e);
                }
            }
            Ok(false) => {}
            Err(e) => log::error!("{context}: failed to check Java exception: {:?}", e),
        }
    }

    macro_rules! try_or_return {
        ($expr:expr, $ctx:literal) => {
            match $expr {
                Ok(v) => v,
                Err(e) => {
                    log::error!("{}: {:?}", $ctx, e);
                    log_and_clear_exception(env, $ctx);
                    return;
                }
            }
        };
    }

    // Convert URL to JNI String
    let jurl = try_or_return!(env.new_string(url), "Failed to create JNI string");

    // Get NativeActivity context
    let activity_obj = unsafe { JObject::from_raw(android_app.activity_as_ptr() as *mut _jobject) };

    // Prepare a Looper for this thread
    try_or_return!(
        env.call_static_method("android/os/Looper", "prepare", "()V", &[]),
        "Failed to prepare Looper"
    );

    // 1. Create WebView
    let webview_class = try_or_return!(
        env.find_class("android/webkit/WebView"),
        "Failed to find android/webkit/WebView"
    );
    let webview = match env.new_object(
        webview_class,
        "(Landroid/content/Context;)V",
        &[(&activity_obj).into()],
    ) {
        Ok(obj) => obj,
        Err(e) => {
            log::error!("Failed to create WebView object: {:?}", e);
            log_and_clear_exception(env, "Failed to create WebView object");
            return;
        }
    };

    // Enable JavaScript
    let settings = try_or_return!(
        env.call_method(
            &webview,
            "getSettings",
            "()Landroid/webkit/WebSettings;",
            &[],
        )
        .and_then(|v| v.l()),
        "Failed to get WebView settings"
    );
    try_or_return!(
        env.call_method(settings, "setJavaScriptEnabled", "(Z)V", &[JValue::Bool(1)]),
        "Failed to enable JavaScript in WebView"
    );

    // Set WebView Client to prevent external browser launch
    let webview_client_class = try_or_return!(
        env.find_class("android/webkit/WebViewClient"),
        "Failed to find android/webkit/WebViewClient"
    );
    let webview_client = try_or_return!(
        env.new_object(webview_client_class, "()V", &[]),
        "Failed to create WebViewClient"
    );
    try_or_return!(
        env.call_method(
        &webview,
        "setWebViewClient",
        "(Landroid/webkit/WebViewClient;)V",
        &[(&webview_client).into()],
    ),
        "Failed to set WebViewClient"
    );

    // Load URL
    try_or_return!(
        env.call_method(
        &webview,
        "loadUrl",
        "(Ljava/lang/String;)V",
        &[(&jurl).into()],
    ),
        "Failed to load URL in WebView"
    );

    // 2. Create PopupWindow
    let popup_class = try_or_return!(
        env.find_class("android/widget/PopupWindow"),
        "Failed to find android/widget/PopupWindow"
    );
    let popup = try_or_return!(
        env.new_object(
            popup_class,
            "(Landroid/view/View;II)V",
            &[
                (&webview).into(), // WebView as content
                JValue::Int(-1),   // MATCH_PARENT width
                JValue::Int(-1),   // MATCH_PARENT height
            ],
        ),
        "Failed to create PopupWindow"
    );

    // 3. Show PopupWindow
    try_or_return!(
        env.call_method(
        popup,
        "showAtLocation",
        "(Landroid/view/View;III)V",
        &[
            (&webview).into(), // Parent View (WebView itself)
            JValue::Int(17),   // Gravity.CENTER
            JValue::Int(0),    // X Position
            JValue::Int(0),    // Y Position
        ],
    ),
        "Failed to show PopupWindow"
    );

    // Start the Looper
    if let Err(e) = env.call_static_method("android/os/Looper", "loop", "()V", &[]) {
        log::error!("Failed to start Looper: {:?}", e);
        log_and_clear_exception(env, "Failed to start Looper");
        return;
    }

    // Quit the Looper when done
    let looper_class = try_or_return!(
        env.find_class("android/os/Looper"),
        "Failed to find android/os/Looper"
    );
    let looper = try_or_return!(
        env.call_static_method(looper_class, "myLooper", "()Landroid/os/Looper;", &[])
            .and_then(|v| v.l()),
        "Failed to get current Looper"
    );
    if let Err(e) = env.call_method(&looper, "quit", "()V", &[]) {
        log::error!("Failed to quit Looper: {:?}", e);
        log_and_clear_exception(env, "Failed to quit Looper");
    }
}
