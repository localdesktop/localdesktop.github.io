//! Damage-driven rendering and client servicing.
//!
//! The event loop sleeps (`ControlFlow::Wait`) until something happens. A frame is drawn only when
//! a client committed, the cursor moved or the layout changed; the damage tracker decides whether
//! anything actually changed on screen and the buffer swap is skipped when nothing did. Frame
//! callbacks are sent after the swap, which blocks on SurfaceFlinger's buffer queue and so paces
//! clients to the display.

use super::{
    compositor::{send_frames_surface_tree, ClientState, CLIENT_DISCONNECTED},
    dmabuf,
    event_handler::sync_pointer_capture,
    layout::Layout,
    WaylandBackend,
};
use smithay::{
    backend::renderer::{
        damage::OutputDamageTracker,
        element::{
            render_elements,
            solid::{SolidColorBuffer, SolidColorRenderElement},
            surface::{render_elements_from_surface_tree, WaylandSurfaceRenderElement},
            utils::RescaleRenderElement,
            Kind,
        },
        gles::GlesRenderer,
        Color32F,
    },
    input::pointer::{CursorImageAttributes, CursorImageStatus},
    reexports::wayland_server::Resource,
    utils::{Physical, Point, Rectangle, Transform},
    wayland::compositor::with_states,
};
use std::sync::{atomic::Ordering, Arc, Mutex};

const CLEAR_COLOR: Color32F = Color32F::new(0.04, 0.04, 0.05, 1.0);
const PANEL_FILL: Color32F = Color32F::new(0.09, 0.09, 0.11, 1.0);
const PANEL_OUTLINE: Color32F = Color32F::new(0.30, 0.31, 0.36, 1.0);
const PANEL_ZONE_LINE: Color32F = Color32F::new(0.17, 0.17, 0.21, 1.0);
/// Gap between the touchpad and the window edge / the desktop above it.
const PANEL_MARGIN: i32 = 8;
const PANEL_OUTLINE_WIDTH: i32 = 2;
const PANEL_ZONE_LINE_WIDTH: i32 = 2;
/// Share of the touchpad height used by the click zones (matches `Layout::click_zone`).
const PANEL_ZONE_FRACTION: f64 = 0.2;

render_elements! {
    pub SceneElement<=GlesRenderer>;
    Surface=WaylandSurfaceRenderElement<GlesRenderer>,
    Scaled=RescaleRenderElement<WaylandSurfaceRenderElement<GlesRenderer>>,
    Solid=SolidColorRenderElement,
}

/// The dark touchpad drawn below the desktop in laptop mode: a filled rectangle with an outline
/// and the click zones along its bottom edge.
pub struct TouchpadPanel {
    fill: SolidColorBuffer,
    outline: [SolidColorBuffer; 4],
    zone_top: SolidColorBuffer,
    zone_divider: SolidColorBuffer,
    /// Window-space rectangles the buffers are placed at (top, bottom, left, right outline;
    /// fill; zone line; divider), or `None` without a touchpad.
    placement: Option<PanelPlacement>,
}

struct PanelPlacement {
    outline: [Rectangle<i32, Physical>; 4],
    fill: Rectangle<i32, Physical>,
    zone_top: Rectangle<i32, Physical>,
    zone_divider: Rectangle<i32, Physical>,
}

impl Default for TouchpadPanel {
    fn default() -> Self {
        let buffer = |color| SolidColorBuffer::new((1, 1), color);
        TouchpadPanel {
            fill: buffer(PANEL_FILL),
            outline: [
                buffer(PANEL_OUTLINE),
                buffer(PANEL_OUTLINE),
                buffer(PANEL_OUTLINE),
                buffer(PANEL_OUTLINE),
            ],
            zone_top: buffer(PANEL_ZONE_LINE),
            zone_divider: buffer(PANEL_ZONE_LINE),
            placement: None,
        }
    }
}

