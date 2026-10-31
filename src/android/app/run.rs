use std::sync::Arc;
use std::thread;

use super::build::{PolarBearApp, PolarBearBackend};
use crate::android::{
    accessibility::{self, AppUserEvent},
    backend::{
        pipewire_standalone_aaudio,
        wayland::{
            bind, centralize, centralize_injected_keyboard, dispatch_clients, handle, idle,
            on_external_pointer, on_vsync, paint_trackpad, start_frame_loop,
            write_guest_output_state, CentralizedEvent, State, WaylandBackend,
        },
        webview::ErrorVariant,
    },
    external_display,
    proot::launch::launch,
    utils::{
        ndk::{self, run_in_jvm},
        webview::show_webview_popup,
    },
};
use crate::core::config;
use smithay::output::{Mode, Output, PhysicalProperties, Scale, Subpixel};
use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
use smithay::utils::Transform;
use smithay::wayland::shell::xdg::ToplevelSurface;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow};
use winit::window::WindowId;

fn configure_output(backend: &mut WaylandBackend) {
    let Some(winit) = backend.graphic_renderer.as_ref() else {
        return;
    };

    let window_size = winit.output_size();
    let size = (window_size.w, window_size.h);
    let (guest_scale_factor, refresh_millihz) = match winit.external_surface() {
        Some(surface) => (
            (surface.density_dpi as f64 / 160.0).max(1.0),
            surface.refresh_millihz,
        ),
        // Not `winit.scale_factor()`: that reads `AConfiguration`, which still reports the 160
        // dpi default on the first launch and only becomes accurate after a configuration change.
        None => (
            ndk::scale_factor(&backend.android_app),
            ndk::refresh_rate_millihz(&backend.android_app),
        ),
    };
    backend.guest_scale_factor = guest_scale_factor;
    backend.refresh_millihz = refresh_millihz;
    backend.compositor.state.size = size.into();

    let output = backend
        .compositor
        .output
        .get_or_insert_with(|| {
            Output::new(
                "Local Desktop Wayland Compositor".into(),
                PhysicalProperties {
                    size: size.into(),
                    subpixel: Subpixel::HorizontalRgb,
                    make: "Local Desktop".into(),
                    model: config::VERSION.into(),
                },
            )
        })
        .clone();

    if backend.compositor.output_global.is_none() {
        let dh = backend.compositor.display.handle();
        backend.compositor.output_global = Some(output.create_global::<State>(&dh));
    }

    output.change_current_state(
        Some(Mode {
            size: size.into(),
            refresh: backend.refresh_millihz,
        }),
        Some(Transform::Normal),
        Some(Scale::Integer(1)),
        Some((0, 0).into()),
    );

    let guest_scale = guest_scale_factor.round().max(1.0) as i32;
    let touch_keyboard = winit.external_surface().is_none();
    write_guest_output_state(window_size.w, window_size.h, guest_scale, touch_keyboard);

    for surface in backend.compositor.state.xdg_shell_state.toplevel_surfaces() {
        configure_toplevel(surface, window_size.w, window_size.h);
    }
}

/// Draw to the external monitor if one is connected, otherwise back to the phone's screen.
fn apply_external_display(backend: &mut WaylandBackend) {
    let Some(winit) = backend.graphic_renderer.as_mut() else {
        return;
    };
    let surface = external_display::surface();
    let unchanged = match (&surface, winit.external_surface()) {
        (Some(new), Some(current)) => Arc::ptr_eq(new, current),
        (None, None) => true,
        _ => false,
    };
    if unchanged {
        return;
    }
    let attached = match surface {
        Some(surface) => match winit.attach_external(surface) {
            Ok(()) => true,
            Err(error) => {
                log::error!("{error}");
                false
            }
        },
        None => false,
    };
    if !attached {
        winit.detach_external();
    }
    external_display::set_in_use(attached);

    backend.reset_touch_state();
    configure_output(backend);
    if attached {
        let size = backend.compositor.state.size;
        backend.cursor_position = (size.w as f64 / 2.0, size.h as f64 / 2.0).into();
        paint_trackpad(backend);
    }
}

fn configure_toplevel(surface: &ToplevelSurface, width: i32, height: i32) {
    surface.with_pending_state(|state| {
        state.size.replace((width, height).into());
        state.states.set(xdg_toplevel::State::Activated);
    });
    surface.send_configure();
}

