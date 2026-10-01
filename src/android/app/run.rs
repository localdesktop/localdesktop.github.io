use std::thread;

use super::build::{PolarBearApp, PolarBearBackend};
use crate::android::{
    accessibility::{self, AppUserEvent},
    backend::{
        pipewire_standalone_aaudio,
        wayland::{
            bind, centralize, centralize_injected_keyboard, handle, write_guest_output_state,
            CentralizedEvent, State,
        },
        webview::ErrorVariant,
    },
    proot::launch::launch,
    utils::{
        ndk::{self, run_in_jvm},
        webview::show_webview_popup,
    },
};
use crate::core::config;
use jni::objects::{JObject, JValue};
use smithay::output::{Mode, Output, PhysicalProperties, Scale, Subpixel};
use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
use smithay::utils::Transform;
use smithay::wayland::shell::xdg::ToplevelSurface;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow};
use winit::platform::android::activity::AndroidApp;
use winit::window::WindowId;

// A compact, application-owned cursor. Android accessibility settings can scale system pointer
// icons substantially; using a custom icon keeps the pointer size stable inside Local Desktop.
const LOCAL_POINTER_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 16, 0, 0, 0,
    24, 8, 6, 0, 0, 0, 243, 160, 125, 12, 0, 0, 0, 136, 73, 68, 65, 84, 120, 218, 173,
    148, 75, 18, 192, 32, 8, 67, 77, 198, 251, 95, 153, 46, 106, 109, 107, 253, 64, 42, 43,
    199, 153, 60, 4, 130, 41, 109, 10, 83, 133, 252, 11, 169, 0, 51, 147, 32, 124, 213, 33,
    64, 248, 105, 70, 16, 194, 110, 71, 3, 16, 14, 199, 114, 67, 76, 2, 92, 144, 213, 107,
    232, 50, 201, 4, 66, 183, 211, 6, 16, 134, 236, 218, 129, 48, 236, 249, 6, 146, 87, 2, 0,
    179, 253, 65, 30, 137, 74, 166, 122, 229, 158, 66, 155, 49, 52, 198, 34, 198, 121, 68,
    204, 202, 15, 177, 188, 141, 248, 86, 3, 183, 145, 176, 227, 71, 146, 237, 236, 208, 154,
    121, 54, 115, 102, 24, 249, 211, 93, 198, 1, 62, 182, 71, 1, 8, 185, 87, 167, 0, 0, 0,
    0, 73, 69, 78, 68, 174, 66, 96, 130,
];

fn set_local_pointer(android_app: AndroidApp, enabled: bool) {
    run_in_jvm(
        |env, app| {
            let activity = unsafe { JObject::from_raw(app.activity_as_ptr() as *mut _) };
            let result = (|| -> jni::errors::Result<()> {
                let window = env
                    .call_method(&activity, "getWindow", "()Landroid/view/Window;", &[])?
                    .l()?;
                let decor_view = env
                    .call_method(window, "getDecorView", "()Landroid/view/View;", &[])?
                    .l()?;

                if enabled {
                    let bytes = env.byte_array_from_slice(LOCAL_POINTER_PNG)?;
                    let bitmap = env
                        .call_static_method(
                            "android/graphics/BitmapFactory",
                            "decodeByteArray",
                            "([BII)Landroid/graphics/Bitmap;",
                            &[
                                JValue::Object(&JObject::from(bytes)),
                                JValue::Int(0),
                                JValue::Int(LOCAL_POINTER_PNG.len() as i32),
                            ],
                        )?
                        .l()?;
                    let pointer_icon = env
                        .call_static_method(
                            "android/view/PointerIcon",
                            "create",
                            "(Landroid/graphics/Bitmap;FF)Landroid/view/PointerIcon;",
                            &[
                                JValue::Object(&bitmap),
                                JValue::Float(1.0),
                                JValue::Float(1.0),
                            ],
                        )?
                        .l()?;
                    env.call_method(
                        decor_view,
                        "setPointerIcon",
                        "(Landroid/view/PointerIcon;)V",
                        &[JValue::Object(&pointer_icon)],
                    )?;
                } else {
                    env.call_method(
                        decor_view,
                        "setPointerIcon",
                        "(Landroid/view/PointerIcon;)V",
                        &[JValue::Object(&JObject::null())],
                    )?;
                }
                Ok(())
            })();

            if let Err(error) = result {
                log::warn!("Failed to update Local Desktop pointer icon: {error}");
            }
            std::mem::forget(activity);
        },
        android_app,
    );
}

fn configure_output(backend: &mut crate::android::backend::wayland::WaylandBackend) {
    let Some(winit) = backend.graphic_renderer.as_ref() else {
        return;
    };

    let window_size = winit.window_size();
    let size = (window_size.w, window_size.h);
    // Not `winit.scale_factor()`: that reads `AConfiguration`, which still reports the 160 dpi
    // default on the first launch and only becomes accurate after a configuration change.
    let guest_scale_factor = ndk::scale_factor(&backend.android_app);
    backend.guest_scale_factor = guest_scale_factor;
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
            refresh: 60000,
        }),
        Some(Transform::Normal),
        Some(Scale::Integer(1)),
        Some((0, 0).into()),
    );

    let guest_scale = guest_scale_factor.round().max(1.0) as i32;
    write_guest_output_state(window_size.w, window_size.h, guest_scale);

    for surface in backend.compositor.state.xdg_shell_state.toplevel_surfaces() {
        configure_toplevel(surface, window_size.w, window_size.h);
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
                } else {
                    log::info!("Ignoring redundant resume while renderer is already active");
                }

                set_local_pointer(self.frontend.android_app.clone(), true);
                configure_output(backend);
                accessibility::set_runtime_active(true);

                if let Some(winit) = backend.graphic_renderer.as_ref() {
                    winit.window().request_redraw();
                }
                handle(CentralizedEvent::Redraw, backend, event_loop);
                launch();
                // Start the standalone-client PipeWire/AAudio backend.
                pipewire_standalone_aaudio::spawn_after_ready(self.frontend.android_app.clone());
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
            set_local_pointer(self.frontend.android_app.clone(), false);
            backend.graphic_renderer = None;
            backend.key_counter = 0;
            backend.reset_touch_state();
            backend.pointer_pressed = false;
            // Kill the standalone-client PipeWire/AAudio backend if it was started.
            pipewire_standalone_aaudio::shutdown();
        }
    }
}
