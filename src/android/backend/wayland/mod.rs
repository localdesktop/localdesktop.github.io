pub mod bind;
mod compositor;
mod event_centralizer;
mod event_handler;
mod input;
mod keymap;
mod output_state;
mod winit_backend;

pub use output_state::write_guest_output_state;

pub use compositor::{Compositor, State};
pub use event_centralizer::{centralize, centralize_injected_keyboard, CentralizedEvent};
pub use event_handler::handle;
pub use winit_backend::{bind, WinitGraphicsBackend};

use smithay::{
    backend::renderer::gles::GlesRenderer,
    utils::{Clock, Monotonic},
};
use std::collections::HashMap;
use winit::dpi::PhysicalPosition;

pub struct WaylandBackend {
    pub compositor: Compositor,
    pub graphic_renderer: Option<WinitGraphicsBackend<GlesRenderer>>,
    pub clock: Clock<Monotonic>,
    pub key_counter: u32,
    pub scale_factor: f64,
    /// Active touch points keyed by pointer id, used for two-finger scroll detection.
    pub touch_points: HashMap<u64, PhysicalPosition<f64>>,
    /// Centroid of the two active touch points at the last scroll update.
    pub scroll_centroid: Option<PhysicalPosition<f64>>,
    /// Set when a two-finger gesture occurred; cleared after the last finger lifts.
    pub touch_gesture_was_multi_touch: bool,
    /// Location where the active single-finger touch first landed, used to tell a tap from a drag.
    pub touch_down_position: Option<PhysicalPosition<f64>>,
    /// Whether a synthesized left-button press is currently held (an in-progress drag).
    pub pointer_pressed: bool,
}
