use crate::android::{
    accessibility,
    backend::wayland::{
        compositor::{send_frames_surface_tree, ClientState, State},
        write_guest_output_state, CentralizedEvent, WaylandBackend,
    },
};
use smithay::backend::input::ButtonState;
use smithay::backend::renderer::element::surface::{
    render_elements_from_surface_tree, WaylandSurfaceRenderElement,
};
use smithay::backend::renderer::element::Kind;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::backend::renderer::utils::draw_render_elements;
use smithay::backend::renderer::{Color32F, Frame, Renderer};
use smithay::input::keyboard::FilterResult;
use smithay::input::pointer;
use smithay::utils::{Point, Rectangle, Transform, SERIAL_COUNTER};
use smithay::wayland::shell::xdg::ToplevelSurface;
use smithay::{
    backend::input::{
        AbsolutePositionEvent, Axis, Event, InputEvent, KeyboardKeyEvent, PointerAxisEvent,
        PointerButtonEvent,
    },
    output::{Mode, Scale},
};
use std::{
    collections::HashSet,
    sync::{Arc, LazyLock, Mutex},
};
use winit::event_loop::{ActiveEventLoop, ControlFlow};

/// Linux input event code for the left mouse button (`BTN_LEFT`).
const BTN_LEFT: u32 = 0x110;
/// How far a finger must travel before a touch becomes a drag (press-and-hold) rather than a tap.
const TAP_DRAG_THRESHOLD_PX: f64 = 25.0;

/// Physical pointer buttons currently held by Android.
///
/// Android's `button_state()` describes the state *after* an event. On some devices a button
/// release is therefore delivered with an empty mask and winit reports it as a left-button
/// release. Retaining the compositor-side state lets us reconcile that malformed release with
/// the one button that is actually held, preventing a permanent Wayland pointer grab.
static PRESSED_POINTER_BUTTONS: LazyLock<Mutex<HashSet<u32>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

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

fn focus_keyboard(compositor: &mut crate::android::backend::wayland::Compositor) {
    let state = &mut compositor.state;
    if let Some(surface) = get_surface(state) {
        compositor.keyboard.set_focus(
            state,
            Some(surface.wl_surface().clone()),
            SERIAL_COUNTER.next_serial().into(),
        );
    }
}

fn emit_pointer_button(
    compositor: &mut crate::android::backend::wayland::Compositor,
    button: u32,
    state: ButtonState,
    time: u32,
) {
    let pointer = compositor.pointer.clone();
    let compositor_state = &mut compositor.state;
    pointer.button(
        compositor_state,
        &pointer::ButtonEvent {
            button,
            state,
            serial: SERIAL_COUNTER.next_serial(),
            time,
        },
    );
    pointer.frame(compositor_state);
}

/// Press the left button. Also moves keyboard focus to the surface under the pointer.
fn emit_pointer_press(
    compositor: &mut crate::android::backend::wayland::Compositor,
    time: u32,
) {
    focus_keyboard(compositor);
    emit_pointer_button(compositor, BTN_LEFT, ButtonState::Pressed, time);
}

/// Release the left button.
fn emit_pointer_release(
    compositor: &mut crate::android::backend::wayland::Compositor,
    time: u32,
) {
    emit_pointer_button(compositor, BTN_LEFT, ButtonState::Released, time);
}

/// Release every physical pointer button known to be held.
fn release_physical_pointer_buttons(
    compositor: &mut crate::android::backend::wayland::Compositor,
    time: u32,
) {
    let buttons = {
        let mut pressed = PRESSED_POINTER_BUTTONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pressed.drain().collect::<Vec<_>>()
    };

    for button in buttons {
        emit_pointer_button(compositor, button, ButtonState::Released, time);
    }
}

