use std::{
    collections::VecDeque,
    sync::{Mutex, Once, OnceLock},
};

use jni::{
    objects::{JClass, JObject},
    sys::{jboolean, jint, jlong, jobject, JNI_FALSE, JNI_TRUE},
    JNIEnv,
};
use winit::{
    event::ElementState, event_loop::EventLoopProxy, platform::android::activity::AndroidApp,
};

#[derive(Clone, Copy, Debug)]
pub enum AppUserEvent {
    AccessibilityInputReady,
    /// A Wayland client connected or sent requests.
    WaylandReady,
    /// The display is about to refresh.
    Vsync,
    /// An external monitor's surface appeared, changed or went away.
    ExternalDisplayChanged,
    /// A mouse (or touch) on the external monitor moved, clicked or scrolled.
    ExternalPointer,
    /// The trackpad was turned a quarter.
    TrackpadRotated,
}

#[derive(Clone, Copy, Debug)]
pub struct AccessibilityKeyEvent {
    pub scancode: u32,
    pub state: ElementState,
    pub event_time_ms: u64,
}

#[derive(Default)]
struct AccessibilityBridgeState {
    proxy: Option<EventLoopProxy<AppUserEvent>>,
    runtime_active: bool,
    service_connected: bool,
    pending_events: VecDeque<AccessibilityKeyEvent>,
}

static ACCESSIBILITY_BRIDGE: OnceLock<Mutex<AccessibilityBridgeState>> = OnceLock::new();

const ACTION_DOWN: jint = 0;
const ACTION_UP: jint = 1;

const KEYCODE_VOLUME_UP: jint = 24;
const KEYCODE_VOLUME_DOWN: jint = 25;
const KEYCODE_POWER: jint = 26;

fn bridge() -> &'static Mutex<AccessibilityBridgeState> {
    ACCESSIBILITY_BRIDGE.get_or_init(|| Mutex::new(AccessibilityBridgeState::default()))
}

pub fn register_event_loop_proxy(proxy: EventLoopProxy<AppUserEvent>) {
    let mut bridge = bridge()
        .lock()
        .expect("Failed to lock accessibility bridge");
    bridge.proxy = Some(proxy);
}

/// Asks once, with a physical keyboard attached, whether to turn on the keyboard service.
pub fn show_keyboard_shortcuts_prompt(env: &mut JNIEnv, android_app: &AndroidApp) {
    static PROMPT: Once = Once::new();
    PROMPT.call_once(|| {
        let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr() as jobject) };
        let result = (|| -> jni::errors::Result<()> {
            let loader = env
                .call_method(&activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
                .l()?;
            let name = env.new_string("io.github.localdesktop.KeyboardShortcutsPrompt")?;
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
                "showIfNeeded",
                "(Landroid/app/Activity;)V",
                &[(&activity).into()],
            )?;
            Ok(())
        })();
        if let Err(error) = result {
            log::warn!("Failed to show the keyboard shortcuts prompt: {error}");
            let _ = env.exception_clear();
        }
    });
}

pub fn set_runtime_active(active: bool) {
    let mut bridge = bridge()
        .lock()
        .expect("Failed to lock accessibility bridge");
    bridge.runtime_active = active;
    if !active {
        bridge.pending_events.clear();
    }
}

pub fn drain_pending_events() -> Vec<AccessibilityKeyEvent> {
    let mut bridge = bridge()
        .lock()
        .expect("Failed to lock accessibility bridge");
    bridge.pending_events.drain(..).collect()
}

fn set_service_connected(connected: bool) {
    let mut bridge = bridge()
        .lock()
        .expect("Failed to lock accessibility bridge");
    bridge.service_connected = connected;
    log::info!("Accessibility keyboard service connected={connected}");
}

fn should_ignore_keycode(key_code: jint) -> bool {
    matches!(
        key_code,
        KEYCODE_VOLUME_UP | KEYCODE_VOLUME_DOWN | KEYCODE_POWER
    )
}

fn enqueue_key_event(action: jint, key_code: jint, scan_code: jint, event_time_ms: jlong) -> bool {
    if should_ignore_keycode(key_code) {
        return false;
    }

    let state = match action {
        ACTION_DOWN => ElementState::Pressed,
        ACTION_UP => ElementState::Released,
        _ => return false,
    };

    if scan_code <= 0 || !bridge().lock().unwrap().runtime_active {
        return false;
    }

    inject_key(scan_code as u32, state, event_time_ms.max(0) as u64)
}

/// Type a key into the desktop.
pub fn inject_key(scancode: u32, state: ElementState, event_time_ms: u64) -> bool {
    let mut bridge = bridge()
        .lock()
        .expect("Failed to lock accessibility bridge");

    bridge.pending_events.push_back(AccessibilityKeyEvent {
        scancode,
        state,
        event_time_ms,
    });

    let proxy = bridge.proxy.clone();
    drop(bridge);

    if let Some(proxy) = proxy {
        if let Err(err) = proxy.send_event(AppUserEvent::AccessibilityInputReady) {
            log::warn!("Failed to wake event loop for accessibility input: {err}");
        }
    }

    true
}

#[no_mangle]
pub extern "system" fn Java_io_github_localdesktop_KeyboardAccessibilityService_nativeSetServiceConnected(
    _env: JNIEnv,
    _service: JObject,
    connected: jboolean,
) {
    set_service_connected(connected == JNI_TRUE);
}

#[no_mangle]
pub extern "system" fn Java_io_github_localdesktop_KeyboardAccessibilityService_nativeOnKeyEvent(
    _env: JNIEnv,
    _service: JObject,
    action: jint,
    key_code: jint,
    scan_code: jint,
    event_time_ms: jlong,
) -> jboolean {
    if enqueue_key_event(action, key_code, scan_code, event_time_ms) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}
