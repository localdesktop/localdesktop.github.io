pub mod bind;
mod compositor;
mod event_centralizer;
mod event_handler;
mod frame_clock;
mod hardware_buffer;
mod input;
mod keymap;
mod output_state;
mod watcher;
mod winit_backend;

pub use keymap::physicalkey_to_scancode;
pub use output_state::write_guest_output_state;

pub use compositor::{Compositor, State};
pub use event_centralizer::{centralize, centralize_injected_keyboard, CentralizedEvent};
pub use event_handler::{
    dispatch_clients, handle, idle, on_external_pointer, on_vsync, paint_trackpad, start_frame_loop,
};
pub use frame_clock::FrameClock;
pub use watcher::WaylandWatcher;
pub use winit_backend::{bind, WinitGraphicsBackend};

use smithay::{
    backend::renderer::gles::GlesRenderer,
    utils::{Clock, Logical, Monotonic, Point},
};
use std::collections::HashMap;
use winit::dpi::PhysicalPosition;
use winit::platform::android::activity::AndroidApp;

/// What the fingers currently on screen are doing, following Android's gesture conventions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchMode {
    /// Still within touch slop and the long-press timeout: could become anything.
    Undecided,
    /// Moved past touch slop before the long press fired.
    Scroll,
    /// As a trackpad: one finger moved past touch slop, so it moves the cursor.
    Move,
    /// Long-press timeout elapsed without moving; no button sent yet.
    LongPress,
    /// Moved after a long press: left button held down.
    Drag,
}

pub struct WaylandBackend {
    pub compositor: Compositor,
    pub graphic_renderer: Option<WinitGraphicsBackend<GlesRenderer>>,
    pub android_app: AndroidApp,
    pub clock: Clock<Monotonic>,
    pub key_counter: u32,
    pub guest_scale_factor: f64,
    /// Display refresh rate, as advertised in the `wl_output` mode.
    pub refresh_millihz: i32,
    /// Active touch points keyed by pointer id.
    pub touch_points: HashMap<u64, PhysicalPosition<f64>>,
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
    /// Most fingers down at once during the current gesture.
    pub touch_fingers: usize,
    /// Where the trackpad has moved the cursor to on the external display.
    pub cursor_position: Point<f64, Logical>,
    /// Buttons held by a mouse on the external display (`MotionEvent.getButtonState()`).
    pub external_buttons: i32,
    /// Wakes the event loop for client requests; started on the first resume.
    pub watcher: Option<WaylandWatcher>,
    /// Vsync source; created on the first resume, on the thread that owns the looper.
    pub frame_clock: Option<FrameClock>,
    /// A frame was already submitted for the upcoming refresh, so the next one waits for vsync.
    pub rendered_since_vsync: bool,
}

impl WaylandBackend {
    /// Forget the in-flight gesture. Callers holding a pressed button must release it first.
    pub fn reset_touch_state(&mut self) {
        self.touch_points.clear();
        self.scroll_centroid = None;
        self.touch_mode = TouchMode::Undecided;
        self.touch_down_position = None;
        self.touch_down_time = None;
        self.touch_fingers = 0;
    }

    /// Whether the phone's own window is there to draw to (not while the app is in the background).
    pub fn window_visible(&self) -> bool {
        self.graphic_renderer
            .as_ref()
            .is_some_and(|winit| winit.window_visible())
    }

    /// Whether the desktop is on an external monitor, with the phone as its trackpad.
    pub fn is_trackpad(&self) -> bool {
        self.graphic_renderer
            .as_ref()
            .is_some_and(|winit| winit.external_surface().is_some())
    }
}
