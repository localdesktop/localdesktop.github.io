pub mod bind;
mod compositor;
mod event_centralizer;
mod event_handler;
mod input;
mod keymap;
mod winit_backend;

pub use compositor::{Compositor, State};
pub use event_centralizer::{centralize, CentralizedEvent};
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
}
