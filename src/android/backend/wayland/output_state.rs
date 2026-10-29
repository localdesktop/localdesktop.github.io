use crate::core::config;
use std::path::PathBuf;

/// Persist host window geometry for guest-side labwc autostart (`localdesktop-wlroots-output`).
///
/// The file lives in the proot-visible `/tmp` directory so scripts running inside the
/// Xfce/labwc session can align wlroots output mode/scale with the Android winit window.
/// `touch_keyboard` is off while the desktop is on an external display, where the phone is the
/// trackpad and the Android keyboard types instead.
pub fn write_guest_output_state(width: i32, height: i32, scale: i32, touch_keyboard: bool) {
    if width <= 0 || height <= 0 || scale <= 0 {
        return;
    }

    let path = PathBuf::from(config::ARCH_FS_ROOT).join("tmp/localdesktop-output");
    let touch_keyboard = u8::from(touch_keyboard);
    let content = format!(
        "LOCALDESKTOP_OUTPUT_MODE={width}x{height}\nLOCALDESKTOP_OUTPUT_SCALE={scale}\nLOCALDESKTOP_TOUCH_KEYBOARD={touch_keyboard}\n"
    );
    if let Err(error) = std::fs::write(&path, content) {
        log::warn!(
            "Failed to write guest output state to {}: {error}",
            path.display()
        );
    }
}
