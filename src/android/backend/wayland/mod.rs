pub mod bind;
mod compositor;
mod display;
mod dmabuf;
mod event_centralizer;
mod event_handler;
mod hinge;
mod input;
mod keymap;
mod layout;
mod output;
mod output_state;
mod render;
mod touchpad;
mod wake;
mod winit_backend;

pub use compositor::{Compositor, State};
pub use event_centralizer::{
    centralize, centralize_device_event, centralize_injected_keyboard, CentralizedEvent,
};
pub use event_handler::{handle, reset_all_touch, sync_pointer_capture, tick};
pub use output::{apply_immersive_and_flags, reconfigure, set_hinge_angle, start_hinge, stop_hinge};
pub use render::{request_redraw, service_clients};
pub use winit_backend::{bind, WinitGraphicsBackend};

use crate::android::utils::{application_context::get_application_context, ndk};
use crate::core::config::LocalConfig;
use hinge::HingeSensor;
use layout::Layout;
use render::TouchpadPanel;
use smithay::{
    backend::renderer::{damage::OutputDamageTracker, gles::GlesRenderer},
    utils::{Clock, Monotonic, Physical, Size},
};
use std::collections::HashMap;
use std::error::Error;
use std::os::fd::AsRawFd;
use touchpad::Touchpad;
use wake::WaylandWaker;
use winit::dpi::PhysicalPosition;
use winit::platform::android::activity::AndroidApp;

/// What the fingers currently on screen are doing, following Android's gesture conventions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchMode {
    /// Still within touch slop and the long-press timeout: could become anything.
    Undecided,
    /// Moved past touch slop before the long press fired.
    Scroll,
    /// Long-press timeout elapsed without moving; no button sent yet.
    LongPress,
    /// Moved after a long press: left button held down.
    Drag,
}

/// Which gesture interpreter a finger belongs to, decided when it lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchRoute {
    /// The pointer jumps to the finger (tap, long press, scroll, drag).
    Direct,
    /// Laptop touchpad gestures (relative movement, taps, two-finger scroll).
    Pad,
}

/// State of Android pointer capture (relative mouse input for games and Wine).
#[derive(Debug, Default)]
pub struct PointerCapture {
    /// Capture is currently requested from Android.
    pub requested: bool,
    /// A mouse (not a finger) has been used since the app started; `input.pointer_capture`
    /// only captures once there is a mouse to capture.
    pub mouse_seen: bool,
    /// The user released capture with the Ctrl+Alt chord; it stays off until the chord is pressed
    /// again or the window regains focus.
    pub released_by_user: bool,
    pub ctrl_down: bool,
    pub alt_down: bool,
    /// Ctrl and Alt are both down and nothing else was pressed since: releasing one toggles
    /// capture.
    pub chord_candidate: bool,
}

pub struct WaylandBackend {
    pub compositor: Compositor,
    pub graphic_renderer: Option<WinitGraphicsBackend<GlesRenderer>>,
    pub android_app: AndroidApp,
    pub clock: Clock<Monotonic>,
    pub key_counter: u32,
    /// Android density bucket factor (`densityDpi / 160`).
    pub guest_scale_factor: f64,
    /// Active direct-mode touch points keyed by pointer id.
    pub touch_points: HashMap<u64, PhysicalPosition<f64>>,
    /// Which interpreter every finger on screen belongs to.
    pub touch_routes: HashMap<u64, TouchRoute>,
    /// Centroid of the active touch points at the last scroll update.
    pub scroll_centroid: Option<PhysicalPosition<f64>>,
    /// What the current gesture has been resolved to.
    pub touch_mode: TouchMode,
    /// Location where the gesture's first finger landed.
    pub touch_down_position: Option<PhysicalPosition<f64>>,
    /// When that finger landed, in `clock` milliseconds.
    pub touch_down_time: Option<u64>,
    /// `ViewConfiguration.getScaledTouchSlop()`.
    pub touch_slop_px: f64,
    /// `ViewConfiguration.getLongPressTimeout()`.
    pub long_press_timeout_ms: u64,
    /// Whether a synthesized button press is currently held (an in-progress drag).
    pub pointer_pressed: bool,

