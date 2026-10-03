//! Thin JNI facade over the Java class `app.polarbear.HostBridge`.
//!
//! Everything here is callable from any thread (the winit event-loop thread in practice). Java
//! side methods that touch views or windows post themselves to the UI thread. On any failure the
//! functions log a warning and return an empty/neutral value; a Java exception never propagates.
//!
//! `HostBridge` lives in the app's dex, so it is looked up through the activity's ClassLoader:
//! threads created by NativeActivity only see the system class loader through `FindClass`.

use std::sync::OnceLock;

use jni::errors::Result as JniResult;
use jni::objects::{GlobalRef, JClass, JFloatArray, JObject, JObjectArray, JString, JValue};
use jni::sys::{JNIInvokeInterface_, _jobject};
use jni::{JNIEnv, JavaVM};
use winit::platform::android::activity::AndroidApp;

const HOST_BRIDGE_CLASS: &str = "app.polarbear.HostBridge";
const ACTIVITY_SIG: &str = "Landroid/app/Activity;";

static HOST_BRIDGE: OnceLock<GlobalRef> = OnceLock::new();

/// Attaches the calling thread (a no-op if already attached), resolves `HostBridge` and runs `f`
/// inside a local reference frame so repeated calls from a long-lived thread do not leak locals.
fn with_bridge<T>(
    app: &AndroidApp,
    what: &str,
    f: impl FnOnce(&mut JNIEnv, &JClass, &JObject) -> JniResult<T>,
) -> Option<T> {
    let vm = match unsafe { JavaVM::from_raw(app.vm_as_ptr() as *mut *const JNIInvokeInterface_) }
    {
        Ok(vm) => vm,
        Err(err) => {
            log::warn!("HostBridge.{what}: no JavaVM: {err}");
            return None;
        }
    };
    let mut env = match vm.attach_current_thread() {
        Ok(env) => env,
        Err(err) => {
            log::warn!("HostBridge.{what}: cannot attach thread: {err}");
            return None;
        }
    };
    // The activity reference is owned by the native glue; JObject never deletes on drop.
    let activity = unsafe { JObject::from_raw(app.activity_as_ptr() as *mut _jobject) };

    let result = env.with_local_frame(16, |env| -> JniResult<T> {
        let class = bridge_class(env, &activity)?;
        f(env, &class, &activity)
    });
    match result {
        Ok(value) => Some(value),
        Err(err) => {
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
            }
            log::warn!("HostBridge.{what} failed: {err}");
            None
        }
    }
}

fn bridge_class<'local>(
    env: &mut JNIEnv<'local>,
    activity: &JObject,
) -> JniResult<JClass<'local>> {
    if let Some(global) = HOST_BRIDGE.get() {
        let local = env.new_local_ref(global.as_obj())?;
        return Ok(JClass::from(local));
    }
    let loader = env
        .call_method(
            activity,
            "getClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )?
        .l()?;
    let name = env.new_string(HOST_BRIDGE_CLASS)?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )?
        .l()?;
    let global = env.new_global_ref(&class)?;
    let _ = HOST_BRIDGE.set(global);
    Ok(JClass::from(class))
}

fn call_void(
    app: &AndroidApp,
    name: &str,
    extra_sig: &str,
    extra: &[JValue],
) {
    let sig = format!("({ACTIVITY_SIG}{extra_sig})V");
    with_bridge(app, name, |env, class, activity| {
        let mut args: Vec<JValue> = Vec::with_capacity(1 + extra.len());
        args.push(JValue::Object(activity));
        args.extend_from_slice(extra);
        env.call_static_method(class, name, &sig, &args)?;
        Ok(())
    });
}

/// Requests (or releases) pointer capture on the activity's decor view. While enabled, capture is
/// re-requested whenever the window regains focus.
pub fn set_pointer_capture(app: &AndroidApp, enabled: bool) {
    call_void(app, "setPointerCapture", "Z", &[JValue::Bool(enabled as u8)]);
}

/// Hides status and navigation bars (transient on swipe) and lets the window extend into the
/// display cutout. Idempotent; call on resume, focus gain and configuration change.
pub fn apply_immersive(app: &AndroidApp) {
    call_void(app, "applyImmersive", "", &[]);
}

pub fn set_keep_screen_on(app: &AndroidApp, on: bool) {
    call_void(app, "setKeepScreenOn", "Z", &[JValue::Bool(on as u8)]);
}

/// Starts the foreground service that keeps the process (and the proot tree) alive.
pub fn start_session_service(app: &AndroidApp) {
    call_void(app, "startSessionService", "", &[]);
}

pub fn stop_session_service(app: &AndroidApp) {
    call_void(app, "stopSessionService", "", &[]);
}

/// Refresh rates in Hz of the activity's current display, ascending and without duplicates.
pub fn display_refresh_rates(app: &AndroidApp) -> Vec<f32> {
    with_bridge(app, "displayRefreshRates", |env, class, activity| {
        let array = env
            .call_static_method(
                class,
                "displayRefreshRates",
                &format!("({ACTIVITY_SIG})[F"),
                &[JValue::Object(activity)],
            )?
            .l()?;
        if array.is_null() {
            return Ok(Vec::new());
        }
        let array = JFloatArray::from(array);
        let len = env.get_array_length(&array)? as usize;
        let mut rates = vec![0f32; len];
        env.get_float_array_region(&array, 0, &mut rates)?;
        Ok(rates)
    })
    .unwrap_or_default()
}

/// `ApplicationExitInfo` lines for this package (API 30+), most recent first.
pub fn collect_exit_reasons(app: &AndroidApp) -> Vec<String> {
    with_bridge(app, "collectExitReasons", |env, class, activity| {
        let array = env
            .call_static_method(
                class,
                "collectExitReasons",
                &format!("({ACTIVITY_SIG})[Ljava/lang/String;"),
                &[JValue::Object(activity)],
            )?
            .l()?;
        if array.is_null() {
            return Ok(Vec::new());
        }
        let array = JObjectArray::from(array);
        let len = env.get_array_length(&array)?;
        let mut lines = Vec::with_capacity(len as usize);
        for i in 0..len {
            let element = env.get_object_array_element(&array, i)?;
            if element.is_null() {
                continue;
            }
            let line: String = env.get_string(&JString::from(element))?.into();
            lines.push(line);
        }
        Ok(lines)
    })
    .unwrap_or_default()
}
