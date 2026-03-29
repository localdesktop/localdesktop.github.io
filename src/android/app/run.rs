use std::thread;

use super::build::{PolarBearApp, PolarBearBackend};
use crate::android::{
    accessibility::{self, AppUserEvent},
    backend::{
        wayland::{bind, centralize, centralize_injected_keyboard, handle, State},
        webview::ErrorVariant,
    },
    proot::launch::launch,
    utils::{ndk::run_in_jvm, webview::show_webview_popup},
};
use crate::core::config;
use smithay::output::{Mode, Output, PhysicalProperties, Scale, Subpixel};
use smithay::utils::Transform;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::ActiveEventLoop;
use winit::window::WindowId;

impl ApplicationHandler<AppUserEvent> for PolarBearApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
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
                // Initialize the Wayland backend
                let winit = bind(&event_loop);
                let window_size = winit.window_size();
                let scale_factor = winit.scale_factor();
                let size = (window_size.w, window_size.h);
                backend.graphic_renderer = Some(winit);
                backend.compositor.state.size = size.into();

                // Create the Output with given name and physical properties.
                let output = Output::new(
                    "Local Desktop Wayland Compositor".into(), // the name of this output,
                    PhysicalProperties {
                        size: size.into(),                 // dimensions (width, height) in mm
                        subpixel: Subpixel::HorizontalRgb, // subpixel information
                        make: "Local Desktop".into(),      // make of the monitor
                        model: config::VERSION.into(),     // model of the monitor
                    },
                );

                let dh = backend.compositor.display.handle();
                // create a global, if you want to advertise it to clients
                let _global = output.create_global::<State>(
                    &dh, // the display
                ); // you can drop the global, if you never intend to destroy it.
                   // Now you can configure it
                output.change_current_state(
                    Some(Mode {
                        size: size.into(),
                        refresh: 60000,
                    }), // the resolution mode,
                    Some(Transform::Normal), // global screen transformation
                    Some(Scale::Fractional(scale_factor)), // global screen scaling factor
                    Some((0, 0).into()),     // output position
                );

                backend.compositor.output.replace(output);
                accessibility::set_runtime_active(true);

                launch();
            }
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, _event: AppUserEvent) {
        let PolarBearBackend::Wayland(backend) = &mut self.backend else {
            accessibility::drain_pending_events();
            return;
        };

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

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if let PolarBearBackend::Wayland(backend) = &mut self.backend {
            // Map raw events to our own events
            let event = centralize(event, backend);

            // Handle the centralized events
            handle(event, backend, event_loop);
        }
    }

    fn suspended(&mut self, _event_loop: &ActiveEventLoop) {
        accessibility::set_runtime_active(false);
    }
}
