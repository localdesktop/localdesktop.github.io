use std::thread;

use jni::objects::{JObject, JValue};
use jni::sys::_jobject;
use jni::JNIEnv;
use winit::platform::android::activity::AndroidApp;

/// A function that can be passed into `run_in_jvm` to show a WebView popup.
pub fn show_webview_popup(env: &mut JNIEnv, android_app: &AndroidApp, url: &str) {
    // Convert URL to JNI String
    let jurl = env.new_string(url).expect("Failed to create JNI string");

    // Get NativeActivity context
    let activity_obj = unsafe { JObject::from_raw(android_app.activity_as_ptr() as *mut _jobject) };

    // Prepare a Looper for this thread
    env.call_static_method("android/os/Looper", "prepare", "()V", &[])
        .expect("Failed to prepare Looper");

    // 1. Create WebView
    let webview_class = env.find_class("android/webkit/WebView").unwrap();
    let webview = match env.new_object(
        webview_class,
        "(Landroid/content/Context;)V",
        &[(&activity_obj).into()],
    ) {
        Ok(obj) => obj,
        Err(e) => {
            log::info!("Failed to create WebView object: {:?}", e);
            if let Ok(java_exception) = env.exception_occurred() {
                env.exception_describe().unwrap();
                env.exception_clear().unwrap();
            } else {
                log::info!("No exception occurred, but WebView creation failed.");
            }
            panic!("Failed to create WebView object");
        }
    };

    // Enable JavaScript
    let settings = env
        .call_method(
            &webview,
            "getSettings",
            "()Landroid/webkit/WebSettings;",
            &[],
        )
        .unwrap()
        .l()
        .unwrap();
    env.call_method(settings, "setJavaScriptEnabled", "(Z)V", &[JValue::Bool(1)])
        .unwrap();

    // Set WebView Client to prevent external browser launch
    let webview_client_class = env.find_class("android/webkit/WebViewClient").unwrap();
    let webview_client = env.new_object(webview_client_class, "()V", &[]).unwrap();
    env.call_method(
        &webview,
        "setWebViewClient",
        "(Landroid/webkit/WebViewClient;)V",
        &[(&webview_client).into()],
    )
    .unwrap();

    // Load URL
    env.call_method(
        &webview,
        "loadUrl",
        "(Ljava/lang/String;)V",
        &[(&jurl).into()],
    )
    .unwrap();

    // 2. Create PopupWindow
    let popup_class = env.find_class("android/widget/PopupWindow").unwrap();
    let popup = env
        .new_object(
            popup_class,
            "(Landroid/view/View;II)V",
            &[
                (&webview).into(), // WebView as content
                JValue::Int(-1),   // MATCH_PARENT width
                JValue::Int(-1),   // MATCH_PARENT height
            ],
        )
        .unwrap();

    // 3. Show PopupWindow
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
    )
    .unwrap();

    // Start the Looper
    env.call_static_method("android/os/Looper", "loop", "()V", &[])
        .expect("Failed to start Looper");

    // Quit the Looper when done
    let looper_class = env.find_class("android/os/Looper").unwrap();
    let looper = env
        .call_static_method(looper_class, "myLooper", "()Landroid/os/Looper;", &[])
        .unwrap()
        .l()
        .unwrap();
    env.call_method(&looper, "quit", "()V", &[])
        .expect("Failed to quit Looper");
}
