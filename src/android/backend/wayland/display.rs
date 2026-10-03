//! Display facts the compositor derives from the Android side: guest UI scale, refresh rate and
//! the frame-rate hint for the window surface.

use crate::android::utils::host_bridge;
use crate::core::config::DisplayConfig;
use std::ffi::c_void;
use winit::platform::android::activity::AndroidApp;

/// Logical density baseline: 160 dpi is Android's 1x bucket.
const BASELINE_DPI: f32 = 160.0;
/// Extra factor on top of the density so the desktop is comfortable at arm's length.
const UI_SCALE_BOOST: f32 = 1.1;
/// `ANATIVEWINDOW_FRAME_RATE_COMPATIBILITY_DEFAULT`: "UIs, animations, scrolling" – the platform
/// may pick a multiple of the rate.
const FRAME_RATE_COMPATIBILITY_DEFAULT: i8 = 0;

/// Final guest UI scale (passed to `wlr-randr --scale` and used for the Xft DPI).
///
/// Auto (`ui_scale == 0`) derives it from the Android density, rounded to the nearest 0.25 and
/// never below 1. The guest renders `render_scale` times fewer pixels than the display has, so the
/// scale shrinks by the same factor to keep controls the same physical size.
pub fn guest_ui_scale(config: &DisplayConfig, density_dpi: i32, render_scale: f32) -> f32 {
    if config.ui_scale > 0.0 {
        return (config.ui_scale * render_scale).max(0.5);
    }
    let base = (density_dpi.max(1) as f32 / BASELINE_DPI) * UI_SCALE_BOOST;
    ((base * render_scale * 4.0).round() / 4.0).max(1.0)
}

/// The refresh rate to run at: `display.refresh_rate`, or the highest the display offers.
pub fn target_refresh_hz(app: &AndroidApp, config: &DisplayConfig) -> f32 {
    if config.refresh_rate > 0 {
        return config.refresh_rate as f32;
    }
    host_bridge::display_refresh_rates(app)
        .into_iter()
        .fold(0.0_f32, f32::max)
        .max(60.0)
}

type SetFrameRate = unsafe extern "C" fn(*mut c_void, f32, i8) -> i32;

/// `ANativeWindow_setFrameRate` (API 30): tells SurfaceFlinger which rate this surface wants, so the
/// panel can run at 120 Hz on purpose instead of by buffer-cadence heuristics. Below API 30 the
/// symbol is missing and the hint is skipped.
pub fn set_frame_rate(native_window: *mut c_void, hz: f32) {
    if native_window.is_null() || hz <= 0.0 {
        return;
    }
    let library = match unsafe { libloading::Library::new("libandroid.so") } {
        Ok(library) => library,
        Err(error) => {
            log::warn!("Cannot load libandroid.so for the frame-rate hint: {error}");
            return;
        }
    };
    let Ok(function) = (unsafe { library.get::<SetFrameRate>(b"ANativeWindow_setFrameRate\0") })
    else {
        log::info!("ANativeWindow_setFrameRate is not available on this Android version");
        return;
    };
    let result = unsafe { function(native_window, hz, FRAME_RATE_COMPATIBILITY_DEFAULT) };
    if result != 0 {
        log::warn!("ANativeWindow_setFrameRate({hz}) failed with {result}");
    }
}