impl ApplicationHandler<AppUserEvent> for PolarBearApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        run_in_jvm(
            accessibility::show_keyboard_shortcuts_prompt,
            self.frontend.android_app.clone(),
        );
        match self.backend {
            PolarBearBackend::WebView(ref mut backend) => {
                accessibility::set_runtime_active(false);
                let url = match backend.error {
                    ErrorVariant::None => {
                        let port = backend.socket_port;
                        format!("file:///android_asset/setup-progress.html?port={}", port)
                    }
                    ErrorVariant::Unsupported => {
                        format!("file:///android_asset/unsupported.html")
                    }
                };
                let android_app = self.frontend.android_app.clone();
                thread::spawn(move || {
                    run_in_jvm(
                        move |env, app| {
                            show_webview_popup(env, app, &url);
                        },
                        android_app,
                    );
                });
            }
            PolarBearBackend::Wayland(ref mut backend) => {
                if backend.graphic_renderer.is_none() {
                    match bind(event_loop) {
                        Ok(winit) => backend.graphic_renderer = Some(winit),
                        Err(error) => {
                            log::error!("Failed to initialize Wayland renderer on resume: {error}");
                            accessibility::set_runtime_active(false);
                            event_loop.set_control_flow(ControlFlow::Wait);
                            return;
                        }
                    }
                } else if let Some(winit) = backend.graphic_renderer.as_mut() {
                    // Back from the background, where only the external display was drawn to.
                    if let Err(error) = winit.resume_window() {
                        log::error!("Failed to draw to the window again on resume: {error}");
                    }
                }

                apply_external_display(backend);
                configure_output(backend);
                accessibility::set_runtime_active(true);
                run_in_jvm(external_display::start, self.frontend.android_app.clone());

                start_frame_loop(backend, &self.frontend.proxy);
                handle(CentralizedEvent::Redraw, backend, event_loop);
                launch();
                // Start the standalone-client PipeWire/AAudio backend.
                pipewire_standalone_aaudio::spawn_after_ready(self.frontend.android_app.clone());
            }
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: AppUserEvent) {
        let PolarBearBackend::Wayland(backend) = &mut self.backend else {
            accessibility::drain_pending_events();
            return;
        };

        match event {
            AppUserEvent::AccessibilityInputReady => {
                for event in accessibility::drain_pending_events() {
                    let event = centralize_injected_keyboard(
                        event.scancode,
                        event.state,
                        event.event_time_ms,
                        backend,
                    );
                    handle(event, backend, event_loop);
                }
            }
            AppUserEvent::WaylandReady => dispatch_clients(backend),
            AppUserEvent::Vsync => on_vsync(backend),
            AppUserEvent::ExternalDisplayChanged => {
                apply_external_display(backend);
                handle(CentralizedEvent::Redraw, backend, event_loop);
            }
            AppUserEvent::ExternalPointer => {
                for event in external_display::drain_pointer_events() {
                    on_external_pointer(backend, event);
                }
            }
            AppUserEvent::KeyboardRequested => {
                if backend.is_trackpad() && backend.window_visible() {
                    run_in_jvm(
                        external_display::show_keyboard,
                        self.frontend.android_app.clone(),
                    );
                }
            }
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if let PolarBearBackend::Wayland(backend) = &mut self.backend {
            idle(backend, event_loop);
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if let PolarBearBackend::Wayland(backend) = &mut self.backend {
            if backend.graphic_renderer.is_none() {
                if matches!(event, WindowEvent::CloseRequested) {
                    event_loop.exit();
                } else {
                    log::info!(
                        "Ignoring window event while renderer is suspended: {:?}",
                        event
                    );
                }
                return;
            }

            // Map raw events to our own events
            let event = centralize(event, backend);

            // Handle the centralized events
            handle(event, backend, event_loop);
        }
    }

    fn suspended(&mut self, event_loop: &ActiveEventLoop) {
        accessibility::set_runtime_active(false);
        event_loop.set_control_flow(ControlFlow::Wait);

        if let PolarBearBackend::Wayland(backend) = &mut self.backend {
            backend.key_counter = 0;
            backend.reset_touch_state();
            backend.pointer_pressed = false;

            if backend.is_trackpad() {
                // The monitor stays a desktop display, for a mouse and keyboard on it.
                if let Some(winit) = backend.graphic_renderer.as_mut() {
                    winit.suspend_window();
                }
                run_in_jvm(
                    external_display::background,
                    self.frontend.android_app.clone(),
                );
                return;
            }

            backend.graphic_renderer = None;
            external_display::set_in_use(false);
            run_in_jvm(external_display::stop, self.frontend.android_app.clone());
            // Kill the standalone-client PipeWire/AAudio backend if it was started.
            pipewire_standalone_aaudio::shutdown();
        }
    }
}