    /// The user's configuration, read once at app start.
    pub config: LocalConfig,
    /// Where the guest and the optional touchpad sit in the window.
    pub layout: Layout,
    pub density_dpi: i32,
    /// `Surface.ROTATION_*` of the display, when it could be read.
    pub display_rotation: Option<i32>,
    /// Refresh rate the window asks for and the output advertises.
    pub refresh_hz: f32,
    /// `(ANativeWindow, Hz bits)` the frame-rate hint was last set for.
    pub frame_rate_applied: Option<(usize, u32)>,
    /// The hinge is half-open (laptop posture).
    pub hinge_half_open: bool,
    /// Whether the window is currently split into guest + touchpad.
    pub laptop_active: bool,
    pub hinge: Option<HingeSensor>,
    pub window_focused: bool,
    pub damage_tracker: Option<OutputDamageTracker>,
    /// Frames to draw in full regardless of damage (after the surface changed size).
    pub full_redraws_pending: u8,
    /// Consecutive failed redraws; the renderer is rebuilt a few times before giving up.
    pub render_failures: u8,
    pub panel: TouchpadPanel,
    pub touchpad: Touchpad,
    pub capture: PointerCapture,
    /// The mouse (not touch) is currently over the laptop touchpad area.
    pub mouse_in_panel: bool,
    /// Last absolute mouse position, to derive relative motion while the guest locks the pointer.
    pub last_mouse_position: Option<(f64, f64)>,
    pub pointer_centered: bool,
    pub waker: Option<WaylandWaker>,
}

impl WaylandBackend {
    pub fn new(android_app: AndroidApp) -> Result<WaylandBackend, Box<dyn Error>> {
        let config = get_application_context().local_config;
        let mut compositor = Compositor::build()?;

        // The wake thread polls these descriptors for the life of the process; the compositor
        // lives that long too.
        let waker = match WaylandWaker::spawn(
            compositor.display.backend().poll_fd().as_raw_fd(),
            compositor.listener.as_raw_fd(),
        ) {
            Ok(waker) => Some(waker),
            Err(error) => {
                log::error!("Failed to start the Wayland wake thread: {error}");
                None
            }
        };

        let touch_slop_px = ndk::touch_slop_px(&android_app);
        let density_dpi = ndk::density_dpi(&android_app);

        Ok(WaylandBackend {
            compositor,
            graphic_renderer: None,
            clock: Clock::new(),
            key_counter: 0,
            guest_scale_factor: (density_dpi as f64 / 160.0).max(1.0),
            touch_points: HashMap::new(),
            touch_routes: HashMap::new(),
            scroll_centroid: None,
            touch_mode: TouchMode::Undecided,
            touch_down_position: None,
            touch_down_time: None,
            touch_slop_px,
            long_press_timeout_ms: ndk::long_press_timeout_ms(&android_app),
            pointer_pressed: false,
            config,
            layout: Layout::compute(Size::<i32, Physical>::from((1, 1)), 1.0, false),
            density_dpi,
            display_rotation: None,
            refresh_hz: 60.0,
            frame_rate_applied: None,
            hinge_half_open: false,
            laptop_active: false,
            hinge: None,
            window_focused: true,
            damage_tracker: None,
            full_redraws_pending: 0,
            render_failures: 0,
            panel: TouchpadPanel::default(),
            touchpad: Touchpad::new(touch_slop_px),
            capture: PointerCapture::default(),
            mouse_in_panel: false,
            last_mouse_position: None,
            pointer_centered: false,
            waker,
            android_app,
        })
    }

    /// Forget the in-flight gesture. Callers holding a pressed button must release it first.
    pub fn reset_touch_state(&mut self) {
        self.touch_points.clear();
        self.scroll_centroid = None;
        self.touch_mode = TouchMode::Undecided;
        self.touch_down_position = None;
        self.touch_down_time = None;
    }

    /// Whether the compositor draws the guest's cursor itself. With a finger (touchpad modes) or
    /// a captured mouse Android shows no pointer of its own.
    pub fn cursor_visible(&self) -> bool {
        self.config.input.touch_mode == crate::core::config::TouchInputMode::Touchpad
            || self.layout.touchpad_area.is_some()
            || self.capture.requested
    }
}
