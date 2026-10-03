use crate::android::{
    accessibility,
    backend::wayland::{
        bind,
        compositor::{pointer_locked, State},
        event_centralizer::PadTouch,
        input::WinitMouseWheelEvent,
        output,
        output_state::flush_pending_output_state,
        render,
        touchpad::PadAction,
        CentralizedEvent, TouchMode, WaylandBackend,
    },
    utils::host_bridge,
};
use smithay::backend::input::ButtonState;
use smithay::input::keyboard::FilterResult;
use smithay::input::pointer::{self, RelativeMotionEvent};
use smithay::reexports::wayland_server::protocol::wl_pointer::ButtonState as WlButtonState;
use smithay::utils::{Logical, Physical, Point, SERIAL_COUNTER};
use smithay::wayland::shell::xdg::ToplevelSurface;
use smithay::backend::input::{
    AbsolutePositionEvent, Axis, Event, InputEvent, KeyboardKeyEvent, PointerAxisEvent,
    PointerButtonEvent,
};
use std::time::{Duration, Instant};
use winit::dpi::PhysicalPosition;
use winit::event::{ElementState, MouseScrollDelta};
use winit::event_loop::{ActiveEventLoop, ControlFlow};

/// Linux input event code for the left mouse button (`BTN_LEFT`).
const BTN_LEFT: u32 = 0x110;
/// Linux input event code for the right mouse button (`BTN_RIGHT`).
const BTN_RIGHT: u32 = 0x111;

const KEY_LEFTCTRL: u32 = 29;
const KEY_RIGHTCTRL: u32 = 97;
const KEY_LEFTALT: u32 = 56;
const KEY_RIGHTALT: u32 = 100;

/// Redraw attempts (after errors) before the renderer is left dropped until the next resume.
const MAX_RENDER_RECOVERIES: u8 = 3;

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
    Point<f64, Logical>,
)> {
    get_surface(state).map(|surface| (surface.wl_surface().clone(), (0f64, 0f64).into()))
}

fn window_point(x: f64, y: f64) -> Point<f64, Physical> {
    Point::from((x, y))
}

/// Move the pointer to a position in guest coordinates.
fn emit_pointer_motion(backend: &mut WaylandBackend, location: Point<f64, Logical>, time: u32) {
    let cursor_visible = backend.cursor_visible();
    let compositor = &mut backend.compositor;
    let pointer = compositor.pointer.clone();
    let state = &mut compositor.state;

    if compositor.pointer_location == location && pointer.current_focus().is_some() {
        return;
    }
    if let Some(focus) = pointer_focus(state) {
        let serial = SERIAL_COUNTER.next_serial();
        pointer.motion(
            state,
            Some(focus),
            &pointer::MotionEvent {
                location,
                serial,
                time,
            },
        );
        pointer.frame(state);
    }
    compositor.pointer_location = location;
    if cursor_visible {
        // The guest cursor is drawn by us.
        state.damaged = true;
    }
}

/// Move the pointer by a relative amount (guest pixels). While the guest holds a pointer lock only
/// the relative event is sent and the pointer stays where it is.
fn emit_relative_motion(backend: &mut WaylandBackend, dx: f64, dy: f64, time: u32) {
    if dx == 0.0 && dy == 0.0 {
        return;
    }
    let locked = pointer_locked(&backend.compositor.state, &backend.compositor.pointer);
    if !locked {
        let current = backend.compositor.pointer_location;
        let target = backend
            .layout
            .clamp_to_guest(Point::from((current.x + dx, current.y + dy)));
        emit_pointer_motion(backend, target, time);
    }

    let compositor = &mut backend.compositor;
    let pointer = compositor.pointer.clone();
    let state = &mut compositor.state;
    if let Some(focus) = pointer_focus(state) {
        pointer.relative_motion(
            state,
            Some(focus),
            &RelativeMotionEvent {
                delta: (dx, dy).into(),
                delta_unaccel: (dx, dy).into(),
                utime: time as u64 * 1000,
            },
        );
        pointer.frame(state);
    }
}

