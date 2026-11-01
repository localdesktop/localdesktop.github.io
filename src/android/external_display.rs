use std::{
    collections::VecDeque,
    ffi::c_void,
    fs,
    path::PathBuf,
    ptr::NonNull,
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread,
    time::Duration,
};

use jni::{
    objects::{JClass, JObject},
    sys::{jboolean, jfloat, jint, jlong, jobject, JNI_TRUE},
    JNIEnv,
};
use winit::{
    event::ElementState,
    event_loop::EventLoopProxy,
    platform::android::{self, activity::AndroidApp},
};

use crate::{
    android::{
        accessibility::{self, AppUserEvent},
        backend::wayland::physicalkey_to_scancode,
    },
    core::config,
};

#[repr(C)]
#[derive(Debug)]
struct ANativeWindow {
    _private: [u8; 0],
}

extern "C" {
    fn ANativeWindow_fromSurface(
        env: *mut jni::sys::JNIEnv,
        surface: jobject,
    ) -> *mut ANativeWindow;
    fn ANativeWindow_release(window: *mut ANativeWindow);
}

/// The surface of the `Presentation` shown on an external monitor.
#[derive(Debug)]
pub struct ExternalSurface {
    window: NonNull<ANativeWindow>,
    pub width: i32,
    pub height: i32,
    pub density_dpi: i32,
    pub refresh_millihz: i32,
}

unsafe impl Send for ExternalSurface {}
unsafe impl Sync for ExternalSurface {}

impl ExternalSurface {
    pub fn native_window(&self) -> NonNull<c_void> {
        self.window.cast()
    }
}

impl Drop for ExternalSurface {
    fn drop(&mut self) {
        unsafe { ANativeWindow_release(self.window.as_ptr()) };
    }
}

/// A mouse (or touch) on the external monitor, or a mouse plugged into the phone.
#[derive(Debug, Clone, Copy)]
pub struct PointerEvent {
    /// Where on the monitor, in its pixels, or how far a phone's mouse moved when `relative`.
    pub x: f64,
    pub y: f64,
    pub relative: bool,
    /// `MotionEvent.getButtonState()`.
    pub buttons: i32,
    /// `AXIS_HSCROLL` and `AXIS_VSCROLL`, in wheel notches.
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub time_ms: u64,
}

#[derive(Default)]
struct Bridge {
    proxy: Option<EventLoopProxy<AppUserEvent>>,
    surface: Option<Arc<ExternalSurface>>,
    /// The event loop holds an EGL surface on `surface`.
    in_use: bool,
    pointer_events: VecDeque<PointerEvent>,
    /// How much of the phone's screen the Android keyboard covers, in pixels.
    keyboard_inset: i32,
}

static BRIDGE: OnceLock<(Mutex<Bridge>, Condvar)> = OnceLock::new();

/// The guest touches this when a text field takes focus (see `localdesktop-keyboard-relay`).
const KEYBOARD_REQUEST: &str = "tmp/localdesktop-keyboard";

fn bridge() -> &'static (Mutex<Bridge>, Condvar) {
    BRIDGE.get_or_init(Default::default)
}

pub fn register_event_loop_proxy(proxy: EventLoopProxy<AppUserEvent>) {
    bridge().0.lock().unwrap().proxy = Some(proxy.clone());
    watch_keyboard_requests(proxy);
}

fn watch_keyboard_requests(proxy: EventLoopProxy<AppUserEvent>) {
    thread::spawn(move || {
        let path = PathBuf::from(config::arch_fs_root()).join(KEYBOARD_REQUEST);
        let modified = || fs::metadata(&path).and_then(|it| it.modified()).ok();
        let mut last = modified();
        loop {
            thread::sleep(Duration::from_millis(200));
            let now = modified();
            if now != last {
                last = now;
                if now.is_some() && proxy.send_event(AppUserEvent::KeyboardRequested).is_err() {
                    return;
                }
            }
        }
    });
}

/// The external monitor's surface, if one is connected.
pub fn surface() -> Option<Arc<ExternalSurface>> {
    bridge().0.lock().unwrap().surface.clone()
}

/// Called by the event loop when it starts or stops rendering to `surface()`.
pub fn set_in_use(in_use: bool) {
    let (lock, released) = bridge();
    lock.lock().unwrap().in_use = in_use;
    if !in_use {
        released.notify_all();
    }
}

pub fn keyboard_inset() -> i32 {
    bridge().0.lock().unwrap().keyboard_inset
}

pub fn drain_pointer_events() -> Vec<PointerEvent> {
    bridge()
        .0
        .lock()
        .unwrap()
        .pointer_events
        .drain(..)
        .collect()
}

fn notify(bridge: &Bridge, event: AppUserEvent) {
    if let Some(proxy) = &bridge.proxy {
        if let Err(error) = proxy.send_event(event) {
            log::warn!("Failed to wake event loop for the external display: {error}");
        }
    }
}

fn call_java(env: &mut JNIEnv, android_app: &AndroidApp, method: &str) {
    let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr() as jobject) };
    let result = (|| -> jni::errors::Result<()> {
        let loader = env
            .call_method(
                &activity,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            )?
            .l()?;
        let name = env.new_string("io.github.localdesktop.ExternalDisplay")?;
        let class = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&name).into()],
            )?
            .l()?;
        env.call_static_method(
            JClass::from(class),
            method,
            "(Landroid/app/Activity;)V",
            &[(&activity).into()],
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        log::warn!("Failed to call ExternalDisplay.{method}: {error}");
        let _ = env.exception_clear();
    }
}

