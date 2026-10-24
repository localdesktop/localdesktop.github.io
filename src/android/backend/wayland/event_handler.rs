use crate::android::{
    accessibility::{self, AppUserEvent},
    backend::wayland::{
        compositor::{send_frames_surface_tree, ClientState, State},
        hardware_buffer, write_guest_output_state, CentralizedEvent, FrameClock, TouchMode,
        WaylandBackend, WaylandWatcher,
    },
};
use smithay::backend::input::ButtonState;
use smithay::backend::renderer::element::surface::{
    render_elements_from_surface_tree, WaylandSurfaceRenderElement,
};
use smithay::backend::renderer::element::texture::TextureRenderElement;
use smithay::backend::renderer::element::{render_elements, Kind};
use smithay::backend::renderer::gles::{GlesRenderer, GlesTexture};
use smithay::backend::renderer::utils::draw_render_elements;
use smithay::backend::renderer::{Color32F, Frame, Renderer};
use smithay::input::keyboard::FilterResult;
use smithay::input::pointer;
use smithay::reexports::wayland_server::protocol::wl_pointer::ButtonState as WlButtonState;
use smithay::utils::{Point, Rectangle, Transform, SERIAL_COUNTER};
use smithay::wayland::shell::xdg::ToplevelSurface;
use smithay::{
    backend::input::{
        AbsolutePositionEvent, Axis, Event, InputEvent, KeyboardKeyEvent, PointerAxisEvent,
        PointerButtonEvent,
    },
    output::{Mode, Scale},
};
use std::os::fd::AsFd;
use std::sync::Arc;
use std::time::{Duration, Instant};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoopProxy};

/// Linux input event code for the left mouse button (`BTN_LEFT`).
const BTN_LEFT: u32 = 0x110;
/// Linux input event code for the right mouse button (`BTN_RIGHT`).
const BTN_RIGHT: u32 = 0x111;

/**
 * As we currently use Xwayland, there is only 1 surface
 */
fn get_surface(state: &State) -> Option<ToplevelSurface> {
    state
        .xdg_shell_state
        .toplevel_surfaces()
        .iter()
        .next()
        .cloned()
}

fn pointer_focus(
    state: &State,
) -> Option<(
    smithay::reexports::wayland_server::protocol::wl_surface::WlSurface,
    Point<f64, smithay::utils::Logical>,
)> {
    get_surface(state).map(|surface| (surface.wl_surface().clone(), (0f64, 0f64).into()))
}

fn emit_pointer_motion(
    compositor: &mut crate::android::backend::wayland::Compositor,
    x: f64,
    y: f64,
    time: u32,
) {
    let pointer = compositor.pointer.clone();
    let state = &mut compositor.state;
    if let Some(focus) = pointer_focus(state) {
        let serial = SERIAL_COUNTER.next_serial();
        pointer.motion(
            state,
            Some(focus),
            &pointer::MotionEvent {
                location: (x, y).into(),
                serial,
                time,
            },
        );
        pointer.frame(state);
    }
}

/// Press a button. Also moves keyboard focus to the surface under the pointer.
fn emit_pointer_press(
    compositor: &mut crate::android::backend::wayland::Compositor,
    button: u32,
    time: u32,
) {
    let pointer = compositor.pointer.clone();
    let state = &mut compositor.state;
    if let Some(surface) = get_surface(state) {
        compositor.keyboard.set_focus(
            state,
            Some(surface.wl_surface().clone()),
            SERIAL_COUNTER.next_serial().into(),
        );
    }

    let serial = SERIAL_COUNTER.next_serial();
    pointer.button(
        state,
        &pointer::ButtonEvent {
            button,
            state: ButtonState::Pressed,
            serial,
            time,
        },
    );
    pointer.frame(state);
}

