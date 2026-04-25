use super::process::ArchProcess;
use crate::android::utils::application_context::get_application_context;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

static LAUNCH_RUNNING: AtomicBool = AtomicBool::new(false);

struct LaunchRunningGuard;

impl Drop for LaunchRunningGuard {
    fn drop(&mut self) {
        LAUNCH_RUNNING.store(false, Ordering::Release);
    }
}

pub fn launch() {
    if LAUNCH_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        log::info!("Skipping launch because the desktop session is already running");
        return;
    }

    thread::spawn(move || {
        let _guard = LaunchRunningGuard;

        // Clean up potential leftover files for display :1
        ArchProcess {
            command: "rm -f /tmp/.X1-lock".into(),
            user: None,
            env: vec![],
            log: None,
        }
        .run();
        ArchProcess {
            command: "rm -f /tmp/.X11-unix/X1".into(),
            user: None,
            env: vec![],
            log: None,
        }
        .run();

        let local_config = get_application_context().local_config;
        let username = local_config.user.username;
        let graphics_env = local_config.graphics.env_vars();

        ArchProcess {
            command: local_config.command.launch,
            user: Some(username),
            env: graphics_env,
            log: Some(Arc::new(|it| log::trace!("{}", it))),
        }
        .run();
    });
}
