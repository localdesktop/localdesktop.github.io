//! Keeps the Wayland output, the guest's geometry and the Android window in step: fold/unfold,
//! rotation, DeX window resizes, density changes, refresh rate and the laptop-mode split.

use super::{
    display::{guest_ui_scale, set_frame_rate, target_refresh_hz},
    hinge::{is_half_open, HingeSensor},
    layout::{Layout, MIN_RENDER_SCALE},
    output_state::{write_guest_output_state, GuestOutput},
    render::request_redraw,
    State, WaylandBackend,
};
use crate::android::utils::{host_bridge, ndk};
use crate::core::config::{self, LaptopMode};
use smithay::output::{Mode, Output, PhysicalProperties, Scale, Subpixel};
use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
use smithay::utils::{Physical, Size, Transform};
use smithay::wayland::shell::xdg::ToplevelSurface;

/// Millimetres per inch, to report a physical size that matches the display density.
const MM_PER_INCH: f64 = 25.4;
/// Frames drawn in full after the layout changed. The EGL surface adopts the new window size at
/// its next dequeue, so the first frame can still land in an old-sized buffer.
const FULL_REDRAWS_AFTER_LAYOUT: u8 = 2;

/// Whether the window should be split into guest + touchpad for a window of `window` pixels.
fn laptop_wanted(backend: &WaylandBackend, window: Size<i32, Physical>) -> bool {
    let landscape = window.w > window.h;
    match backend.config.display.laptop_mode {
        LaptopMode::Off => false,
        // Forced on: split whenever the window is landscape; there is no posture to consult.
        LaptopMode::On => landscape,
        // The panel folds along the vertical axis of the display in its natural rotation, so the
        // hinge is horizontal (at mid-height of a full-screen window) when the display is
        // rotated by 90° or 270°. Without a readable rotation fall back to the window shape.
        LaptopMode::Auto => {
            backend.hinge_half_open
                && match backend.display_rotation {
                    Some(rotation) => rotation == 1 || rotation == 3,
                    None => landscape,
                }
        }
    }
}

/// Re-read density, rotation and refresh rate from Android and apply the resulting layout.
/// Call on resume and whenever the window, density or configuration may have changed.
pub fn reconfigure(backend: &mut WaylandBackend) {
    let Some(winit) = backend.graphic_renderer.as_ref() else {
        return;
    };

    backend.density_dpi = ndk::density_dpi(&backend.android_app);
    backend.guest_scale_factor = (backend.density_dpi as f64 / 160.0).max(1.0);
    backend.display_rotation = ndk::display_rotation(&backend.android_app);
    backend.refresh_hz = target_refresh_hz(&backend.android_app, &backend.config.display);
    let window_key = (winit.native_window() as usize, backend.refresh_hz.to_bits());
    if backend.frame_rate_applied != Some(window_key) {
        set_frame_rate(winit.native_window(), backend.refresh_hz);
        backend.frame_rate_applied = Some(window_key);
    }

    apply_layout(backend);
}

/// Re-apply what Android resets on focus loss, display moves and configuration changes: the
/// immersive system UI and the keep-screen-on flag.
pub fn apply_immersive_and_flags(backend: &WaylandBackend) {
    host_bridge::apply_immersive(&backend.android_app);
    host_bridge::set_keep_screen_on(&backend.android_app, backend.config.display.keep_screen_on);
}

fn create_output(backend: &mut WaylandBackend, window: Size<i32, Physical>) -> Output {
    let compositor = &mut backend.compositor;
    let dpi = backend.density_dpi.max(1) as f64;
    let output = compositor
        .output
        .get_or_insert_with(|| {
            Output::new(
                "Local Desktop Wayland Compositor".into(),
                PhysicalProperties {
                    size: (
                        (window.w as f64 / dpi * MM_PER_INCH).round() as i32,
                        (window.h as f64 / dpi * MM_PER_INCH).round() as i32,
                    )
                        .into(),
                    subpixel: Subpixel::HorizontalRgb,
                    make: "Local Desktop".into(),
                    model: config::VERSION.into(),
                },
            )
        })
        .clone();

    if compositor.output_global.is_none() {
        let dh = compositor.display.handle();
        compositor.output_global = Some(output.create_global::<State>(&dh));
    }
    output
}

