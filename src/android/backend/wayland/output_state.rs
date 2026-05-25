use crate::core::config;
use std::path::PathBuf;

/// Persist host window geometry for guest-side labwc autostart (`localdesktop-wlroots-output`).
///
/// The file lives in the proot-visible `/tmp` directory so scripts running inside the
/// Xfce/labwc session can align wlroots output mode/scale with the Android winit window.
pub fn write_guest_output_state(width: i32, height: i32, scale: i32) {
    if width <= 0 || height <= 0 || scale <= 0 {
        return;
    }

    let path = PathBuf::from(config::ARCH_FS_ROOT).join("tmp/localdesktop-output");
    let content = format!(
        "LOCALDESKTOP_OUTPUT_MODE={width}x{height}\nLOCALDESKTOP_OUTPUT_SCALE={scale}\n"
    );
    if let Err(error) = std::fs::write(&path, content) {
        log::warn!("Failed to write guest output state to {}: {error}", path.display());
    }
}