impl TouchpadPanel {
    pub fn update_layout(&mut self, layout: &Layout) {
        let Some(area) = layout.touchpad_area else {
            self.placement = None;
            return;
        };
        let rect = |x: i32, y: i32, w: i32, h: i32| {
            Rectangle::<i32, Physical>::new((x, y).into(), (w.max(1), h.max(1)).into())
        };

        let outer = Rectangle::<i32, Physical>::new(
            (area.loc.x + PANEL_MARGIN, area.loc.y + PANEL_MARGIN).into(),
            (
                (area.size.w - 2 * PANEL_MARGIN).max(2 * PANEL_OUTLINE_WIDTH + 1),
                (area.size.h - 2 * PANEL_MARGIN).max(2 * PANEL_OUTLINE_WIDTH + 1),
            )
                .into(),
        );
        let t = PANEL_OUTLINE_WIDTH;
        let inner = rect(
            outer.loc.x + t,
            outer.loc.y + t,
            outer.size.w - 2 * t,
            outer.size.h - 2 * t,
        );
        let zone_top_y =
            inner.loc.y + (inner.size.h as f64 * (1.0 - PANEL_ZONE_FRACTION)).round() as i32;

        let placement = PanelPlacement {
            outline: [
                rect(outer.loc.x, outer.loc.y, outer.size.w, t),
                rect(outer.loc.x, outer.loc.y + outer.size.h - t, outer.size.w, t),
                rect(outer.loc.x, outer.loc.y + t, t, outer.size.h - 2 * t),
                rect(outer.loc.x + outer.size.w - t, outer.loc.y + t, t, outer.size.h - 2 * t),
            ],
            fill: inner,
            zone_top: rect(inner.loc.x, zone_top_y, inner.size.w, PANEL_ZONE_LINE_WIDTH),
            zone_divider: rect(
                inner.loc.x + inner.size.w / 2 - PANEL_ZONE_LINE_WIDTH / 2,
                zone_top_y + PANEL_ZONE_LINE_WIDTH,
                PANEL_ZONE_LINE_WIDTH,
                inner.loc.y + inner.size.h - zone_top_y - PANEL_ZONE_LINE_WIDTH,
            ),
        };

        for (buffer, rect) in self.outline.iter_mut().zip(placement.outline.iter()) {
            buffer.resize((rect.size.w, rect.size.h));
        }
        self.fill.resize((placement.fill.size.w, placement.fill.size.h));
        self.zone_top
            .resize((placement.zone_top.size.w, placement.zone_top.size.h));
        self.zone_divider
            .resize((placement.zone_divider.size.w, placement.zone_divider.size.h));
        self.placement = Some(placement);
    }

    /// Front-to-back elements; the lines are drawn over the fill.
    fn elements(&self) -> Vec<SceneElement> {
        let Some(placement) = &self.placement else {
            return Vec::new();
        };
        let solid = |buffer: &SolidColorBuffer, rect: &Rectangle<i32, Physical>| {
            SceneElement::from(SolidColorRenderElement::from_buffer(
                buffer,
                rect.loc,
                1.0,
                1.0,
                Kind::Unspecified,
            ))
        };
        let mut elements = vec![
            solid(&self.zone_top, &placement.zone_top),
            solid(&self.zone_divider, &placement.zone_divider),
        ];
        for (buffer, rect) in self.outline.iter().zip(placement.outline.iter()) {
            elements.push(solid(buffer, rect));
        }
        elements.push(solid(&self.fill, &placement.fill));
        elements
    }
}

/// Ask winit for one `RedrawRequested`; repeated calls before it fires collapse into one.
pub fn request_redraw(backend: &WaylandBackend) {
    if let Some(winit) = backend.graphic_renderer.as_ref() {
        winit.window().request_redraw();
    }
}

/// Accept pending connections, dispatch requests from the clients and flush the replies.
fn pump_clients(backend: &mut WaylandBackend) {
    {
        let compositor = &mut backend.compositor;
        loop {
            match compositor.listener.accept() {
                Ok(Some(stream)) => match compositor
                    .display
                    .handle()
                    .insert_client(stream, Arc::new(ClientState::default()))
                {
                    Ok(client) => compositor.clients.push(client),
                    Err(error) => log::error!("Failed to insert Wayland client: {error}"),
                },
                Ok(None) => break,
                Err(error) => {
                    log::error!("Failed to accept Wayland client: {error}");
                    break;
                }
            }
        }

        if let Err(error) = compositor.display.dispatch_clients(&mut compositor.state) {
            log::error!("Failed to dispatch Wayland clients: {error}");
        }
        if CLIENT_DISCONNECTED.swap(false, Ordering::AcqRel) {
            let dh = compositor.display.handle();
            compositor
                .clients
                .retain(|client| client.get_credentials(&dh).is_ok());
            compositor.state.damaged = true;
        }
    }

    dmabuf::ensure_global(backend);
    dmabuf::process_pending_imports(backend);
    sync_pointer_capture(backend);

    if let Err(error) = backend.compositor.display.flush_clients() {
        log::error!("Failed to flush Wayland clients: {error}");
    }
}

fn acknowledge_wake(backend: &WaylandBackend) {
    if let Some(waker) = &backend.waker {
        waker.acknowledge();
    }
}

/// [`pump_clients`] for the wake thread's `WaylandReadable`: also schedules a frame when the
/// clients changed something and lets the wake thread report the next readiness.
pub fn service_clients(backend: &mut WaylandBackend) {
    pump_clients(backend);
    if backend.compositor.state.damaged {
        request_redraw(backend);
    }
    acknowledge_wake(backend);
}

