use super::process::ArchProcess;
use super::setup::refresh_firefox_support;
use crate::android::{audio::pulseaudio, utils::application_context::get_application_context};
use std::sync::Arc;
use std::thread;

pub fn launch() {
    thread::spawn(move || {
        if let Err(err) = pulseaudio::ensure_started() {
            log::error!("Failed to start host PulseAudio: {:#}", err);
        }
        if let Err(err) = refresh_firefox_support() {
            log::error!("Failed to refresh Firefox support: {:#}", err);
        }

        // Clean up potential leftover files for display :1
        ArchProcess {
            command: "rm -f /tmp/.X1-lock".into(),
            user: None,
            log: None,
        }
        .run();
        ArchProcess {
            command: "rm -f /tmp/.X11-unix/X1".into(),
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
        .run();
    });
}
