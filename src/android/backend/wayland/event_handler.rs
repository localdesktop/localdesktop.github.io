use crate::android::{
    accessibility,
    backend::wayland::{
        compositor::{send_frames_surface_tree, ClientState, State},
        CentralizedEvent, WaylandBackend,
    },
};
use smithay::backend::renderer::element::surface::{
    render_elements_from_surface_tree, WaylandSurfaceRenderElement,
};
use smithay::backend::renderer::element::Kind;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::backend::renderer::utils::draw_render_elements;
use smithay::backend::renderer::{Color32F, Frame, Renderer};
use smithay::input::keyboard::FilterResult;
use smithay::input::{pointer, touch};
use smithay::reexports::wayland_server::protocol::wl_pointer::ButtonState;
use smithay::utils::{Rectangle, Transform, SERIAL_COUNTER};
use smithay::wayland::shell::xdg::ToplevelSurface;
use smithay::{
    backend::input::{
        AbsolutePositionEvent, Axis, Event, InputEvent, KeyboardKeyEvent, PointerAxisEvent,
        PointerButtonEvent, TouchEvent,
    },
    output::{Mode, Scale},
};
use std::sync::Arc;
use winit::event_loop::{ActiveEventLoop, ControlFlow};

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

            // Redraw the application.
            //
            // It's preferable for applications that do not render continuously to render in
            // this event rather than in AboutToWait, since rendering in here allows
            // the program to gracefully handle redraws requested by the OS.

            // Draw.

            // Queue a RedrawRequested event.
            //
            // You only need to call this if you've determined that you need to redraw in
            // applications which do not always need to. Applications that redraw continuously
            // can render here instead.
            if let Some(winit) = backend.graphic_renderer.as_ref() {
                winit.window().request_redraw();
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
                    |_, _, _| {
                        //
                        FilterResult::Forward
                    },
                );
            }
            InputEvent::TouchDown { event } => {
                let compositor = &mut backend.compositor;
                let state = &mut compositor.state;
                if let Some(surface) = get_surface(state) {
                    compositor.keyboard.set_focus(
                        state,
                        Some(surface.wl_surface().clone()),
                        0.into(),
                    );
                    let serial = SERIAL_COUNTER.next_serial();
                    let time = compositor.start_time.elapsed().as_millis() as u32;
                    compositor.touch.down(
                        state,
                        Some((surface.wl_surface().clone(), (0f64, 0f64).into())),
                        &touch::DownEvent {
                            slot: event.slot(),
                            location: (event.x(), event.y()).into(),
                            serial,
                            time,
                        },
                    );
                };
            }
            InputEvent::TouchUp { event } => {
                let compositor = &mut backend.compositor;
                let state = &mut compositor.state;
                if let Some(_surface) = get_surface(state) {
                    let serial = SERIAL_COUNTER.next_serial();
                    let time = compositor.start_time.elapsed().as_millis() as u32;
                    compositor.touch.up(
                        state,
                        &touch::UpEvent {
                            slot: event.slot(),
                            serial,
                            time,
                        },
                    );
                };
            }
            InputEvent::TouchMotion { event } => {
                let compositor = &mut backend.compositor;
                let state = &mut compositor.state;
                if let Some(surface) = get_surface(state) {
                    let time = compositor.start_time.elapsed().as_millis() as u32;
                    compositor.touch.motion(
                        state,
                        Some((surface.wl_surface().clone(), (0f64, 0f64).into())),
                        &touch::MotionEvent {
                            slot: event.slot(),
                            location: (event.x(), event.y()).into(),
                            time,
                        },
                    );
                };
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

                let state = ButtonState::from(event.state());

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
        CentralizedEvent::Resized { size, scale_factor } => {
            if let Some(output) = &backend.compositor.output {
                // set the preferred mode
                output.change_current_state(
                    Some(Mode {
                        size: size.into(),
                        refresh: 60000,
                    }), // the resolution mode,
                    Some(Transform::Normal), // global screen transformation
                    Some(Scale::Fractional(scale_factor)), // global screen scaling factor
                    Some((0, 0).into()),     // output position
                );
            }

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
        // We rely on the nested compositor to do the sync for us.
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

    // It is important that all events on the display have been dispatched and flushed to clients
    // before swapping buffers because this operation may block.
    winit
        .submit(Some(&[damage]))
        .map_err(|error| format!("Failed to submit frame: {error}"))?;

    Ok(())
}