/// Release a button.
fn emit_pointer_release(
    compositor: &mut crate::android::backend::wayland::Compositor,
    button: u32,
    time: u32,
) {
    let pointer = compositor.pointer.clone();
    let state = &mut compositor.state;
    let serial = SERIAL_COUNTER.next_serial();
    pointer.button(
        state,
        &pointer::ButtonEvent {
            button,
            state: ButtonState::Released,
            serial,
            time,
        },
    );
    pointer.frame(state);
}

/// A full tap: move to the location, then a press immediately followed by a release.
fn emit_pointer_click(
    compositor: &mut crate::android::backend::wayland::Compositor,
    button: u32,
    x: f64,
    y: f64,
    time: u32,
) {
    emit_pointer_motion(compositor, x, y, time);
    emit_pointer_press(compositor, button, time);
    emit_pointer_release(compositor, button, time);
}

/// How long until the finger that is down becomes a long press, if it still can.
fn long_press_remaining(backend: &WaylandBackend) -> Option<Duration> {
    if backend.touch_mode != TouchMode::Undecided || backend.touch_points.len() != 1 {
        return None;
    }
    let down_time = backend.touch_down_time?;
    let now = backend.clock.now().as_millis() as u64;
    let deadline = down_time + backend.long_press_timeout_ms;
    Some(Duration::from_millis(deadline.saturating_sub(now)))
}

/// Arm the long press once the finger has stayed put for `ViewConfiguration`'s timeout.
///
/// No button is sent here: moving afterwards starts a drag with the left button held, lifting
/// instead fires a right click. Called whenever the loop goes idle, which `idle` schedules for
/// the timeout.
fn poll_long_press(backend: &mut WaylandBackend) {
    if long_press_remaining(backend) != Some(Duration::ZERO) {
        return;
    }
    let Some(down_position) = backend.touch_down_position else {
        return;
    };
    let now = backend.clock.now().as_millis() as u64;

    backend.touch_mode = TouchMode::LongPress;
    // Anchor the pointer where the finger landed, so a drag selects from there.
    emit_pointer_motion(
        &mut backend.compositor,
        down_position.x,
        down_position.y,
        now as u32,
    );
}

