use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};

use jni::{
    objects::JObject,
    sys::{jboolean, jint, jlong, JNI_FALSE, JNI_TRUE},
    JNIEnv,
};
use winit::{
    event::ElementState,
    event_loop::EventLoopProxy,
};

#[derive(Clone, Copy, Debug)]
pub enum AppUserEvent {
    AccessibilityInputReady,
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

fn enqueue_key_event(
    action: jint,
    key_code: jint,
    scan_code: jint,
    event_time_ms: jlong,
) -> bool {
    if should_ignore_keycode(key_code) {
        return false;
    }

    let state = match action {
        ACTION_DOWN => ElementState::Pressed,
        ACTION_UP => ElementState::Released,
        _ => return false,
    };

    if scan_code <= 0 {
        return false;
    }

    let mut bridge = bridge()
        .lock()
        .expect("Failed to lock accessibility bridge");
    if !bridge.runtime_active {
        return false;
    }

    bridge.pending_events.push_back(AccessibilityKeyEvent {
        scancode: scan_code as u32,
        state,
        event_time_ms: event_time_ms.max(0) as u64,
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
pub extern "system" fn Java_app_polarbear_KeyboardAccessibilityService_nativeSetServiceConnected(
    _env: JNIEnv,
    _service: JObject,
    connected: jboolean,
) {
    set_service_connected(connected == JNI_TRUE);
}

#[no_mangle]
pub extern "system" fn Java_app_polarbear_KeyboardAccessibilityService_nativeOnKeyEvent(
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
