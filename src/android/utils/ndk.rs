use jni::objects::{JObject, JValue};
use jni::sys::{JNIInvokeInterface_, _jobject};
use jni::{JNIEnv, JavaVM};
use winit::platform::android::activity::AndroidApp;

/// Logical density baseline: 160 dpi is Android's 1x bucket.
const BASELINE_DPI: f64 = 160.0;

/// A higher-order function to run a provided JNI function within the JVM context.
pub fn run_in_jvm<F, T>(jni_function: F, android_app: AndroidApp) -> T
where
    F: FnOnce(&mut JNIEnv, &AndroidApp) -> T,
{
    // Set up JNI and gather the JavaVM
    let vm =
        unsafe { JavaVM::from_raw(android_app.vm_as_ptr() as *mut *const JNIInvokeInterface_) }
            .expect("Failed to get JavaVM");

    let mut env = vm.attach_current_thread().expect("Failed to attach thread");

    // Call the provided JNI function
    let res = jni_function(&mut env, &android_app);

    // Detach the current thread from the JVM
    unsafe { vm.detach_current_thread() };

    res
}

/// Screen density in dpi, read from `Resources.getDisplayMetrics()`.
///
/// Prefer this over winit's `scale_factor()`: that one comes from `AConfiguration`, which the
/// native-activity glue builds from the asset manager at `onCreate` while density is still unset,
/// so it reports the 160 dpi default until the first configuration change.
pub fn density_dpi(android_app: &AndroidApp) -> i32 {
    run_in_jvm(
        |env, app| {
            let activity = unsafe { JObject::from_raw(app.activity_as_ptr() as *mut _jobject) };
            let resources = env
                .call_method(
                    activity,
                    "getResources",
                    "()Landroid/content/res/Resources;",
                    &[],
                )
                .and_then(|it| it.l())
                .ok()?;
            let metrics = env
                .call_method(
                    resources,
                    "getDisplayMetrics",
                    "()Landroid/util/DisplayMetrics;",
                    &[],
                )
                .and_then(|it| it.l())
                .ok()?;
            env.get_field(&metrics, "densityDpi", "I")
                .and_then(|it| it.i())
                .ok()
        },
        android_app.clone(),
    )
    .unwrap_or(BASELINE_DPI as i32)
}

/// Guest UI scale factor derived from the device density, never below 1x.
pub fn scale_factor(android_app: &AndroidApp) -> f64 {
    (density_dpi(android_app) as f64 / BASELINE_DPI).max(1.0)
}

/// How far a finger may travel before the gesture counts as a scroll rather than a tap
/// (`ViewConfiguration.getScaledTouchSlop()`, already in physical pixels).
pub fn touch_slop_px(android_app: &AndroidApp) -> f64 {
    run_in_jvm(
        |env, app| {
            let activity = unsafe { JObject::from_raw(app.activity_as_ptr() as *mut _jobject) };
            let config = env
                .call_static_method(
                    "android/view/ViewConfiguration",
                    "get",
                    "(Landroid/content/Context;)Landroid/view/ViewConfiguration;",
                    &[JValue::Object(&activity)],
                )
                .and_then(|it| it.l())
                .ok()?;
            env.call_method(config, "getScaledTouchSlop", "()I", &[])
                .and_then(|it| it.i())
                .ok()
        },
        android_app.clone(),
    )
    .map(|slop| slop as f64)
    .unwrap_or(24.0)
}

/// How long a finger must stay put to count as a long press
/// (`ViewConfiguration.getLongPressTimeout()`, 500 ms by default, tunable in accessibility
/// settings).
pub fn long_press_timeout_ms(android_app: &AndroidApp) -> u64 {
    run_in_jvm(
        |env, _| {
            env.call_static_method(
                "android/view/ViewConfiguration",
                "getLongPressTimeout",
                "()I",
                &[],
            )
            .and_then(|it| it.i())
            .ok()
        },
        android_app.clone(),
    )
    .map(|timeout| timeout.max(0) as u64)
    .unwrap_or(500)
}