pub fn handle(event: CentralizedEvent, backend: &mut WaylandBackend, event_loop: &ActiveEventLoop) {
    match event {
        CentralizedEvent::CloseRequested => {
            event_loop.exit();
        }
        CentralizedEvent::Redraw => {
            // Requested by the OS (e.g. the surface was recreated), so draw even without damage.
            backend.compositor.state.render_pending = true;
            backend.rendered_since_vsync = false;
            schedule_frame(backend);
        }
        CentralizedEvent::Input(event) => match event {
            InputEvent::Keyboard { event } => {
                let compositor = &mut backend.compositor;
                let state = &mut compositor.state;
                let serial = SERIAL_COUNTER.next_serial();
                let time = compositor.start_time.elapsed().as_millis() as u32;
                compositor.keyboard.input::<(), _>(
                    state,
                    event.key_code(),
                    event.state(),
                    serial,
                    time,
                    |_, _, _| {
                        //
                        FilterResult::Forward
                    },
                );
            }
            InputEvent::TouchDown { event } => {
                // Just move the cursor. Which button (if any) this gesture sends is only known
                // once the finger moves, lifts, or sits still long enough to be a long press.
                emit_pointer_motion(
                    &mut backend.compositor,
                    event.x(),
                    event.y(),
                    event.time_msec(),
                );
            }
            InputEvent::TouchMotion { event } => {
                let time = event.time_msec();

                // The centralizer only emits motion in Drag mode, and flips into it on the
                // first move after a long press — that transition is where the grab starts.
                if !backend.pointer_pressed {
                    emit_pointer_press(&mut backend.compositor, BTN_LEFT, time);
                    backend.pointer_pressed = true;
                }

                emit_pointer_motion(&mut backend.compositor, event.x(), event.y(), time);
            }
            InputEvent::TouchUp { event } => {
                let time = event.time_msec();

                if backend.pointer_pressed {
                    // End of a drag.
                    emit_pointer_motion(&mut backend.compositor, event.x, event.y, time);
                    emit_pointer_release(&mut backend.compositor, BTN_LEFT, time);
                    backend.pointer_pressed = false;
                } else {
                    match event.mode {
                        // A tap: left click where the finger lifted.
                        TouchMode::Undecided => emit_pointer_click(
                            &mut backend.compositor,
                            BTN_LEFT,
                            event.x,
                            event.y,
                            time,
                        ),
                        // Held still, then lifted without moving: a context menu, as on Android.
                        TouchMode::LongPress => emit_pointer_click(
                            &mut backend.compositor,
                            BTN_RIGHT,
                            event.x,
                            event.y,
                            time,
                        ),
                        // A scroll consumed the gesture; nothing to click.
                        TouchMode::Scroll | TouchMode::Drag => {}
                    }
                }
            }
            InputEvent::TouchCancel { event } => {
                if backend.pointer_pressed {
                    emit_pointer_release(&mut backend.compositor, BTN_LEFT, event.time() as u32);
                    backend.pointer_pressed = false;
                }
            }
            InputEvent::PointerMotionAbsolute { event, .. } => {
                let compositor = &mut backend.compositor;
                let pointer = compositor.pointer.clone();
                let serial = SERIAL_COUNTER.next_serial();

                if let Some(surface) = get_surface(&compositor.state) {
                    pointer.motion(
                        &mut compositor.state,
                        Some((surface.wl_surface().clone(), (0f64, 0f64).into())),
                        &pointer::MotionEvent {
                            location: (event.x(), event.y()).into(),
                            serial,
                            time: event.time_msec(),
                        },
                    );
                }
                pointer.frame(&mut compositor.state);
            }
            InputEvent::PointerButton { event, .. } => {
                let serial = SERIAL_COUNTER.next_serial();
                let button = event.button_code();

                let state = WlButtonState::from(event.state());

                let compositor = &mut backend.compositor;
                let pointer = compositor.pointer.clone();

                if let Some(surface) = get_surface(&compositor.state) {
                    compositor.keyboard.set_focus(
                        &mut compositor.state,
                        Some(surface.wl_surface().clone()),
                        0.into(),
                    );
                }
                pointer.button(
                    &mut compositor.state,
                    &pointer::ButtonEvent {
                        button,
                        state: state.try_into().unwrap(),
                        serial,
                        time: event.time_msec(),
                    },
                );
                pointer.frame(&mut compositor.state);
            }
            InputEvent::PointerAxis { event } => {
                // A second finger can turn an in-progress drag into a scroll; drop the button
                // the drag was holding rather than scrolling with it down.
                if backend.pointer_pressed {
                    emit_pointer_release(&mut backend.compositor, BTN_LEFT, event.time_msec());
                    backend.pointer_pressed = false;
                }
                let horizontal_amount = event
                    .amount(Axis::Horizontal)
                    .unwrap_or_else(|| event.amount_v120(Axis::Horizontal).unwrap_or(0.0) / 120.);
                let vertical_amount = event
                    .amount(Axis::Vertical)
                    .unwrap_or_else(|| event.amount_v120(Axis::Vertical).unwrap_or(0.0) / 120.);
                let horizontal_amount_discrete = event.amount_v120(Axis::Horizontal);
                let vertical_amount_discrete = event.amount_v120(Axis::Vertical);

                {
                    let mut frame =
                        pointer::AxisFrame::new(event.time_msec()).source(event.source());
                    if horizontal_amount != 0.0 {
                        frame = frame.relative_direction(
                            Axis::Horizontal,
                            event.relative_direction(Axis::Horizontal),
                        );
                        frame = frame.value(Axis::Horizontal, horizontal_amount);
                        if let Some(discrete) = horizontal_amount_discrete {
                            frame = frame.v120(Axis::Horizontal, discrete as i32);
                        }
                    }
                    if vertical_amount != 0.0 {
                        frame = frame.relative_direction(
                            Axis::Vertical,
                            event.relative_direction(Axis::Vertical),
                        );
                        frame = frame.value(Axis::Vertical, vertical_amount);
                        if let Some(discrete) = vertical_amount_discrete {
                            frame = frame.v120(Axis::Vertical, discrete as i32);
                        }
                    }
                    if event.amount(Axis::Horizontal) == Some(0.0) {
                        frame = frame.stop(Axis::Horizontal);
                    }
                    if event.amount(Axis::Vertical) == Some(0.0) {
                        frame = frame.stop(Axis::Vertical);
                    }
                    let compositor = &mut backend.compositor;
                    let pointer = compositor.pointer.clone();
                    pointer.axis(&mut compositor.state, frame);
                    pointer.frame(&mut compositor.state);
                }
            }
            _ => {}
        },
        CentralizedEvent::Resized {
            size,
            guest_scale_factor,
        } => {
            backend.compositor.state.size = (size.w, size.h).into();

            if let Some(output) = &backend.compositor.output {
                output.change_current_state(
                    Some(Mode {
                        size: size.into(),
                        refresh: backend.refresh_millihz,
                    }),
                    Some(Transform::Normal),
                    Some(Scale::Integer(1)),
                    Some((0, 0).into()),
                );
            }

            let guest_scale = guest_scale_factor.round().max(1.0) as i32;
            write_guest_output_state(size.w, size.h, guest_scale);

            if let Some(surface) = get_surface(&backend.compositor.state) {
                surface.xdg_toplevel().configure(size.w, size.h, vec![]);
            }

            backend.compositor.state.render_pending = true;
            schedule_frame(backend);
        }
        _ => (),
    }
}

