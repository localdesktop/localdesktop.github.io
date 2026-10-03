use std::thread;

use super::build::{PolarBearApp, PolarBearBackend};
use crate::android::{
    accessibility::{self, AppUserEvent},
    backend::{
        pipewire_standalone_aaudio,
        wayland::{
            apply_immersive_and_flags, bind, centralize, centralize_device_event,
            centralize_injected_keyboard, handle, reconfigure, release_all_keys, request_redraw,
            reset_all_touch, service_clients, set_hinge_angle, start_hinge, stop_hinge,
            sync_pointer_capture, tick,
        },
        webview::{installer_url, ErrorVariant},
    },
    proot::launch::launch,
    utils::{host_bridge, ndk::run_in_jvm, webview::show_webview_popup},
};
use winit::application::ApplicationHandler;
use winit::event::{DeviceEvent, DeviceId, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow};
use winit::window::WindowId;

impl ApplicationHandler<AppUserEvent> for PolarBearApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        match &mut self.backend {
            PolarBearBackend::WebView(backend) => {
                accessibility::set_runtime_active(false);
                let url = match backend.error {
                    ErrorVariant::None => installer_url(backend.socket_port),
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
            PolarBearBackend::Wayland(backend) => {
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
                } else {
                    log::info!("Ignoring redundant resume while renderer is already active");
                }
                backend.render_failures = 0;
                backend.frame_rate_applied = None;
                backend.damage_tracker = None;

                backend.window_focused = backend
                    .graphic_renderer
                    .as_ref()
                    .map(|winit| winit.window().has_focus())
                    .unwrap_or(true);
                accessibility::set_window_focused(backend.window_focused);

                // Output geometry, refresh rate and the guest's output state first: the guest
                // sizes its desktop from them.
                reconfigure(backend);
                apply_immersive_and_flags(backend);
                start_hinge(backend);
                accessibility::set_runtime_active(true);

                if backend.config.session.foreground_service {
                    host_bridge::start_session_service(&backend.android_app);
                }

                // Pick up anything a client sent while there was no window.
                service_clients(backend);
                sync_pointer_capture(backend);
                backend.compositor.state.damaged = true;
                request_redraw(backend);

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
            AppUserEvent::WaylandReadable => {
                // Clients wrote something (or connected): dispatch it now rather than at the
                // next frame, and draw if it changed what is on screen.
                service_clients(backend);
            }
            AppUserEvent::HingeAngle(angle) => set_hinge_angle(backend, angle),
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if let PolarBearBackend::Wayland(backend) = &mut self.backend {
            if backend.graphic_renderer.is_none() {
                if matches!(event, WindowEvent::CloseRequested) {
                    event_loop.exit();
                } else {
                    log::trace!("Ignoring a window event while the renderer is suspended");
                }
                return;
            }

            // Map raw events to our own events
            let event = centralize(event, backend);

            // Handle the centralized events
            handle(event, backend, event_loop);
        }
    }

    fn device_event(&mut self, event_loop: &ActiveEventLoop, _id: DeviceId, event: DeviceEvent) {
        if let PolarBearBackend::Wayland(backend) = &mut self.backend {
            if backend.graphic_renderer.is_none() {
                return;
            }
            let event = centralize_device_event(event, backend);
            handle(event, backend, event_loop);
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if let PolarBearBackend::Wayland(backend) = &mut self.backend {
            tick(backend, event_loop);
        }
    }

    fn suspended(&mut self, event_loop: &ActiveEventLoop) {
        accessibility::set_runtime_active(false);
        accessibility::set_window_focused(false);
        event_loop.set_control_flow(ControlFlow::Wait);

        if let PolarBearBackend::Wayland(backend) = &mut self.backend {
            reset_all_touch(backend);
            release_all_keys(backend);
            backend.graphic_renderer = None;
            backend.damage_tracker = None;
            backend.key_counter = 0;
            backend.pointer_pressed = false;
            backend.window_focused = false;
            stop_hinge(backend);
            if backend.capture.requested {
                backend.capture.requested = false;
                host_bridge::set_pointer_capture(&backend.android_app, false);
            }
            // With the foreground service the session, and its audio, keep running while the
            // window is gone (Android 17 mutes background audio otherwise); without it nothing
            // protects the processes, so stop the audio helpers too.
            if !backend.config.session.foreground_service {
                pipewire_standalone_aaudio::shutdown();
            }
        }
    }
}
