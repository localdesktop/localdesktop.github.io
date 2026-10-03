use crate::core::config;
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

/// `O_NONBLOCK` on Linux; a FIFO opened with it fails with `ENXIO` instead of blocking when
/// nothing reads it.
const O_NONBLOCK: i32 = 0o4000;
const ENXIO: i32 = 6;

/// Updates closer together than this are merged. Dragging a DeX window resizes it every frame, and
/// every update makes the guest run `wlr-randr` under proot.
const MIN_WRITE_INTERVAL: Duration = Duration::from_millis(150);

/// Geometry the host asks the guest to apply to its labwc output.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GuestOutput {
    /// Guest render size in physical pixels (after render scale, without the touchpad area).
    pub width: i32,
    pub height: i32,
    /// Final UI scale for `wlr-randr --scale` and the Xft DPI.
    pub scale: f32,
    pub refresh_hz: u32,
}

#[derive(Default)]
struct Throttle {
    written: Option<GuestOutput>,
    last_write: Option<Instant>,
    pending: Option<GuestOutput>,
}

static STATE: Mutex<Throttle> = Mutex::new(Throttle {
    written: None,
    last_write: None,
    pending: None,
});

fn lock() -> std::sync::MutexGuard<'static, Throttle> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn guest_tmp_dir() -> PathBuf {
    PathBuf::from(config::ARCH_FS_ROOT).join("tmp")
}

/// Persist the output geometry for the guest-side `localdesktop-wlroots-output` script and wake it.
///
/// The state file lives in the proot-visible `/tmp`. It is replaced atomically (write + rename), so
/// the guest never reads a half-written file, then one line is written to the guest's FIFO so the
/// script re-reads it immediately instead of waiting for its fallback timer. Repeated identical
/// states are skipped, and a burst of changes is merged: when the previous write is recent the new
/// state is kept as pending until [`flush_pending_output_state`] writes it.
pub fn write_guest_output_state(output: GuestOutput) {
    if output.width <= 0 || output.height <= 0 || output.scale <= 0.0 || output.refresh_hz == 0 {
        return;
    }

    let mut throttle = lock();
    if throttle.written == Some(output) && throttle.pending.is_none() {
        return;
    }
    let recent = throttle
        .last_write
        .map(|at| at.elapsed() < MIN_WRITE_INTERVAL)
        .unwrap_or(false);
    if recent {
        throttle.pending = Some(output);
        return;
    }
    throttle.pending = None;
    write_now(&mut throttle, output);
}

/// Write a state that was held back by the rate limit once it is old enough. Returns how long the
/// caller should wait before calling again, or `None` when nothing is pending.
pub fn flush_pending_output_state() -> Option<Duration> {
    let mut throttle = lock();
    let pending = throttle.pending?;
    let elapsed = throttle
        .last_write
        .map(|at| at.elapsed())
        .unwrap_or(MIN_WRITE_INTERVAL);
    if elapsed < MIN_WRITE_INTERVAL {
        return Some(MIN_WRITE_INTERVAL - elapsed);
    }
    throttle.pending = None;
    if throttle.written != Some(pending) {
        write_now(&mut throttle, pending);
    }
    None
}

fn write_now(throttle: &mut Throttle, output: GuestOutput) {
    let dir = guest_tmp_dir();
    let path = dir.join("localdesktop-output");
    let temp_path = dir.join("localdesktop-output.tmp");
    let content = format!(
        "LOCALDESKTOP_OUTPUT_MODE={}x{}\nLOCALDESKTOP_OUTPUT_SCALE={:.2}\nLOCALDESKTOP_OUTPUT_REFRESH={}\n",
        output.width, output.height, output.scale, output.refresh_hz
    );
    let result = fs::write(&temp_path, content).and_then(|()| fs::rename(&temp_path, &path));
    if let Err(error) = result {
        log::warn!(
            "Failed to write guest output state to {}: {error}",
            path.display()
        );
        // Try again on the next change.
        throttle.written = None;
        return;
    }
    throttle.written = Some(output);
    throttle.last_write = Some(Instant::now());

    wake_guest(&dir);
}

/// Tell the guest script the state file changed. No reader (the session has not started, or the
/// script is not running) is not an error.
fn wake_guest(dir: &std::path::Path) {
    let fifo = dir.join("localdesktop-output.fifo");
    match OpenOptions::new()
        .write(true)
        .custom_flags(O_NONBLOCK)
        .open(&fifo)
    {
        Ok(mut file) => {
            // A full pipe means a wake-up is already pending.
            let _ = file.write_all(b"changed\n");
        }
        Err(error)
            if error.kind() == ErrorKind::NotFound || error.raw_os_error() == Some(ENXIO) => {}
        Err(error) => log::warn!("Failed to wake guest output script: {error}"),
    }
}