/// Start waking up for client requests and display refreshes instead of polling every frame.
pub fn start_frame_loop(backend: &mut WaylandBackend, proxy: &EventLoopProxy<AppUserEvent>) {
    if backend.watcher.is_none() {
        let compositor = &mut backend.compositor;
        let fds = [
            compositor.display.backend().poll_fd().try_clone_to_owned(),
            compositor.listener.as_fd().try_clone_to_owned(),
        ]
        .into_iter()
        .collect::<Result<Vec<_>, _>>();
        match fds {
            Ok(fds) => backend.watcher = Some(WaylandWatcher::spawn(fds, proxy.clone())),
            Err(error) => log::error!("Failed to watch the Wayland sockets: {error}"),
        }
    }
    if backend.frame_clock.is_none() {
        backend.frame_clock = Some(FrameClock::new(proxy.clone(), backend.refresh_millihz));
    }
}

/// Accept new clients and handle their requests, then draw whatever they committed.
pub fn dispatch_clients(backend: &mut WaylandBackend) {
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
    if let Some(watcher) = &backend.watcher {
        watcher.rearm();
    }
    schedule_frame(backend);
}

/// The display is about to refresh: draw what arrived since the last frame and let clients
/// start on their next one.
pub fn on_vsync(backend: &mut WaylandBackend) {
    if let Some(clock) = backend.frame_clock.as_mut() {
        clock.ticked();
    }
    backend.rendered_since_vsync = false;
    if backend.graphic_renderer.is_none() {
        return;
    }

    if backend.compositor.state.render_pending {
        render_frame(backend);
    }

    let compositor = &mut backend.compositor;
    if compositor.state.frame_pending {
        compositor.state.frame_pending = false;
        let time = compositor.start_time.elapsed().as_millis() as u32;
        for surface in compositor.state.xdg_shell_state.toplevel_surfaces() {
            send_frames_surface_tree(surface.wl_surface(), time);
        }
    }

    schedule_frame(backend);
}

