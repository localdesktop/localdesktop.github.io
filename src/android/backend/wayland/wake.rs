//! Wakes the winit event loop when a Wayland client has something for us.
//!
//! With `ControlFlow::Wait` the loop only runs on Android events, so client requests (new
//! connections, commits, requests) would sit in the socket until the next unrelated wake-up.
//! android-activity ignores looper fds it does not own, hence a helper thread that `poll(2)`s the
//! display and the listening socket and posts an [`AppUserEvent`] through the event loop proxy.

use crate::android::accessibility::{send_user_event, AppUserEvent};
use std::{
    os::fd::RawFd,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, Thread},
    time::Duration,
};

const POLLIN: i16 = 0x0001;

#[repr(C)]
struct PollFd {
    fd: RawFd,
    events: i16,
    revents: i16,
}

extern "C" {
    fn poll(fds: *mut PollFd, nfds: u64, timeout: i32) -> i32;
}

/// Shared with the poll thread. The event loop calls [`WaylandWaker::acknowledge`] after it has
/// dispatched the clients; until then the thread posts nothing more, so a level-triggered fd cannot
/// flood the loop.
pub struct WaylandWaker {
    pending: Arc<AtomicBool>,
    thread: Thread,
}

impl WaylandWaker {
    /// `display_fd` and `listener_fd` must stay open for the life of the process (the compositor
    /// is never dropped while the app runs).
    pub fn spawn(display_fd: RawFd, listener_fd: RawFd) -> std::io::Result<WaylandWaker> {
        let pending = Arc::new(AtomicBool::new(false));
        let handle = {
            let pending = pending.clone();
            thread::Builder::new()
                .name("wayland-wake".into())
                .spawn(move || watch(display_fd, listener_fd, &pending))?
        };
        Ok(WaylandWaker {
            pending,
            thread: handle.thread().clone(),
        })
    }

    /// Call after the clients have been dispatched so the next readiness wakes the loop again.
    pub fn acknowledge(&self) {
        self.pending.store(false, Ordering::Release);
        self.thread.unpark();
    }
}

fn watch(display_fd: RawFd, listener_fd: RawFd, pending: &AtomicBool) {
    let mut fds = [
        PollFd { fd: display_fd, events: POLLIN, revents: 0 },
        PollFd { fd: listener_fd, events: POLLIN, revents: 0 },
    ];
    loop {
        // Don't poll while the loop still owes us an acknowledgement: the fd would just report
        // the same data again.
        while pending.load(Ordering::Acquire) {
            thread::park_timeout(Duration::from_millis(250));
        }

        let ready = unsafe { poll(fds.as_mut_ptr(), fds.len() as u64, -1) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            log::error!("Wayland wake thread stopped: poll failed: {error}");
            return;
        }
        if ready == 0 {
            continue;
        }

        pending.store(true, Ordering::Release);
        while !send_user_event(AppUserEvent::WaylandReadable) {
            // The event loop proxy is not registered yet.
            thread::sleep(Duration::from_millis(50));
        }
    }
}
