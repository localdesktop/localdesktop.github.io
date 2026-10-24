use crate::android::accessibility::AppUserEvent;
use smithay::reexports::rustix::event::{poll, PollFd, PollFlags};
use smithay::reexports::rustix::io::Errno;
use std::os::fd::OwnedFd;
use std::sync::mpsc;
use std::thread;
use winit::event_loop::EventLoopProxy;

/// Wakes the event loop with `AppUserEvent::WaylandReady` when a client connects or sends
/// requests, so the compositor can sleep instead of polling its sockets every frame.
pub struct WaylandWatcher {
    rearm: mpsc::Sender<()>,
}

impl WaylandWatcher {
    /// `fds` are the display's poll fd and the listening socket.
    pub fn spawn(fds: Vec<OwnedFd>, proxy: EventLoopProxy<AppUserEvent>) -> Self {
        let (rearm, rearmed) = mpsc::channel();
        thread::Builder::new()
            .name("wayland-watcher".into())
            .spawn(move || loop {
                let mut poll_fds = fds
                    .iter()
                    .map(|fd| PollFd::new(fd, PollFlags::IN))
                    .collect::<Vec<_>>();
                match poll(&mut poll_fds, -1) {
                    Ok(_) | Err(Errno::INTR) => {}
                    Err(error) => {
                        log::error!("Wayland watcher stopped: {error}");
                        return;
                    }
                }
                // Readiness is level-triggered: wait until the main thread has dispatched, or
                // this would spin while the same requests are still queued.
                if proxy.send_event(AppUserEvent::WaylandReady).is_err() || rearmed.recv().is_err()
                {
                    return;
                }
            })
            .expect("Failed to spawn the Wayland watcher thread");
        Self { rearm }
    }

    /// Resume watching once the pending requests have been dispatched.
    pub fn rearm(&self) {
        let _ = self.rearm.send(());
    }
}
