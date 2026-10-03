use super::process::ArchProcess;
use crate::android::utils::application_context::get_application_context;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;

/// State of the desktop session started by `launch()`.
///
/// A launch is "running" from the moment it is accepted until the proot process it started
/// is gone. The pid is checked against the process table instead of trusting the session
/// thread alone: that thread only returns once every holder of the session's stdout pipe
/// closed it, which can be later than the death of proot itself.
struct Session {
    /// Bumped on every accepted launch so a slow, superseded thread cannot clear the state
    /// of the session that replaced it.
    generation: u64,
    /// A launch was accepted but its proot process has not been spawned yet.
    starting: bool,
    pid: Option<u32>,
}

static SESSION: Mutex<Session> = Mutex::new(Session {
    generation: 0,
    starting: false,
    pid: None,
});

fn session() -> std::sync::MutexGuard<'static, Session> {
    SESSION.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Process exists and is not a zombie.
fn process_alive(pid: u32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/stat")).map_or(false, |stat| {
        // `pid (comm) S ...`: the state follows the last closing parenthesis.
        stat.rsplit(')')
            .next()
            .and_then(|rest| rest.trim_start().chars().next())
            .map_or(false, |state| state != 'Z' && state != 'X')
    })
}

fn is_proot(pid: u32) -> bool {
    fs::read(format!("/proc/{pid}/cmdline"))
        .map_or(false, |cmdline| String::from_utf8_lossy(&cmdline).contains("libproot"))
}

fn pid_file() -> PathBuf {
    get_application_context().data_dir.join("session.pid")
}

/// Ends a proot session left behind by an earlier incarnation of this app process (its pid file
/// survives the process). Such a session lost its compositor and would only hold the X11 lock
/// files and the guest's runtime directory; `--kill-on-exit` makes proot take its tracees along.
fn stop_stale_session() {
    let Some(pid) = fs::read_to_string(pid_file())
        .ok()
        .and_then(|content| content.trim().parse::<u32>().ok())
    else {
        return;
    };

    if pid != std::process::id() && process_alive(pid) && is_proot(pid) {
        log::warn!("Stopping stale desktop session (proot pid {pid})");
        // SAFETY: plain signal delivery to a pid we just verified to be our own proot child.
        unsafe { kill(pid as i32, SIGTERM) };
        for _ in 0..30 {
            if !process_alive(pid) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if process_alive(pid) {
            unsafe { kill(pid as i32, SIGKILL) };
        }
    }
    let _ = fs::remove_file(pid_file());
}

/// Clears the session state when the session thread ends, however it ends (including a panic).
struct SessionGuard {
    generation: u64,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        let mut session = session();
        if session.generation == self.generation {
            session.starting = false;
            session.pid = None;
            let own_pid_file = fs::read_to_string(pid_file())
                .ok()
                .and_then(|content| content.trim().parse::<u32>().ok());
            if own_pid_file.map_or(false, |pid| !process_alive(pid)) {
                let _ = fs::remove_file(pid_file());
            }
        }
    }
}

/// Starts the desktop session in the background. Does nothing while a session is alive, so it
/// is safe to call on every activity (re)creation.
pub fn launch() {
    let generation = {
        let mut session = session();
        if session.starting || session.pid.map_or(false, process_alive) {
            log::info!("Skipping launch because the desktop session is already running");
            return;
        }
        session.generation += 1;
        session.starting = true;
        session.pid = None;
        session.generation
    };

    thread::spawn(move || {
        let _guard = SessionGuard { generation };

        stop_stale_session();

        // Leftovers of a previous session: X11 display :1 and the output watcher's lock.
        ArchProcess {
            command: "rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 /tmp/localdesktop-wlroots-output.pid"
                .into(),
            user: None,
            log: None,
        }
        .run();

        let local_config = get_application_context().local_config;
        let username = local_config.user.username;

        ArchProcess {
            command: local_config.command.launch,
            user: Some(username),
            log: Some(Arc::new(|it| log::trace!("{}", it))),
        }
        .run_tracked(move |pid| {
            let mut session = session();
            if session.generation == generation {
                session.starting = false;
                session.pid = Some(pid);
            }
            if let Err(error) = fs::write(pid_file(), pid.to_string()) {
                log::warn!("Could not record the session pid: {error}");
            }
        });
    });
}