/// Called when the event loop runs out of events: deliver what input produced and sleep until
/// the next thing that needs attention.
pub fn idle(backend: &mut WaylandBackend, event_loop: &ActiveEventLoop) {
    poll_long_press(backend);

    if let Some(deadline) = backend.frame_clock.as_ref().and_then(FrameClock::deadline) {
        if Instant::now() >= deadline {
            on_vsync(backend);
        }
    }

    if let Err(error) = backend.compositor.display.flush_clients() {
        log::warn!("Failed to flush Wayland clients: {error}");
    }

    let long_press = long_press_remaining(backend).map(|remaining| Instant::now() + remaining);
    let frame = backend.frame_clock.as_ref().and_then(FrameClock::deadline);
    event_loop.set_control_flow(match long_press.into_iter().chain(frame).min() {
        Some(deadline) => ControlFlow::WaitUntil(deadline),
        None => ControlFlow::Wait,
    });
}

/// Draw new content right away unless a frame already went out for this refresh, and keep
/// vsync ticking while anything is left for it.
fn schedule_frame(backend: &mut WaylandBackend) {
    // While hidden, clients get no frame callbacks and stop drawing until we are visible again.
    if backend.graphic_renderer.is_none() {
        return;
    }
    if backend.compositor.state.render_pending && !backend.rendered_since_vsync {
        render_frame(backend);
    }

    let state = &backend.compositor.state;
    if state.render_pending || state.frame_pending {
        if let Some(clock) = backend.frame_clock.as_mut() {
            clock.request();
        }
    }
}

fn render_frame(backend: &mut WaylandBackend) {
    match render(backend) {
        Ok(()) => {
            backend.compositor.state.render_pending = false;
            backend.rendered_since_vsync = true;
        }
        Err(error) => {
            log::error!("Redraw failed; dropping renderer until next resume: {error}");
            backend.graphic_renderer = None;
            accessibility::set_runtime_active(false);
        }
    }
}

render_elements! {
    SurfaceElement<=GlesRenderer>;
    HardwareBuffer=TextureRenderElement<GlesTexture>,
    Surface=WaylandSurfaceRenderElement<GlesRenderer>,
}

fn render(backend: &mut WaylandBackend) -> Result<(), String> {
    let Some(winit) = backend.graphic_renderer.as_mut() else {
        return Ok(());
    };

    let size = winit.window_size();
    let damage = Rectangle::from_size(size);
    let display = winit.egl_display();
    {
        let (renderer, mut framebuffer) = winit
            .bind()
            .map_err(|error| format!("Failed to bind EGL surface: {error}"))?;

        let mut elements = Vec::new();
        let mut from_hardware_buffers = Vec::new();
        for surface in backend.compositor.state.xdg_shell_state.toplevel_surfaces() {
            let surface = surface.wl_surface();
            if let Some(element) = hardware_buffer::render_element(renderer, display, surface) {
                elements.push(SurfaceElement::HardwareBuffer(element));
                from_hardware_buffers.push(surface.clone());
                continue;
            }
            elements.extend(
                render_elements_from_surface_tree::<_, WaylandSurfaceRenderElement<_>>(
                    renderer,
                    surface,
                    (0, 0),
                    1.0,
                    1.0,
                    Kind::Unspecified,
                )
                .into_iter()
                .map(SurfaceElement::Surface),
            );
        }

        let mut frame = renderer
            .render(&mut framebuffer, size, Transform::Flipped180)
            .map_err(|error| format!("Failed to render frame: {error:?}"))?;
        frame
            .clear(Color32F::new(0.1, 0.0, 0.0, 1.0), &[damage])
            .map_err(|error| format!("Failed to clear frame: {error:?}"))?;
        draw_render_elements(&mut frame, 1.0, &elements, &[damage])
            .map_err(|error| format!("Failed to draw render elements: {error:?}"))?;
        // We rely on the nested compositor to do the sync for us.
        let _ = frame
            .finish()
            .map_err(|error| format!("Failed to finish frame: {error:?}"))?;
        hardware_buffer::frame_submitted(display, &from_hardware_buffers);
    }

    winit
        .submit(Some(&[damage]))
        .map_err(|error| format!("Failed to submit frame: {error}"))?;

    Ok(())
}