fn configure_toplevel(surface: &ToplevelSurface, width: i32, height: i32) {
    let changed = surface.with_pending_state(|state| {
        let size = Some((width, height).into());
        let changed = state.size != size;
        state.size = size;
        state.states.set(xdg_toplevel::State::Activated);
        changed
    });
    if changed {
        surface.send_configure();
    }
}

/// Compute the layout for the current window size and apply it to the output, the toplevels and
/// the guest state file.
pub fn apply_layout(backend: &mut WaylandBackend) {
    let Some(winit) = backend.graphic_renderer.as_ref() else {
        return;
    };
    let window = winit.window_size();
    if window.w <= 0 || window.h <= 0 {
        return;
    }

    backend.laptop_active = laptop_wanted(backend, window);
    let render_scale = backend
        .config
        .display
        .render_scale
        .clamp(MIN_RENDER_SCALE, 1.0);
    let layout = Layout::compute(window, render_scale, backend.laptop_active);
    let layout_changed = layout != backend.layout;
    backend.layout = layout;

    let guest = layout.guest_size;
    backend.compositor.state.size = guest;

    let output = create_output(backend, window);
    let refresh_hz = backend.refresh_hz.round().max(1.0) as u32;
    output.change_current_state(
        Some(Mode {
            size: (guest.w, guest.h).into(),
            refresh: refresh_hz as i32 * 1000,
        }),
        Some(Transform::Normal),
        Some(Scale::Integer(1)),
        Some((0, 0).into()),
    );

    // The UI scale follows the share of display pixels the guest actually gets.
    let effective_render_scale = guest.w as f32 / layout.guest_area.size.w.max(1) as f32;
    write_guest_output_state(GuestOutput {
        width: guest.w,
        height: guest.h,
        scale: guest_ui_scale(
            &backend.config.display,
            backend.density_dpi,
            effective_render_scale.clamp(MIN_RENDER_SCALE, 1.0),
        ),
        refresh_hz,
    });

    for surface in backend.compositor.state.xdg_shell_state.toplevel_surfaces() {
        configure_toplevel(surface, guest.w, guest.h);
    }

    backend.panel.update_layout(&layout);

    if !backend.pointer_centered {
        backend.pointer_centered = true;
        backend.compositor.pointer_location = (guest.w as f64 / 2.0, guest.h as f64 / 2.0).into();
    } else {
        backend.compositor.pointer_location = layout.clamp_to_guest(backend.compositor.pointer_location);
    }

    if layout_changed {
        log::info!(
            "Output layout: window {}x{}, guest {}x{} @{refresh_hz} Hz, touchpad {:?}",
            window.w,
            window.h,
            guest.w,
            guest.h,
            layout.touchpad_area.map(|area| (area.loc.x, area.loc.y, area.size.w, area.size.h)),
        );
        // Fingers that landed under the old layout belong to regions that no longer exist.
        super::event_handler::reset_all_touch(backend);
        backend.damage_tracker = None;
        backend.full_redraws_pending = FULL_REDRAWS_AFTER_LAYOUT;
    }
    backend.compositor.state.damaged = true;
    request_redraw(backend);
}

/// The hinge sensor reported a posture change (angle in degrees).
pub fn set_hinge_angle(backend: &mut WaylandBackend, angle: f32) {
    let half_open = is_half_open(angle, backend.hinge_half_open);
    if half_open == backend.hinge_half_open {
        return;
    }
    backend.hinge_half_open = half_open;
    if backend.config.display.laptop_mode == LaptopMode::Auto {
        // Transition in or out of the split takes effect at once, including the guest's output.
        apply_layout(backend);
    }
}

/// Start the hinge angle sensor if the posture can matter (`laptop_mode = auto`).
pub fn start_hinge(backend: &mut WaylandBackend) {
    if backend.config.display.laptop_mode != LaptopMode::Auto || backend.hinge.is_some() {
        return;
    }
    backend.hinge = HingeSensor::start();
}

/// Stop the sensor (when the window goes away) and forget the posture it reported.
pub fn stop_hinge(backend: &mut WaylandBackend) {
    backend.hinge = None;
    backend.hinge_half_open = false;
}