fn cursor_elements(
    renderer: &mut GlesRenderer,
    backend_layout: &Layout,
    image: &CursorImageStatus,
    location: Point<f64, smithay::utils::Logical>,
) -> Vec<SceneElement> {
    let CursorImageStatus::Surface(surface) = image else {
        return Vec::new();
    };
    if !surface.is_alive() {
        return Vec::new();
    }
    let hotspot = with_states(surface, |states| {
        states
            .data_map
            .get::<Mutex<CursorImageAttributes>>()
            .map(|attributes| attributes.lock().unwrap().hotspot)
            .unwrap_or_default()
    });

    let scale = backend_layout.scale();
    let tip = backend_layout.guest_to_window(location);
    let origin = Point::<i32, Physical>::from((
        (tip.x - hotspot.x as f64 * scale.x).round() as i32,
        (tip.y - hotspot.y as f64 * scale.y).round() as i32,
    ));
    surface_scene_elements(renderer, surface, origin, scale, Kind::Cursor)
}

fn surface_scene_elements(
    renderer: &mut GlesRenderer,
    surface: &smithay::reexports::wayland_server::protocol::wl_surface::WlSurface,
    origin: Point<i32, Physical>,
    scale: smithay::utils::Scale<f64>,
    kind: Kind,
) -> Vec<SceneElement> {
    let elements: Vec<WaylandSurfaceRenderElement<GlesRenderer>> =
        render_elements_from_surface_tree(renderer, surface, origin, scale, 1.0, kind);
    if scale.x == 1.0 && scale.y == 1.0 {
        elements.into_iter().map(SceneElement::from).collect()
    } else {
        elements
            .into_iter()
            .map(|element| {
                SceneElement::from(RescaleRenderElement::from_element(element, origin, scale))
            })
            .collect()
    }
}

/// Draw a frame if anything wants one. Returns an error when the renderer is unusable.
pub fn redraw(backend: &mut WaylandBackend) -> Result<(), String> {
    pump_clients(backend);
    acknowledge_wake(backend);

    // The window can change size without telling us first (the event arrives with the next
    // loop iteration): trust the surface, not the last event.
    if let Some(winit) = backend.graphic_renderer.as_ref() {
        if winit.window_size() != backend.layout.window {
            super::output::apply_layout(backend);
        }
    }

    let force_full = backend.full_redraws_pending > 0;
    if !backend.compositor.state.damaged && !force_full {
        return Ok(());
    }
    backend.compositor.state.damaged = false;
    if force_full {
        backend.full_redraws_pending -= 1;
        backend.damage_tracker = None;
    }

    let cursor_visible = backend.cursor_visible();
    let backend_ref = &mut *backend;
    let Some(winit) = backend_ref.graphic_renderer.as_mut() else {
        return Ok(());
    };
    let layout = backend_ref.layout;
    let tracker = backend_ref.damage_tracker.get_or_insert_with(|| {
        OutputDamageTracker::new(layout.window, 1.0, Transform::Flipped180)
    });

    // Buffer age is only meaningful for the surface that is current, i.e. after a previous frame;
    // a fresh tracker draws everything anyway.
    let age = if force_full { 0 } else { winit.buffer_age().unwrap_or(0) };

    let damage: Option<Vec<Rectangle<i32, Physical>>> = {
        let (renderer, mut framebuffer) = winit
            .bind()
            .map_err(|error| format!("Failed to bind EGL surface: {error}"))?;

        let scale = layout.scale();
        let mut elements: Vec<SceneElement> = Vec::new();
        if cursor_visible {
            elements.extend(cursor_elements(
                renderer,
                &layout,
                &backend_ref.compositor.state.cursor_image,
                backend_ref.compositor.pointer_location,
            ));
        }
        for surface in backend_ref.compositor.state.xdg_shell_state.toplevel_surfaces() {
            elements.extend(surface_scene_elements(
                renderer,
                surface.wl_surface(),
                layout.guest_area.loc,
                scale,
                Kind::Unspecified,
            ));
        }
        elements.extend(backend_ref.panel.elements());

        let result = tracker
            .render_output(renderer, &mut framebuffer, age, &elements, CLEAR_COLOR)
            .map_err(|error| format!("Failed to render frame: {error:?}"))?;
        result.damage.cloned()
    };

    // It is important that all events on the display have been dispatched and flushed to clients
    // before swapping buffers because this operation may block.
    if let Err(error) = backend_ref.compositor.display.flush_clients() {
        log::error!("Failed to flush Wayland clients: {error}");
    }

    if let Some(damage) = &damage {
        winit
            .submit(Some(damage))
            .map_err(|error| format!("Failed to submit frame: {error}"))?;
    }

    // The swap returned: the previous frame is on its way to the screen, so clients may draw the
    // next one.
    let time = backend_ref.compositor.start_time.elapsed().as_millis() as u32;
    for surface in backend_ref.compositor.state.xdg_shell_state.toplevel_surfaces() {
        send_frames_surface_tree(surface.wl_surface(), time);
    }
    if let CursorImageStatus::Surface(surface) = &backend_ref.compositor.state.cursor_image {
        if surface.is_alive() {
            send_frames_surface_tree(surface, time);
        }
    }
    if let Err(error) = backend_ref.compositor.display.flush_clients() {
        log::error!("Failed to flush Wayland clients: {error}");
    }

    if backend_ref.full_redraws_pending > 0 {
        request_redraw(backend);
    }
    Ok(())
}