/// Reconcile an Android/winit button event with the compositor's known button state.
fn reconcile_pointer_button(button: u32, state: ButtonState) -> u32 {
    let mut pressed = PRESSED_POINTER_BUTTONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    match state {
        ButtonState::Pressed => {
            pressed.insert(button);
            button
        }
        ButtonState::Released => {
            let resolved = if pressed.contains(&button) {
                button
            } else if pressed.len() == 1 {
                // Android reports an empty post-release mask on several devices. winit maps that
                // to BTN_LEFT, so use the sole held button as the real release target.
                *pressed.iter().next().expect("set length was checked")
            } else {
                button
            };
            pressed.remove(&resolved);
            resolved
        }
    }
}

/// A full tap: move to the location, then a press immediately followed by a release.
fn emit_pointer_click(
    compositor: &mut crate::android::backend::wayland::Compositor,
    x: f64,
    y: f64,
    time: u32,
) {
    emit_pointer_motion(compositor, x, y, time);
    emit_pointer_press(compositor, time);
    emit_pointer_release(compositor, time);
}

pub fn handle(event: CentralizedEvent, backend: &mut WaylandBackend, event_loop: &ActiveEventLoop) {
    match event {
        CentralizedEvent::CloseRequested => {
            event_loop.exit();
        }
        CentralizedEvent::Redraw => {
            if let Err(error) = redraw(backend) {
                log::error!("Redraw failed; dropping renderer until next resume: {error}");
                backend.graphic_renderer = None;
                accessibility::set_runtime_active(false);
                event_loop.set_control_flow(ControlFlow::Wait);
                return;
            }

            if let Some(winit) = backend.graphic_renderer.as_ref() {
                winit.window().request_redraw();
            }
        }
        CentralizedEvent::Focus(focused) => {
            if !focused {
                let time = backend.compositor.start_time.elapsed().as_millis() as u32;

                // Android can interrupt a gesture without delivering its release/cancel event.
                // Unwind both synthesized touch drags and physical mouse grabs before the app is
                // backgrounded so input works immediately when focus returns.
                if backend.pointer_pressed {
                    emit_pointer_release(&mut backend.compositor, time);
                    backend.pointer_pressed = false;
                }
                release_physical_pointer_buttons(&mut backend.compositor, time);
                backend.touch_points.clear();
                backend.scroll_centroid = None;
                backend.touch_gesture_was_multi_touch = false;
                backend.touch_down_position = None;
                backend.key_counter = 0;
            }
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
                    |_, _, _| FilterResult::Forward,
                );
            }
            InputEvent::TouchDown { event } => {
                emit_pointer_motion(
                    &mut backend.compositor,
                    event.x(),
                    event.y(),
                    event.time_msec(),
                );
            }
            InputEvent::TouchMotion { event } => {
                let time = event.time_msec();
                let (x, y) = (event.x(), event.y());

                if !backend.pointer_pressed {
                    let start = backend.touch_down_position;
                    let far_enough = start
                        .map(|s| {
                            let dx = s.x - x;
                            let dy = s.y - y;
                            dx * dx + dy * dy
                                > TAP_DRAG_THRESHOLD_PX * TAP_DRAG_THRESHOLD_PX
                        })
                        .unwrap_or(false);
                    if far_enough {
                        if let Some(s) = start {
                            emit_pointer_motion(&mut backend.compositor, s.x, s.y, time);
                        }
                        emit_pointer_press(&mut backend.compositor, time);
                        backend.pointer_pressed = true;
                    }
                }

                emit_pointer_motion(&mut backend.compositor, x, y, time);
            }
            InputEvent::TouchUp { event } => {
                let time = event.time_msec();
                emit_pointer_motion(&mut backend.compositor, event.x, event.y, time);

                if backend.pointer_pressed {
                    emit_pointer_release(&mut backend.compositor, time);
                    backend.pointer_pressed = false;
                } else if event.emit_click {
                    emit_pointer_click(&mut backend.compositor, event.x, event.y, time);
                }
            }
            InputEvent::TouchCancel { event } => {
                if backend.pointer_pressed {
                    emit_pointer_release(&mut backend.compositor, event.time() as u32);
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
                let state = event.state();
                let button = reconcile_pointer_button(event.button_code(), state);
                focus_keyboard(&mut backend.compositor);
                emit_pointer_button(
                    &mut backend.compositor,
                    button,
                    state,
                    event.time_msec(),
                );
            }
            InputEvent::PointerAxis { event } => {
                if backend.pointer_pressed {
                    emit_pointer_release(&mut backend.compositor, event.time_msec());
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

                let mut frame = pointer::AxisFrame::new(event.time_msec()).source(event.source());
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
            _ => {}
        },
        CentralizedEvent::Resized { size, scale_factor } => {
            backend.compositor.state.size = (size.w, size.h).into();

            if let Some(output) = &backend.compositor.output {
                output.change_current_state(
                    Some(Mode {
                        size: size.into(),
                        refresh: 60000,
                    }),
                    Some(Transform::Normal),
                    Some(Scale::Fractional(scale_factor)),
                    Some((0, 0).into()),
                );
            }

            let guest_scale = scale_factor.round().max(1.0) as i32;
            write_guest_output_state(size.w, size.h, guest_scale);

            if let Some(surface) = get_surface(&backend.compositor.state) {
                surface.xdg_toplevel().configure(size.w, size.h, vec![]);
            }
        }
        _ => (),
    }
}

fn redraw(backend: &mut WaylandBackend) -> Result<(), String> {
    let Some(winit) = backend.graphic_renderer.as_mut() else {
        return Ok(());
    };

    let size = winit.window_size();
    let damage = Rectangle::from_size(size);
    {
        let (renderer, mut framebuffer) = winit
            .bind()
            .map_err(|error| format!("Failed to bind EGL surface: {error}"))?;

        let compositor = &mut backend.compositor;

        let elements = compositor
            .state
            .xdg_shell_state
            .toplevel_surfaces()
            .iter()
            .flat_map(|surface| {
                render_elements_from_surface_tree(
                    renderer,
                    surface.wl_surface(),
                    (0, 0),
                    1.0,
                    1.0,
                    Kind::Unspecified,
                )
            })
            .collect::<Vec<WaylandSurfaceRenderElement<GlesRenderer>>>();

        let mut frame = renderer
            .render(&mut framebuffer, size, Transform::Flipped180)
            .map_err(|error| format!("Failed to render frame: {error:?}"))?;
        frame
            .clear(Color32F::new(0.1, 0.0, 0.0, 1.0), &[damage])
            .map_err(|error| format!("Failed to clear frame: {error:?}"))?;
        draw_render_elements(&mut frame, 1.0, &elements, &[damage])
            .map_err(|error| format!("Failed to draw render elements: {error:?}"))?;
        let _ = frame
            .finish()
            .map_err(|error| format!("Failed to finish frame: {error:?}"))?;

        for surface in compositor.state.xdg_shell_state.toplevel_surfaces() {
            send_frames_surface_tree(
                surface.wl_surface(),
                compositor.start_time.elapsed().as_millis() as u32,
            );
        }

        match compositor.listener.accept() {
            Ok(Some(stream)) => match compositor
                .display
                .handle()
                .insert_client(stream, Arc::new(ClientState::default()))
            {
                Ok(client) => compositor.clients.push(client),
                Err(error) => log::error!("Failed to insert Wayland client: {error}"),
            },
            Ok(None) => {}
            Err(error) => log::error!("Failed to accept Wayland client: {error}"),
        }

        compositor
            .display
            .dispatch_clients(&mut compositor.state)
            .map_err(|error| format!("Failed to dispatch clients: {error}"))?;
        compositor
            .display
            .flush_clients()
            .map_err(|error| format!("Failed to flush clients: {error}"))?;
    }

    winit
        .submit(Some(&[damage]))
        .map_err(|error| format!("Failed to submit frame: {error}"))?;

    Ok(())
}