/// Start showing the desktop on an external monitor whenever one is connected.
pub fn start(env: &mut JNIEnv, android_app: &AndroidApp) {
    call_java(env, android_app, "start");
}

/// Open the Android keyboard, over the trackpad or on the phone's screen.
pub fn show_keyboard(env: &mut JNIEnv, android_app: &AndroidApp) {
    call_java(env, android_app, "showKeyboard");
}

/// Keep the desktop on the monitor while the app is in the background.
pub fn background(env: &mut JNIEnv, android_app: &AndroidApp) {
    call_java(env, android_app, "background");
}

pub fn stop(env: &mut JNIEnv, android_app: &AndroidApp) {
    call_java(env, android_app, "stop");
}

#[no_mangle]
pub extern "system" fn Java_io_github_localdesktop_ExternalDisplay_nativeSurfaceChanged(
    env: JNIEnv,
    _class: JClass,
    surface: JObject,
    width: jint,
    height: jint,
    density_dpi: jint,
    refresh_rate: jfloat,
) {
    let window = unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) };
    let Some(window) = NonNull::new(window) else {
        log::warn!("The external display's surface has no native window");
        return;
    };
    log::info!("External display surface {width}x{height} at {density_dpi} dpi");

    let mut bridge = bridge().0.lock().unwrap();
    bridge.surface = Some(Arc::new(ExternalSurface {
        window,
        width,
        height,
        density_dpi,
        refresh_millihz: (refresh_rate.max(1.0) * 1000.0).round() as i32,
    }));
    notify(&bridge, AppUserEvent::ExternalDisplayChanged);
}

#[no_mangle]
pub extern "system" fn Java_io_github_localdesktop_ExternalDisplay_nativeSurfaceDestroyed(
    _env: JNIEnv,
    _class: JClass,
) {
    log::info!("External display surface destroyed");
    let (lock, released) = bridge();
    let mut bridge = lock.lock().unwrap();
    bridge.surface = None;
    notify(&bridge, AppUserEvent::ExternalDisplayChanged);
    // The surface must not be drawn to once this returns.
    let (_bridge, timeout) = released
        .wait_timeout_while(bridge, Duration::from_secs(1), |bridge| bridge.in_use)
        .unwrap();
    if timeout.timed_out() {
        log::warn!("Timed out waiting for the renderer to release the external display");
    }
}

#[no_mangle]
pub extern "system" fn Java_io_github_localdesktop_ExternalDisplay_nativeOnPointer(
    _env: JNIEnv,
    _class: JClass,
    x: jfloat,
    y: jfloat,
    buttons: jint,
    scroll_x: jfloat,
    scroll_y: jfloat,
    event_time_ms: jlong,
) {
    push_pointer_event(PointerEvent {
        x: x as f64,
        y: y as f64,
        relative: false,
        buttons,
        scroll_x: scroll_x as f64,
        scroll_y: scroll_y as f64,
        time_ms: event_time_ms.max(0) as u64,
    });
}

/// A mouse plugged into the phone, captured while it is a trackpad.
#[no_mangle]
pub extern "system" fn Java_io_github_localdesktop_TrackpadControls_nativeOnMouse(
    _env: JNIEnv,
    _class: JClass,
    dx: jfloat,
    dy: jfloat,
    buttons: jint,
    scroll_x: jfloat,
    scroll_y: jfloat,
    event_time_ms: jlong,
) {
    push_pointer_event(PointerEvent {
        x: dx as f64,
        y: dy as f64,
        relative: true,
        buttons,
        scroll_x: scroll_x as f64,
        scroll_y: scroll_y as f64,
        time_ms: event_time_ms.max(0) as u64,
    });
}

fn push_pointer_event(event: PointerEvent) {
    let mut bridge = bridge().0.lock().unwrap();
    let wake = bridge.pointer_events.is_empty();
    bridge.pointer_events.push_back(event);
    if wake {
        notify(&bridge, AppUserEvent::ExternalPointer);
    }
}

/// A key from the Android keyboard shown over the trackpad.
#[no_mangle]
pub extern "system" fn Java_io_github_localdesktop_TrackpadControls_nativeOnKey(
    _env: JNIEnv,
    _class: JClass,
    down: jboolean,
    key_code: jint,
    event_time_ms: jlong,
) {
    let Some(scancode) = physicalkey_to_scancode(android::physical_key(key_code as u32)) else {
        return;
    };
    let state = if down == JNI_TRUE {
        ElementState::Pressed
    } else {
        ElementState::Released
    };
    accessibility::inject_key(scancode, state, event_time_ms.max(0) as u64);
}

#[no_mangle]
pub extern "system" fn Java_io_github_localdesktop_PhoneKeyboard_nativeOnInset(
    _env: JNIEnv,
    _class: JClass,
    bottom: jint,
) {
    let mut bridge = bridge().0.lock().unwrap();
    if bridge.keyboard_inset != bottom {
        bridge.keyboard_inset = bottom;
        notify(&bridge, AppUserEvent::KeyboardInset);
    }
}