/// Press a button. Also moves keyboard focus to the surface under the pointer.
fn emit_pointer_press(backend: &mut WaylandBackend, button: u32, time: u32) {
    let compositor = &mut backend.compositor;
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
fn emit_pointer_release(backend: &mut WaylandBackend, button: u32, time: u32) {
    let compositor = &mut backend.compositor;
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
    backend: &mut WaylandBackend,
    button: u32,
    location: Point<f64, Logical>,
    time: u32,
) {
    emit_pointer_motion(backend, location, time);
    emit_pointer_press(backend, button, time);
    emit_pointer_release(backend, button, time);
}

/// Scroll by `event`; pixel deltas are in window pixels and are converted to guest pixels.
fn emit_axis(backend: &mut WaylandBackend, event: WinitMouseWheelEvent) {
    let event = match event.delta {
        MouseScrollDelta::PixelDelta(delta) => {
            let (dx, dy) = backend.layout.window_delta_to_guest((delta.x, delta.y));
            WinitMouseWheelEvent {
                time: event.time,
                delta: MouseScrollDelta::PixelDelta(PhysicalPosition { x: dx, y: dy }),
            }
        }
        MouseScrollDelta::LineDelta(..) => event,
    };

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
        frame = frame.relative_direction(Axis::Vertical, event.relative_direction(Axis::Vertical));
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

/// Arm the long press once the finger has stayed put for `ViewConfiguration`'s timeout.
///
/// No button is sent here: moving afterwards starts a drag with the left button held, lifting
/// instead fires a right click. Called from [`tick`] when the loop wakes for the deadline.
fn poll_long_press(backend: &mut WaylandBackend) {
    if backend.touch_mode != TouchMode::Undecided || backend.touch_points.len() != 1 {
        return;
    }
    let (Some(down_time), Some(down_position)) =
        (backend.touch_down_time, backend.touch_down_position)
    else {
        return;
    };
    let now = backend.clock.now().as_millis() as u64;
    if now.saturating_sub(down_time) < backend.long_press_timeout_ms {
        return;
    }

    backend.touch_mode = TouchMode::LongPress;
    // Anchor the pointer where the finger landed, so a drag selects from there.
    let location = backend
        .layout
        .window_to_guest(window_point(down_position.x, down_position.y));
    emit_pointer_motion(backend, location, now as u32);
}

/// Perform what the touchpad state machine decided.
fn apply_pad_actions(backend: &mut WaylandBackend, actions: Vec<PadAction>, time: u64) {
    let time = time as u32;
    for action in actions {
        match action {
            PadAction::Move { dx, dy } => {
                let (dx, dy) = backend.layout.window_delta_to_guest((dx, dy));
                emit_relative_motion(backend, dx, dy, time);
            }
            PadAction::Button { button, pressed: true } => emit_pointer_press(backend, button, time),
            PadAction::Button { button, pressed: false } => {
                emit_pointer_release(backend, button, time)
            }
            PadAction::Scroll { dx, dy } => emit_axis(
                backend,
                WinitMouseWheelEvent {
                    time: time as u64,
                    delta: MouseScrollDelta::PixelDelta(PhysicalPosition { x: dx, y: dy }),
                },
            ),
        }
    }
}

/// Drop every in-flight touch gesture, releasing any button they hold.
pub fn reset_all_touch(backend: &mut WaylandBackend) {
    let time = backend.clock.now().as_millis() as u64;
    if backend.pointer_pressed {
        emit_pointer_release(backend, BTN_LEFT, time as u32);
        backend.pointer_pressed = false;
    }
    backend.reset_touch_state();
    backend.touch_routes.clear();
    let mut actions = Vec::new();
    backend.touchpad.reset(&mut actions);
    apply_pad_actions(backend, actions, time);
}

/// Request or release Android pointer capture to match what is wanted right now: the guest holds a
/// pointer lock, or `input.pointer_capture` is on and a mouse is in use. Never while the window is
/// unfocused or after the user released it with Ctrl+Alt.
pub fn sync_pointer_capture(backend: &mut WaylandBackend) {
    let locked = pointer_locked(&backend.compositor.state, &backend.compositor.pointer);
    let wanted = backend.window_focused
        && !backend.capture.released_by_user
        && (locked || (backend.config.input.pointer_capture && backend.capture.mouse_seen));
    if wanted != backend.capture.requested {
        backend.capture.requested = wanted;
        host_bridge::set_pointer_capture(&backend.android_app, wanted);
        // Whether the guest cursor is drawn depends on capture.
        backend.compositor.state.damaged = true;
    }
}

fn note_mouse_used(backend: &mut WaylandBackend) {
    if !backend.capture.mouse_seen {
        backend.capture.mouse_seen = true;
        sync_pointer_capture(backend);
    }
}

/// Ctrl+Alt pressed and released without another key in between toggles pointer capture. The keys
/// still reach the guest.
fn track_capture_chord(backend: &mut WaylandBackend, key: u32, state: ElementState) {
    let pressed = state == ElementState::Pressed;
    let is_ctrl = key == KEY_LEFTCTRL || key == KEY_RIGHTCTRL;
    let is_alt = key == KEY_LEFTALT || key == KEY_RIGHTALT;

    if is_ctrl {
        backend.capture.ctrl_down = pressed;
    } else if is_alt {
        backend.capture.alt_down = pressed;
    }

    if pressed {
        backend.capture.chord_candidate = (is_ctrl || is_alt)
            && backend.capture.ctrl_down
            && backend.capture.alt_down;
        return;
    }

    if (is_ctrl || is_alt) && std::mem::take(&mut backend.capture.chord_candidate) {
        if backend.capture.requested {
            backend.capture.released_by_user = true;
        } else if backend.capture.released_by_user {
            backend.capture.released_by_user = false;
        }
        sync_pointer_capture(backend);
    }
}

pub fn handle(event: CentralizedEvent, backend: &mut WaylandBackend, event_loop: &ActiveEventLoop) {
    match event {
        CentralizedEvent::CloseRequested => {
            event_loop.exit();
        }
        CentralizedEvent::Redraw => {
            match render::redraw(backend) {
                Ok(()) => backend.render_failures = 0,
                Err(error) => recover_renderer(backend, event_loop, &error),
            }
            return;
        }
        CentralizedEvent::DisplayChanged => {
            output::reconfigure(backend);
            output::apply_immersive_and_flags(backend);
        }
        CentralizedEvent::Focus(focused) => {
            accessibility::set_window_focused(focused);
            backend.window_focused = focused;
            if focused {
                output::apply_immersive_and_flags(backend);
                // Android drops capture when focus is lost; asking again is part of `sync`.
                backend.capture.released_by_user = false;
            } else {
                reset_all_touch(backend);
            }
            sync_pointer_capture(backend);
        }
        CentralizedEvent::RelativeMotion { dx, dy, time } => {
            note_mouse_used(backend);
            let (dx, dy) = backend.layout.window_delta_to_guest((dx, dy));
            emit_relative_motion(backend, dx, dy, time as u32);
        }
        CentralizedEvent::Pad { event, time } => {
            let mut actions = Vec::new();
            match event {
                PadTouch::Down { id, position, zone } => backend.touchpad.touch_down(
                    id,
                    (position.x, position.y),
                    time,
                    zone,
                    &mut actions,
                ),
                PadTouch::Move { id, position } => {
                    backend
                        .touchpad
                        .touch_move(id, (position.x, position.y), time, &mut actions)
                }
                PadTouch::Up { id } => backend.touchpad.touch_up(id, time, &mut actions),
                PadTouch::Cancel { .. } => backend.touchpad.reset(&mut actions),
            }
            apply_pad_actions(backend, actions, time);
        }
        CentralizedEvent::Input(event) => handle_input(event, backend),
        CentralizedEvent::Unsupported => return,
    }

    // Whatever was queued for the guest goes out now: nothing else would flush it while the loop
    // sleeps.
    if let Err(error) = backend.compositor.display.flush_clients() {
        log::error!("Failed to flush Wayland clients: {error}");
    }
    if backend.compositor.state.damaged {
        render::request_redraw(backend);
    }
}

fn handle_input(event: InputEvent<super::input::WinitInput>, backend: &mut WaylandBackend) {
    match event {
        InputEvent::Keyboard { event } => {
            track_capture_chord(backend, event.key, event.state);

            let compositor = &mut backend.compositor;
            let state = &mut compositor.state;
            if compositor.keyboard.current_focus().is_none() {
                // Typing before the first click: the guest still has to see the keys.
                if let Some(surface) = get_surface(state) {
                    compositor.keyboard.set_focus(
                        state,
                        Some(surface.wl_surface().clone()),
                        SERIAL_COUNTER.next_serial(),
                    );
                }
            }
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
            let location = backend
                .layout
                .window_to_guest(window_point(event.x(), event.y()));
            emit_pointer_motion(backend, location, event.time_msec());
        }
        InputEvent::TouchMotion { event } => {
            let time = event.time_msec();

            // The centralizer only emits motion in Drag mode, and flips into it on the
            // first move after a long press — that transition is where the grab starts.
            if !backend.pointer_pressed {
                emit_pointer_press(backend, BTN_LEFT, time);
                backend.pointer_pressed = true;
            }

            let location = backend
                .layout
                .window_to_guest(window_point(event.x(), event.y()));
            emit_pointer_motion(backend, location, time);
        }
        InputEvent::TouchUp { event } => {
            let time = event.time_msec();
            let location = backend
                .layout
                .window_to_guest(window_point(event.x, event.y));

            if backend.pointer_pressed {
                // End of a drag.
                emit_pointer_motion(backend, location, time);
                emit_pointer_release(backend, BTN_LEFT, time);
                backend.pointer_pressed = false;
            } else {
                match event.mode {
                    // A tap: left click where the finger lifted.
                    TouchMode::Undecided => emit_pointer_click(backend, BTN_LEFT, location, time),
                    // Held still, then lifted without moving: a context menu, as on Android.
                    TouchMode::LongPress => emit_pointer_click(backend, BTN_RIGHT, location, time),
                    // A scroll consumed the gesture; nothing to click.
                    TouchMode::Scroll | TouchMode::Drag => {}
                }
            }
        }
        InputEvent::TouchCancel { event } => {
            if backend.pointer_pressed {
                emit_pointer_release(backend, BTN_LEFT, event.time() as u32);
                backend.pointer_pressed = false;
            }
        }
        InputEvent::PointerMotionAbsolute { event, .. } => {
            note_mouse_used(backend);
            let position = (event.x(), event.y());
            let previous = backend.last_mouse_position.replace(position);

            if backend
                .layout
                .in_touchpad(window_point(position.0, position.1))
            {
                // The touchpad area is for fingers; a mouse hovering there does nothing.
                backend.mouse_in_panel = true;
                return;
            }
            backend.mouse_in_panel = false;

            let time = event.time_msec();
            if pointer_locked(&backend.compositor.state, &backend.compositor.pointer) {
                // The guest locked the pointer but Android is still sending positions (capture
                // not granted yet): turn them into relative movement.
                if let Some(previous) = previous {
                    let (dx, dy) = backend
                        .layout
                        .window_delta_to_guest((position.0 - previous.0, position.1 - previous.1));
                    emit_relative_motion(backend, dx, dy, time);
                }
                return;
            }

            let location = backend
                .layout
                .window_to_guest(window_point(position.0, position.1));
            emit_pointer_motion(backend, location, time);
        }
        InputEvent::PointerButton { event, .. } => {
            note_mouse_used(backend);
            if backend.mouse_in_panel {
                return;
            }
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
                emit_pointer_release(backend, BTN_LEFT, event.time_msec());
                backend.pointer_pressed = false;
            }
            emit_axis(backend, event);
        }
        _ => {}
    }
}

/// The renderer failed: drop it and try to build a new one a few times; the next resume starts
/// over regardless.
fn recover_renderer(backend: &mut WaylandBackend, event_loop: &ActiveEventLoop, error: &str) {
    backend.render_failures += 1;
    log::error!(
        "Redraw failed ({} in a row): {error}",
        backend.render_failures
    );
    backend.graphic_renderer = None;
    backend.damage_tracker = None;

    if backend.render_failures <= MAX_RENDER_RECOVERIES {
        match bind(event_loop) {
            Ok(winit) => {
                backend.graphic_renderer = Some(winit);
                backend.frame_rate_applied = None;
                output::reconfigure(backend);
                backend.compositor.state.damaged = true;
                render::request_redraw(backend);
                return;
            }
            Err(error) => log::error!("Failed to rebuild the renderer: {error}"),
        }
    }

    accessibility::set_runtime_active(false);
    event_loop.set_control_flow(ControlFlow::Wait);
}

/// Runs timers (long press, tap-and-drag release) and sets the event loop to sleep until the next
/// one is due, or indefinitely when none is.
pub fn tick(backend: &mut WaylandBackend, event_loop: &ActiveEventLoop) {
    if backend.graphic_renderer.is_none() {
        event_loop.set_control_flow(ControlFlow::Wait);
        return;
    }

    let now = backend.clock.now().as_millis() as u64;
    poll_long_press(backend);

    let mut actions = Vec::new();
    backend.touchpad.tick(now, &mut actions);
    if !actions.is_empty() {
        apply_pad_actions(backend, actions, now);
    }

    let long_press_deadline = (backend.touch_mode == TouchMode::Undecided
        && backend.touch_points.len() == 1)
        .then(|| {
            backend
                .touch_down_time
                .map(|down| down + backend.long_press_timeout_ms)
        })
        .flatten();
    let timer_wait = [long_press_deadline, backend.touchpad.next_deadline()]
        .into_iter()
        .flatten()
        .min()
        .map(|deadline| Duration::from_millis(deadline.saturating_sub(now)));
    // A guest output update held back by the rate limit.
    let output_wait = flush_pending_output_state();

    match [timer_wait, output_wait].into_iter().flatten().min() {
        Some(wait) => {
            event_loop.set_control_flow(ControlFlow::WaitUntil(Instant::now() + wait));
        }
        None => event_loop.set_control_flow(ControlFlow::Wait),
    }

    if let Err(error) = backend.compositor.display.flush_clients() {
        log::error!("Failed to flush Wayland clients: {error}");
    }
    if backend.compositor.state.damaged {
        render::request_redraw(backend);
    }
}
