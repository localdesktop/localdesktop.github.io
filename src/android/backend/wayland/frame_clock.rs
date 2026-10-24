use crate::android::accessibility::AppUserEvent;
use libloading::Library;
use std::ffi::c_void;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use winit::event_loop::EventLoopProxy;

type FrameCallback = unsafe extern "C" fn(frame_time_nanos: i64, data: *mut c_void);
type GetInstance = unsafe extern "C" fn() -> *mut c_void;
type PostFrameCallback = unsafe extern "C" fn(*mut c_void, FrameCallback, *mut c_void);

static PROXY: OnceLock<EventLoopProxy<AppUserEvent>> = OnceLock::new();

unsafe extern "C" fn on_frame(_frame_time_nanos: i64, _data: *mut c_void) {
    if let Some(proxy) = PROXY.get() {
        let _ = proxy.send_event(AppUserEvent::Vsync);
    }
}

struct Choreographer {
    _lib: Library,
    instance: *mut c_void,
    post: PostFrameCallback,
}

impl Choreographer {
    /// `AChoreographer` is API 24+, and must be created on the thread whose looper delivers it.
    fn load() -> Option<Self> {
        let lib = unsafe { Library::new("libandroid.so") }.ok()?;
        let get_instance =
            *unsafe { lib.get::<GetInstance>(b"AChoreographer_getInstance\0") }.ok()?;
        let post = unsafe { lib.get::<PostFrameCallback>(b"AChoreographer_postFrameCallback64\0") }
            .or_else(|_| unsafe {
                lib.get::<PostFrameCallback>(b"AChoreographer_postFrameCallback\0")
            })
            .map(|symbol| *symbol)
            .ok()?;
        let instance = unsafe { get_instance() };
        if instance.is_null() {
            return None;
        }
        Some(Self {
            _lib: lib,
            instance,
            post,
        })
    }
}

/// Paces the compositor to the display: one `AppUserEvent::Vsync` per requested refresh, so it
/// renders and releases frame callbacks at most once per frame and sleeps when nothing changes.
pub struct FrameClock {
    choreographer: Option<Choreographer>,
    requested_at: Option<Instant>,
    /// Fallback when `AChoreographer` is unavailable: tick on a timer at the refresh rate.
    period: Duration,
    deadline: Option<Instant>,
}

/// A callback that hasn't fired by then was lost (e.g. the window went away), so post another.
const LOST_CALLBACK_AFTER: Duration = Duration::from_millis(250);

impl FrameClock {
    pub fn new(proxy: EventLoopProxy<AppUserEvent>, refresh_millihz: i32) -> Self {
        let _ = PROXY.set(proxy);
        let choreographer = Choreographer::load();
        if choreographer.is_none() {
            log::warn!("AChoreographer unavailable, pacing frames with a timer");
        }
        Self {
            choreographer,
            requested_at: None,
            period: Duration::from_secs_f64(1000.0 / refresh_millihz.max(1000) as f64),
            deadline: None,
        }
    }

    /// Ask for one `AppUserEvent::Vsync` at the next display refresh.
    pub fn request(&mut self) {
        let now = Instant::now();
        if self
            .requested_at
            .is_some_and(|at| now.duration_since(at) < LOST_CALLBACK_AFTER)
        {
            return;
        }
        self.requested_at = Some(now);
        match &self.choreographer {
            Some(choreographer) => unsafe {
                (choreographer.post)(choreographer.instance, on_frame, std::ptr::null_mut());
            },
            None => self.deadline = Some(now + self.period),
        }
    }

    /// Called when the `AppUserEvent::Vsync` arrives.
    pub fn ticked(&mut self) {
        self.requested_at = None;
        self.deadline = None;
    }

    /// When the timer fallback should fire, if it is in use.
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
}
